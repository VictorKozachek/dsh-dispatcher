/**
 * Версионирование и миграции `state.json` (задача 032).
 *
 * Проверяем обещания карточки: `schemaVersion` на каждом чтении, миграция строго
 * вперёд по ступеням, бэкап до перезаписи, отказ на файл из будущего (без
 * перезаписи) и идемпотентность повторного прогона.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LEGACY_STATE_VERSION,
  STATE_MIGRATIONS,
  STATE_VERSION,
  StateSchemaError,
  createStore,
  defaultState,
  migrateState,
  migrateV1ToV2,
  schemaVersionOf,
  validateMigrationRegistry,
} from "../lib/store.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-schema-"));
  t.after(() => {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* уже права нормальные */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeStore(dir, options = {}) {
  return createStore({
    file: path.join(dir, "state.json"),
    now: () => 1_700_000_000_000,
    log: () => {},
    ...options,
  });
}

/** Файлы бэкапа в каталоге состояния. */
function backups(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith("state.json.bak-")).sort();
}

const LEGACY_STATE = {
  version: LEGACY_STATE_VERSION,
  bindings: { transport: "telegram", chatId: 42, botUsername: "test_bot" },
  enabled: { global: true, workspaces: { "/p": true }, sessions: {} },
  channels: {
    // Плоская форма исторического формата (015): превращается в `default`.
    "/home/vic/projects/alpha": { chatId: -100, threadId: 7 },
    // Вложенная форма уже канонична — должна пережить миграцию как есть.
    beta: { telegram: { chatId: 42 }, max: { chatId: 43, threadId: 1 } },
  },
  futureField: { keep: [1, 2, 3] },
  recent: [{ shortId: "a1b2c3d4" }],
};

test("реестр миграций строгий: ступени без дырок, лишних нет", () => {
  const registry = validateMigrationRegistry();
  assert.equal(registry.ok, true, registry.problems.join("; "));
  assert.deepEqual(Object.keys(STATE_MIGRATIONS), ["1"]);
  assert.equal(typeof STATE_MIGRATIONS[1], "function");
  assert.equal(STATE_VERSION, LEGACY_STATE_VERSION + 1, "одна ступень: v1 → v2");
});

test("schemaVersionOf: нет версии = 1, legacy version читается, мусор — null", () => {
  assert.equal(schemaVersionOf({}), LEGACY_STATE_VERSION);
  assert.equal(schemaVersionOf({ version: 1 }), 1);
  assert.equal(schemaVersionOf({ schemaVersion: 2 }), 2);
  assert.equal(schemaVersionOf({ schemaVersion: 2, version: 99 }), 2, "schemaVersion главнее legacy-поля");
  assert.equal(schemaVersionOf({ schemaVersion: "abc" }), null);
  assert.equal(schemaVersionOf({ schemaVersion: 0 }), null);
  assert.equal(schemaVersionOf({ schemaVersion: 1.5 }), null);
});

test("migrateState: v1 → текущая, версия ступени фиксируется", () => {
  const result = migrateState({ version: 1, channels: {} });

  assert.equal(result.error, null);
  assert.equal(result.from, 1);
  assert.equal(result.to, STATE_VERSION);
  assert.deepEqual(result.applied, [STATE_VERSION]);
  assert.equal(result.state.schemaVersion, STATE_VERSION);
  assert.equal("version" in result.state, false, "legacy-поле не сохраняется");
});

test("migrateV1ToV2: каналы канонизируются, данные не теряются, повтор безопасен", () => {
  const once = migrateV1ToV2(LEGACY_STATE);
  const twice = migrateV1ToV2(once);

  assert.deepEqual(once.channels["/home/vic/projects/alpha"], { default: { chatId: -100, threadId: 7 } });
  assert.deepEqual(once.channels.beta, { telegram: { chatId: 42 }, max: { chatId: 43, threadId: 1 } });
  assert.deepEqual(once.futureField, { keep: [1, 2, 3] }, "незнакомые поля сохраняются");
  assert.deepEqual(once.recent, [{ shortId: "a1b2c3d4" }]);
  assert.deepEqual(twice, once, "миграция идемпотентна");
});

test("нет файла: дефолт текущей версии и никаких бэкапов", (t) => {
  const dir = tempDir(t);
  const store = makeStore(dir);

  const state = store.read();

  assert.deepEqual(state, defaultState());
  assert.equal(state.schemaVersion, STATE_VERSION);
  assert.deepEqual(store.schemaStatus().ok, true);
  assert.deepEqual(backups(dir), []);
});

