/**
 * Ротация журналов и очистка хранилища (033).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_KEEP, DEFAULT_MAX_BYTES, rotateIfNeeded, vacuum } from "../lib/rotate.js";
import { createAudit, DEFAULT_KEEP_ROTATED, DEFAULT_MAX_BYTES as AUDIT_MAX_BYTES } from "../lib/audit.js";
import { createJournalLog } from "../lib/reliability.js";
import { LEGACY_STATE_VERSION, PENDING_LIMIT, RECENT_LIMIT, StateSchemaError, createStore } from "../lib/store.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-retention-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const entry = (index) => ({
  kind: "approval",
  questionId: `q-${index}`,
  toolName: "Bash",
  outcome: "allowed-once",
  decision: "remote",
  waitedMs: index,
});

test("дефолты 033: 5 МиБ и 5 файлов у audit и журнала", () => {
  assert.equal(DEFAULT_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(DEFAULT_KEEP, 5);
  assert.equal(AUDIT_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(DEFAULT_KEEP_ROTATED, 5);
});

test("ротация по размеру: keep соблюдается, последняя запись не теряется, права 600", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "audit.jsonl");
  const audit = createAudit({ file, maxBytes: 400, keepRotated: 2 });

  for (let index = 0; index < 40; index += 1) assert.equal(audit.append(entry(index)), true);

  assert.ok(fs.existsSync(file));
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.existsSync(`${file}.2`));
  assert.equal(fs.existsSync(`${file}.3`), false, "keep=2: третьего архива нет");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "текущий журнал 600");
  assert.equal(fs.statSync(`${file}.1`).mode & 0o777, 0o600, "ротированный журнал 600");

  const all = audit.entries();
  const ids = all.map((item) => item.questionId);
  assert.equal(new Set(ids).size, ids.length, "нет дублей записей");
  assert.equal(ids.at(-1), "q-39", "последняя запись на месте");
  assert.ok(all.length >= 3, "история читается из ротированных файлов");

  // Оборванная запись не ломает чтение: битую строку просто пропускаем.
  fs.appendFileSync(file, '{"kind":"approval"');
  assert.equal(audit.entries().some((item) => item.questionId === "q-39"), true);
});

test("журнал log.jsonl: ротация с keep и правами 600", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const journal = createJournalLog({ file, maxBytes: 200, keep: 2 });
  for (let index = 0; index < 30; index += 1) journal.append({ event: "delivered", shortId: `s-${index}`, attempt: 1 });

  assert.equal(fs.existsSync(`${file}.1`), true);
  assert.equal(fs.existsSync(`${file}.2`), true);
  assert.equal(fs.existsSync(`${file}.3`), false, "keep=2");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(`${file}.1`, "utf8"), /delivered/);
});

test("vacuum --dry-run ничего не удаляет, обычный — оставляет последние keep", (t) => {
  const dir = tempDir(t);
  for (let index = 1; index <= 7; index += 1) fs.writeFileSync(path.join(dir, `audit.jsonl.${index}`), "x".repeat(10));
  for (let index = 1; index <= 3; index += 1) fs.writeFileSync(path.join(dir, `log.jsonl.${index}`), "y".repeat(20));

  const dry = vacuum(fs, { dir, keep: 5, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.removed.length, 2, "audit: удалить самые старые .6/.7; log: все в пределах keep");
  assert.deepEqual(dry.removed.map((item) => path.basename(item.path)).sort(), ["audit.jsonl.6", "audit.jsonl.7"]);
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.1")), true, "dry-run не удалил");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.7")), true);

  const real = vacuum(fs, { dir, keep: 5, dryRun: false });
  assert.equal(real.removed.length, 2);
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.1")), true, "самое свежее .1 осталось");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.5")), true, "оставлены .1..5");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.6")), false, "старое .6 удалено");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.7")), false, "самое старое .7 удалено");
  assert.equal(real.freedBytes, 20);
  assert.equal(real.kept.length, 5 + 3);
});

test("rotateIfNeeded: keep=0 очищает текущий файл, нет файла — не ошибка", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "audit.jsonl");
  assert.deepEqual(rotateIfNeeded(fs, file, 10, { maxBytes: 100 }), { rotated: false, reason: "absent" });

  fs.writeFileSync(file, "x".repeat(200));
  const result = rotateIfNeeded(fs, file, 10, { maxBytes: 100, keep: 0 });
  assert.equal(result.rotated, true);
  assert.equal(fs.existsSync(file), false, "keep=0: старый файл удалён");
});

test("state.json: recent и pending ограничены (033)", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  const pending = Array.from({ length: PENDING_LIMIT + 50 }, (_, index) => ({ shortId: `s-${index}` }));
  const recent = Array.from({ length: RECENT_LIMIT + 30 }, (_, index) => ({ id: `r-${index}` }));
  fs.writeFileSync(file, JSON.stringify({ version: 1, recent, pending }));

  const store = createStore({ file });
  const state = store.read();
  assert.equal(state.pending.length, PENDING_LIMIT, "pending ограничен");
  assert.equal(state.pending.at(-1).shortId, `s-${PENDING_LIMIT + 49}`, "последние записи сохранены");
  assert.equal(state.recent.length, RECENT_LIMIT, "recent ограничен");
  assert.equal(store.pendingLimit, PENDING_LIMIT);
  assert.equal(store.recentLimit, RECENT_LIMIT);
});

test("reliability: вытеснение pending пишется в журнал", async (t) => {
  const dir = tempDir(t);
  const { createReliability } = await import("../lib/reliability.js");
  const { createStore } = await import("../lib/store.js");
  const store = createStore({ file: path.join(dir, "state.json") });
  const logFile = path.join(dir, "log.jsonl");
  const failing = {
    id: "telegram",
    async sendQuestion() {
      throw new Error("сеть недоступна");
    },
  };
  const reliability = createReliability({
    transport: failing,
    state: store,
    logFile,
    connectTimeoutMs: 1,
    backoffBaseMs: 1,
    sleep: async () => {},
    maxPending: 1,
    logger: () => {},
    log: () => {},
  });

  const result1 = await reliability.deliver({ question: { shortId: "s-1", questionId: "q-1" } });
  const result2 = await reliability.deliver({ question: { shortId: "s-2", questionId: "q-2" } });
  assert.equal(result1, "give-up");
  assert.equal(result2, "give-up");

  const pending = store.read().pending;
  assert.equal(pending.length, 1, "maxPending=1");
  assert.equal(pending[0].shortId, "s-2", "старейший вытеснен");
  const journal = fs.readFileSync(logFile, "utf8");
  assert.match(journal, /pending-dropped/);
  assert.match(journal, /"shortId":"s-1"/);
});

// --- ревью 033: дырка в нумерации, кастомный pendingLimit, команда vacuum ---

test("vacuum видит ротированные файлы с дыркой в нумерации", (t) => {
  const dir = tempDir(t);
  // .1 отсутствует (удалён вручную), есть .2 и .3
  fs.writeFileSync(path.join(dir, "audit.jsonl.2"), "a".repeat(10));
  fs.writeFileSync(path.join(dir, "audit.jsonl.3"), "b".repeat(20));

  const dry = vacuum(fs, { dir, keep: 1, dryRun: true });
  assert.deepEqual(dry.removed.map((item) => path.basename(item.path)), ["audit.jsonl.3"], "keep=1: .2 — свежая ротация, .3 — старая");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.2")), true, "dry-run ничего не удалил");

  const real = vacuum(fs, { dir, keep: 1, dryRun: false });
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.2")), true, "свежий .2 остался");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.3")), false, "старый .3 удалён");
  assert.equal(real.kept.length, 1);
});

test("createStore: кастомный pendingLimit применяется и при чтении, и при записи", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    pending: Array.from({ length: 10 }, (_, index) => ({ shortId: `s-${index}` })),
  }));

  const store = createStore({ file, pendingLimit: 3 });
  assert.equal(store.pendingLimit, 3);
  assert.equal(store.read().pending.length, 3, "read учитывает лимит");
  assert.deepEqual(store.read().pending.map((item) => item.shortId), ["s-7", "s-8", "s-9"]);

  store.update((state) => {
    state.pending.push({ shortId: "s-10" });
    return state;
  });
  assert.equal(store.read().pending.length, 3, "write учитывает лимит");
  assert.equal(store.read().pending.at(-1).shortId, "s-10", "новое не потерялось");
});

test("/remote vacuum: команда работает, --dry-run безопасен", async (t) => {
  const { createRemoteCommands } = await import("../lib/commands.js");
  const { createStore } = await import("../lib/store.js");
  const dir = tempDir(t);
  const store = createStore({ file: path.join(dir, "state.json") });
  for (let index = 1; index <= 7; index += 1) fs.writeFileSync(path.join(dir, `audit.jsonl.${index}`), "x".repeat(100));
  for (let index = 1; index <= 2; index += 1) fs.writeFileSync(path.join(dir, `log.jsonl.${index}`), "y".repeat(50));

  const ctx = { get: () => null, on: () => () => {}, effect: (execute) => {
    const disposable = execute();
    return () => disposable?.();
  } };
  const remote = createRemoteCommands({ ctx, store, log: () => {}, now: () => 1_700_000_000_000 });
  const invoke = (rawInput) => ({
    commandId: "c1",
    agent: { id: "s1", session: { id: "s1" } },
    rawInput,
    signal: new AbortController().signal,
  });

  const dry = await remote.handler(invoke("vacuum --dry-run"));
  assert.equal(dry.kind, "success", dry.text);
  assert.match(dry.text, /--dry-run: будет удалено 2 файлов/);
  assert.match(dry.text, /audit\.jsonl\.6/);
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.6")), true, "dry-run не удалил");

  const real = await remote.handler(invoke("vacuum"));
  assert.equal(real.kind, "success", real.text);
  assert.match(real.text, /удалено 2 файлов, освобождено/);
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.1")), true, "оставлены свежие .1..5");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.5")), true);
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.6")), false, "старое .6 удалено");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.7")), false, "старое .7 удалено");
  assert.equal(fs.existsSync(path.join(dir, "log.jsonl.1")), true, "log в пределах keep не тронут");
  assert.match(real.text, /оставлено ротированных файлов: 7/);

  const again = await remote.handler(invoke("vacuum"));
  assert.match(again.text, /очистка не требуется/);
});

// --- 033 × 032: лимиты вместе с миграцией схемы ------------------------------

test("миграция v1 → v2 применяет pendingLimit/recentLimit после бэкапа", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  const pending = Array.from({ length: 250 }, (_, index) => ({ shortId: `p-${index}` }));
  const recent = Array.from({ length: 60 }, (_, index) => ({ id: `r-${index}` }));
  fs.writeFileSync(file, JSON.stringify({ version: LEGACY_STATE_VERSION, pending, recent }));

  const store = createStore({ file, pendingLimit: 3, recentLimit: 5 });
  const state = store.read();
  assert.equal(state.schemaVersion, 2, "миграция выполнена");
  assert.equal(state.pending.length, 3, "pendingLimit соблюдён на мигрированном файле");
  assert.deepEqual(state.pending.map((item) => item.shortId), ["p-247", "p-248", "p-249"]);
  assert.equal(state.recent.length, 5, "recentLimit соблюдён");
  assert.equal(store.schemaStatus().ok, true);
  assert.ok(store.schemaStatus().backup, "бэкап до миграции есть");
  assert.equal(fs.readFileSync(file, "utf8").includes('"p-249"'), true, "на диск ушли лимитированные данные");

  // Идемпотентность: повторное чтение не плодит бэкапы и не ломает лимиты.
  const backup = store.schemaStatus().backup;
  const again = store.read();
  assert.equal(again.pending.length, 3);
  assert.equal(again.recent.length, 5);
  assert.equal(store.schemaStatus().backup, backup, "второй миграции нет");

  // Отказ схемы не обходится лимитами.
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, pending: [1, 2, 3] }));
  const future = createStore({ file, pendingLimit: 1 });
  const safe = future.read();
  assert.equal(future.schemaStatus().ok, false);
  assert.equal(safe.pending.length, 0, "будущий файл не читается как свой");
  assert.throws(() => future.update((value) => value), StateSchemaError);
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ schemaVersion: 99, pending: [1, 2, 3] }), "файл не перезаписан");
});

test("vacuum: keep=NaN/отрицательный безопасен, bases не-массив не ломает", (t) => {
  const dir = tempDir(t);
  for (let index = 1; index <= 7; index += 1) fs.writeFileSync(path.join(dir, `audit.jsonl.${index}`), "x");
  for (let index = 1; index <= 2; index += 1) fs.writeFileSync(path.join(dir, `log.jsonl.${index}`), "y");

  const nan = vacuum(fs, { dir, keep: Number.NaN, dryRun: true });
  assert.equal(nan.removed.length, 2, "NaN -> дефолт keep=5");

  const negative = vacuum(fs, { dir, keep: -3, dryRun: true });
  assert.equal(negative.removed.length, 2, "отрицательный -> дефолт keep=5");

  const badBases = vacuum(fs, { dir, bases: "audit.jsonl", keep: 5, dryRun: true });
  assert.equal(badBases.removed.length, 2, "не-массив bases -> дефолтные оба журнала");
  assert.equal(badBases.kept.length, 7, "log в пределах keep");

  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.1")), true, "dry-run ничего не тронул");
});

test("vacuum после нескольких ротаций: keep=2 оставляет genN и genN-1", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "audit.jsonl");
  const audit = createAudit({ file, maxBytes: 300, keepRotated: 4 });
  for (let index = 0; index < 60; index += 1) audit.append(entry(index));

  assert.ok(fs.existsSync(`${file}.3`), "ротаций больше двух");
  const dry = vacuum(fs, { dir, keep: 2, dryRun: true });
  const keptBefore = dry.kept.filter((item) => path.basename(item.path).startsWith("audit.jsonl.")).map((item) => path.basename(item.path));
  const removedBefore = dry.removed.map((item) => path.basename(item.path));
  assert.deepEqual(keptBefore.sort(), ["audit.jsonl.1", "audit.jsonl.2"], "genN и genN-1 — это .1 и .2");
  assert.deepEqual(removedBefore.sort(), ["audit.jsonl.3", "audit.jsonl.4"].filter((name) => fs.existsSync(path.join(dir, name))));
  assert.equal(fs.existsSync(`${file}.1`), true, "dry-run не удалил");

  vacuum(fs, { dir, keep: 2 });
  assert.equal(fs.existsSync(`${file}.1`), true);
  assert.equal(fs.existsSync(`${file}.2`), true);
  assert.equal(fs.existsSync(`${file}.3`), false);

  const empty = vacuum(fs, { dir: path.join(dir, "missing"), keep: 2 });
  assert.deepEqual(empty.removed, [], "нет каталога — не падает");
});
