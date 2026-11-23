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

test("079: реальный present.js перечитывается и меняет payload после правки", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-hot-present-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.resolve("dsh-remote/lib"), path.join(dir, "lib"), { recursive: true });
  const lib = path.join(dir, "lib");
  const loader = createHotLoader({ libDir: lib, minCheckMs: 0 });
  const question = { workspace: "/p/project", body: "Продолжать?", options: [{ id: "o1", label: "Да" }], createdAt: 1000 };

  const first = await loader.load("present.js");
  const before = first.renderBody(question, { maxText: 4096 });
  assert.match(before, /▸ project · \d{2}:\d{2}/);

  const file = path.join(lib, "present.js");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("const header = `▸ ", "const header = `▶ "));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  const second = await loader.load("present.js");
  const after = second.renderBody(question, { maxText: 4096 });
  assert.match(after, /▶ project · \d{2}:\d{2}/);
  assert.notEqual(after, before);
});

test("079: правка словаря i18n видна после hot-load i18n (payload present)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-hot-i18n-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    import("../lib/i18n.js").then((module) => {
      globalThis.__dshRemoteI18n = { t: module.t, translator: module.translator, resolveLanguage: module.resolveLanguage, formatTemplate: module.formatTemplate };
    }).catch(() => {});
  });
  fs.cpSync(path.resolve("dsh-remote/lib"), path.join(dir, "lib"), { recursive: true });
  const lib = path.join(dir, "lib");
  const loader = createHotLoader({ libDir: lib, minCheckMs: 0 });
  const present = await loader.load("present.js");
  const question = { workspace: "/p", body: "x", options: [{ id: "o1", label: "Да" }], allowFreeText: true, lang: "ru", createdAt: 1000 };
  assert.ok(present.renderRows(question, { maxOptions: 5, maxText: 4096 }).flat().some((row) => row.label === "Другой ответ…"));

  const file = path.join(lib, "i18n.js");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"present.freeTextLabel": "Другой ответ…"', '"present.freeTextLabel": "СВОЙ ОТВЕТ"'));
  fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  await loader.load("i18n.js");
  const rows = present.renderRows(question, { maxOptions: 5, maxText: 4096 }).flat();
  assert.ok(rows.some((row) => row.label === "СВОЙ ОТВЕТ"), "новый словарь виден через global bridge");
});