test("файл без версии = v1: миграция вперёд, бэкап содержит исходный файл", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  const legacy = { ...LEGACY_STATE };
  delete legacy.version;
  const original = `${JSON.stringify(legacy, null, 2)}\n`;
  fs.writeFileSync(file, original);

  const store = makeStore(dir);
  const state = store.read();

  assert.equal(state.schemaVersion, STATE_VERSION);
  // Ключ проекта — basename (015): путь в состоянии не хранится.
  assert.deepEqual(state.channels.alpha, { default: { chatId: -100, threadId: 7 } });
  assert.deepEqual(state.futureField, { keep: [1, 2, 3] });

  const [backup] = backups(dir);
  assert.ok(backup, "бэкап создан");
  assert.match(backup, /^state\.json\.bak-1-/);
  assert.equal(fs.readFileSync(path.join(dir, backup), "utf8"), original, "бэкап байт-в-байт равен исходнику");
  assert.equal(fs.statSync(path.join(dir, backup)).mode & 0o777, 0o600);

  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(written.schemaVersion, STATE_VERSION);
  assert.equal("version" in written, false);
  assert.equal(store.schemaStatus().backup, path.join(dir, backup));
});

test("файл v1 (version: 1) мигрирует один раз; повторный запуск ничего не меняет", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, `${JSON.stringify(LEGACY_STATE, null, 2)}\n`);

  const first = makeStore(dir);
  const state = first.read();
  const afterMigration = fs.readFileSync(file, "utf8");
  assert.equal(backups(dir).length, 1);

  const second = makeStore(dir);
  const again = second.read();

  assert.deepEqual(again, state, "состояние стабильно");
  assert.equal(fs.readFileSync(file, "utf8"), afterMigration, "файл не переписывается повторно");
  assert.equal(backups(dir).length, 1, "второго бэкапа нет");
});

test("файл из будущего: отказ, файл не перезаписан и запись запрещена", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  const future = { schemaVersion: 99, enabled: { global: true }, bindings: { transport: "telegram", chatId: 42 } };
  const original = `${JSON.stringify(future, null, 2)}\n`;
  fs.writeFileSync(file, original);
  const before = fs.statSync(file).mtimeMs;

  const store = makeStore(dir);
  const state = store.read();

  assert.equal(state.bindings, null, "читаем безопасный дефолт");
  assert.equal(state.enabled.global, false);
  const status = store.schemaStatus();
  assert.equal(status.ok, false);
  assert.equal(status.error.code, "future-version");
  assert.match(status.error.message, /новее плагина/);
  assert.match(status.error.instruction, /обновите плагин/);

  assert.equal(fs.readFileSync(file, "utf8"), original, "файл не тронут");
  assert.equal(fs.statSync(file).mtimeMs, before, "mtime не изменился");
  assert.deepEqual(backups(dir), [], "бэкап не создаётся: перезаписи не было");

  assert.throws(
    () => store.setEnabled({ kind: "global" }, true),
    (error) => {
      assert.ok(error instanceof StateSchemaError, "запись обязана отказать");
      assert.equal(error.code, "future-version");
      assert.match(error.message, /обновите плагин/);
      return true;
    },
  );
  assert.equal(fs.readFileSync(file, "utf8"), original, "и после отказа запись файл не тронут");
});

test("битая версия схемы: отказ без перезаписи", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  const original = '{ "schemaVersion": "abc", "enabled": { "global": true } }\n';
  fs.writeFileSync(file, original);

  const store = makeStore(dir);
  store.read();

  assert.equal(store.schemaStatus().error.code, "invalid-version");
  assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.deepEqual(backups(dir), []);
});

test("миграция не удалась: файл и запись остаются в покое", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  const original = `${JSON.stringify(LEGACY_STATE, null, 2)}\n`;
  fs.writeFileSync(file, original);

  // Сбой бэкапа детерминированно: подменяем copyFileSync, пока идёт проверка.
  const realCopy = fs.copyFileSync;
  fs.copyFileSync = () => {
    throw new Error("диск переполнен");
  };
  try {
    const store = makeStore(dir);
    const state = store.read();

    assert.equal(state.bindings, null, "при отказе — безопасный дефолт");
    assert.equal(store.schemaStatus().error.code, "migration-persist-failed");
    assert.match(store.schemaStatus().error.instruction, /исходный state\.json не тронут/);
    assert.equal(fs.readFileSync(file, "utf8"), original, "исходный файл не тронут");
    assert.deepEqual(backups(dir), [], "бэкап не создался — значит и перезаписи не было");
    // Любая запись снова читает файл, снова не может мигрировать — и отказывает.
    assert.throws(() => store.setEnabled({ kind: "global" }, true), StateSchemaError);
    assert.equal(fs.readFileSync(file, "utf8"), original, "после отказа файл тоже цел");
  } finally {
    fs.copyFileSync = realCopy;
  }
});

test("write приводит состояние к текущей схеме и не тащит legacy-поле", (t) => {
  const dir = tempDir(t);
  const store = makeStore(dir);

  store.write({ version: 1, enabled: { global: true } });

  const written = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(written.schemaVersion, STATE_VERSION);
  assert.equal("version" in written, false);
  assert.deepEqual(backups(dir), [], "миграции не было — бэкап не нужен");
});
