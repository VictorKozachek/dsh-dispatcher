/**
 * 079: загрузчик горячих модулей.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHotLoader } from "../lib/hot.js";

function tempModule(t, source = "export const value = 'one';\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-hot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "hot-mod.js");
  fs.writeFileSync(file, source);
  return { dir, file };
}

function fakeJournal() {
  const events = [];
  return { events, record: (event, fields = {}) => { events.push({ event, ...fields }); return true; } };
}

test("079: изменение файла перезагружает модуль без перезапуска", async (t) => {
  const { dir, file } = tempModule(t);
  const loader = createHotLoader({ libDir: dir, minCheckMs: 0 });
  assert.equal((await loader.load("hot-mod.js")).value, "one");
  fs.writeFileSync(file, "export const value = 'two';\n");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  assert.equal((await loader.load("hot-mod.js")).value, "two");
});

test("079: hotReload: false не перечитывает файл", async (t) => {
  const { dir, file } = tempModule(t);
  const loader = createHotLoader({ libDir: dir, enabled: false, minCheckMs: 0 });
  assert.equal((await loader.load("hot-mod.js")).value, "one");
  fs.writeFileSync(file, "export const value = 'two';\n");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  assert.equal((await loader.load("hot-mod.js")).value, "one");
});

test("079: битый модуль не роняет плагин — остаётся прошлая версия и hot.error", async (t) => {
  const { dir, file } = tempModule(t);
  const journal = fakeJournal();
  const loader = createHotLoader({ libDir: dir, minCheckMs: 0, journal });
  assert.equal((await loader.load("hot-mod.js")).value, "one");
  fs.writeFileSync(file, "export const value = ;\n");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  assert.equal((await loader.load("hot-mod.js")).value, "one");
  assert.equal(journal.events.some((entry) => entry.event === "hot.error"), true);
});

test("079: reload сбрасывает кэш, enabled=false остаётся выключенным", async (t) => {
  const { dir, file } = tempModule(t);
  const journal = fakeJournal();
  const loader = createHotLoader({ libDir: dir, minCheckMs: 60_000, journal });
  assert.equal((await loader.load("hot-mod.js")).value, "one");
  fs.writeFileSync(file, "export const value = 'two';\n");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  loader.reload("manual");
  assert.equal((await loader.load("hot-mod.js")).value, "two");
  assert.equal(journal.events.some((entry) => entry.event === "hot.reload"), true);
  loader.setEnabled(false);
  assert.equal(loader.enabled, false);
});
