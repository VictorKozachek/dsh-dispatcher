/**
 * Тесты состояния плагина: атомарная запись, права, битый JSON, lock.
 *
 * Файлы — во временном каталоге, глобальный `~/.dsh/remote-control` тесты не
 * трогают. Параллельную запись проверяем двумя настоящими процессами: именно она
 * ловит «половину файла» при наивной записи.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  STATE_VERSION,
  createCredentialAccess,
  createStore,
  credentialRef,
  defaultState,
  statePaths,
} from "../lib/store.js";

const run = promisify(execFile);
const STORE_URL = new URL("../lib/store.js", import.meta.url).href;

/** Временный каталог под состояние; после теста его убираем. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeStore(dir, options = {}) {
  const logs = [];
  const store = createStore({
    file: path.join(dir, "state.json"),
    now: () => 1_000,
    log: (message) => logs.push(message),
    ...options,
  });
  return { store, logs };
}

test("путь состояния: домашний каталог по умолчанию, DSH_REMOTE_STATE главнее", () => {
  const paths = statePaths({ env: {}, home: "/home/user" });
  assert.equal(paths.file, "/home/user/.dsh/remote-control/state.json");
  assert.equal(paths.lock, "/home/user/.dsh/remote-control/lock");

  const custom = statePaths({ env: { DSH_REMOTE_STATE: "/tmp/x/state.json" }, home: "/home/user" });
  assert.equal(custom.file, "/tmp/x/state.json");
  assert.equal(custom.dir, "/tmp/x");
});

test("нет файла — состояние по умолчанию", (t) => {
  const dir = tempDir(t);
  const { store, logs } = makeStore(dir);

  const state = store.read();

  assert.deepEqual(state, defaultState());
  assert.equal(state.version, STATE_VERSION);
  assert.equal(state.bindings, null);
  assert.deepEqual(state.enabled, { global: false, workspaces: {}, sessions: {} });
  assert.deepEqual(state.recent, []);
  assert.deepEqual(state.pending, []);
  assert.deepEqual(logs, [], "отсутствие файла — не ошибка");
});

test("запись атомарна: файл 600, временных файлов не остаётся", (t) => {
  const dir = tempDir(t);
  const { store } = makeStore(dir);

  store.setEnabled({ kind: "global" }, true);

  const file = path.join(dir, "state.json");
  assert.ok(fs.existsSync(file));
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `права ${mode.toString(8)} вместо 600`);
  assert.deepEqual(fs.readdirSync(dir), ["state.json"], "tmp-файлы убраны");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).enabled.global, true);
});

test("битый JSON: лог и дефолт, файл не перезаписывается", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "{ это не json");
  const { store, logs } = makeStore(dir);

  const state = store.read();

  assert.deepEqual(state, defaultState());
  assert.match(logs.join("\n"), /битый JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ это не json", "файл остался для разбора");
});

test("setEnabled: глобально, воркспейс и сессия; приоритет оставляем реестру 002", (t) => {
  const dir = tempDir(t);
  const { store } = makeStore(dir);

  store.setEnabled({ kind: "global" }, true);
  store.setEnabled({ kind: "workspace", id: "/p" }, true);
  store.setEnabled({ kind: "session", id: "s1" }, true);
  store.setEnabled({ kind: "workspace", id: "/q" }, false);

  const state = store.read();
  assert.equal(state.enabled.global, true);
  assert.deepEqual(state.enabled.workspaces, { "/p": true, "/q": false });
  assert.deepEqual(state.enabled.sessions, { s1: true });

  assert.throws(() => store.setEnabled({ kind: "galaxy" }, true), TypeError);
});

test("привязка: сохраняется без токена и снимается", (t) => {
  const dir = tempDir(t);
  const { store } = makeStore(dir);

  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const saved = store.read().bindings;
  assert.equal(saved.transport, "telegram");
  assert.equal(saved.chatId, 42);
  assert.equal(saved.userId, 7);
  assert.equal(saved.botUsername, "test_bot");
  assert.equal(saved.createdAt, 1_000);
  assert.equal(JSON.stringify(saved).includes("token"), false, "поля токена в состоянии нет");

  assert.throws(() => store.setBinding({ transport: "telegram" }), TypeError);

  store.setBinding(null);
  assert.equal(store.read().bindings, null);
});

test("recent — кольцевой буфер, pending заменяется целиком", (t) => {
  const dir = tempDir(t);
  const { store } = makeStore(dir, { recentLimit: 3 });

  for (const id of ["a", "b", "c", "d"]) store.addRecent({ shortId: id });
  assert.deepEqual(store.read().recent.map((entry) => entry.shortId), ["b", "c", "d"]);

  store.setPending([{ shortId: "x" }]);
  assert.deepEqual(store.read().pending, [{ shortId: "x" }]);
  store.setPending(undefined);
  assert.deepEqual(store.read().pending, []);
});

test("мусор в состоянии не ломает чтение и не теряет чужие поля", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 99,
    bindings: "строка вместо объекта",
    enabled: { global: "yes", workspaces: { "/p": true, "/q": "нет" }, sessions: [] },
    recent: "не массив",
    pending: null,
    future: { keep: true },
  }));

  const state = makeStore(dir).store.read();

  assert.equal(state.version, STATE_VERSION);
  assert.equal(state.bindings, null);
  assert.deepEqual(state.enabled, { global: false, workspaces: { "/p": true }, sessions: {} });
  assert.deepEqual(state.recent, []);
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.future, { keep: true }, "незнакомые поля сохраняются");
});

test("lock: второй процесс не занимает, освобождение и устаревший lock", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  const first = createStore({ file, now: () => 1_000 });
  const second = createStore({ file, now: () => 1_000 });

  assert.equal(first.acquireLock().ok, true);
  const busy = second.acquireLock();
  assert.equal(busy.ok, false);
  assert.equal(busy.holder.pid, process.pid, "в holder — pid первого процесса");
  assert.equal((fs.statSync(path.join(dir, "lock")).mode & 0o777), 0o600);

  assert.equal(first.releaseLock(), true);
  assert.equal(second.acquireLock().ok, true);
  second.releaseLock();

  // Устаревший lock: pid, которого нет, и старое время.
  fs.writeFileSync(path.join(dir, "lock"), JSON.stringify({ pid: 999_999, at: 0 }));
  const third = createStore({ file, now: () => 10 * 60 * 1000 });
  assert.equal(third.acquireLock({ staleAfterMs: 1_000 }).ok, true, "устаревший lock снимается");
  third.releaseLock();
});

test("параллельная запись двумя процессами не рвёт файл", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  const script = (flag) => `
import { createStore } from ${JSON.stringify(STORE_URL)};
const store = createStore({ file: ${JSON.stringify(file)} });
for (let i = 0; i < 40; i += 1) store.setEnabled({ kind: "global" }, ${flag});
`;

  await Promise.all([
    run(process.execPath, ["--input-type=module", "-e", script("true")]),
    run(process.execPath, ["--input-type=module", "-e", script("false")]),
  ]);

  const raw = fs.readFileSync(file, "utf8");
  const state = JSON.parse(raw);
  assert.equal(state.version, STATE_VERSION, "JSON целый");
  assert.equal(typeof state.enabled.global, "boolean");
  assert.deepEqual(fs.readdirSync(dir), ["state.json"], "временных файлов не осталось");
});

test("credentialRef пропускает только POSIX-имена", () => {
  assert.equal(credentialRef("DSH_REMOTE_TELEGRAM_TOKEN"), "DSH_REMOTE_TELEGRAM_TOKEN");
  assert.throws(() => credentialRef(""), TypeError);
  assert.throws(() => credentialRef("с пробелом"), TypeError);
  assert.throws(() => credentialRef("1НАЧИНАЕТСЯ_С_ЦИФРЫ"), TypeError);
});

test("credentials: настоящий API (async resolve/describe/set/unset) и терпимость к отказу", async () => {
  const ref = credentialRef("DSH_REMOTE_TELEGRAM_TOKEN");
  // Форма CredentialProvider из packages/credentials/credentials: всё async,
  // resolve -> {value, source}, describe -> {configured, source?, writable}.
  const service = {
    store: new Map([["DSH_REMOTE_ENV_TOKEN", "ENV-SECRET"]]),
    async resolve(name) {
      const value = this.store.get(name);
      return value === undefined ? undefined : { value, source: "file" };
    },
    async describe(name) {
      return this.store.has(name)
        ? { configured: true, source: "file", writable: true }
        : { configured: false, writable: false };
    },
    async set(name, value) {
      this.store.set(name, value);
    },
    async unset(name) {
      this.store.delete(name);
    },
  };
  const ctx = { get: (name) => (name === "credentials" ? service : null) };
  const access = createCredentialAccess(ctx);

  assert.equal(access.available, true);
  assert.equal(await access.resolve(ref), null);
  assert.deepEqual(await access.describe(ref), { source: null, writable: false, present: false });

  assert.equal(await access.set(ref, "SECRET"), true);
  assert.equal(await access.resolve(ref), "SECRET");
  assert.deepEqual(await access.describe(ref), { source: "file", writable: true, present: true });

  await access.unset(ref);
  assert.equal(await access.resolve(ref), null);

  // Строка вместо объекта тоже принимается (старые/простые провайдеры).
  const simple = createCredentialAccess({ get: () => ({ resolve: async () => "PLAIN" }) });
  assert.equal(await simple.resolve(ref), "PLAIN");

  // Сломанный сервис не бросает наружу.
  const broken = createCredentialAccess({ get: () => ({ resolve: async () => { throw new Error("boom"); } }) });
  assert.equal(await broken.resolve(ref), null);
  const missing = createCredentialAccess({ get: () => null });
  assert.equal(missing.available, false);
  assert.equal(await missing.resolve(ref), null);
});
