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
import { createStore, PENDING_LIMIT, RECENT_LIMIT } from "../lib/store.js";

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
  assert.equal(dry.removed.length, 2 + 0, "audit: удалить .1/.2; log: все 3 в пределах keep");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.1")), true, "dry-run не удалил");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.7")), true);

  const real = vacuum(fs, { dir, keep: 5, dryRun: false });
  assert.equal(real.removed.length, 2);
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.1")), false);
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.2")), false);
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.3")), true, "свежие 5 остались");
  assert.equal(fs.existsSync(path.join(dir, "audit.jsonl.7")), true);
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
