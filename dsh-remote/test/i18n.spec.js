/**
 * Локализация RU/EN (046): словари, подстановка, `/remote lang` и сообщения.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_LANG,
  LANGS,
  dictionaries,
  formatTemplate,
  normalizeLang,
  resolveLanguage,
  t,
  translator,
} from "../lib/i18n.js";
import { renderBody, renderRows } from "../lib/present.js";
import { createStore } from "../lib/store.js";
import { createRemoteCommands } from "../lib/commands.js";
import { createAnswerer } from "../lib/answerer.js";
import { createRegistry } from "../lib/domain/registry.js";

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-i18n-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createStore({ file: path.join(dir, "state.json") });
}

function harness(t, { store = tempStore(t) } = {}) {
  const ctx = { get: () => null, on: () => () => {}, effect: (fn) => { const d = fn(); return () => d?.(); } };
  const remote = createRemoteCommands({ ctx, store, log: () => {}, now: () => 1_700_000_000_000 });
  const invoke = (rawInput) => ({
    commandId: "c1",
    agent: { id: "s1", session: { id: "s1" } },
    rawInput,
    signal: new AbortController().signal,
  });
  return { store, remote, invoke };
}

test("046: словари ru/en покрывают одни и те же ключи", () => {
  const ru = Object.keys(dictionaries.ru).sort();
  const en = Object.keys(dictionaries.en).sort();
  assert.deepEqual(en, ru, "нет ключа только в одном языке");
  assert.ok(ru.length >= 30, `ключей слишком мало: ${ru.length}`);
  for (const key of ru) {
    assert.equal(typeof dictionaries.ru[key], "string", `ru.${key}`);
    assert.notEqual(dictionaries.ru[key], "", `ru.${key} пустой`);
    assert.equal(typeof dictionaries.en[key], "string", `en.${key}`);
    assert.notEqual(dictionaries.en[key], "", `en.${key} пустой`);
  }
});

test("046: normalizeLang понимает регистр/локаль, незнакомое — null", () => {
  assert.equal(normalizeLang("RU"), "ru");
  assert.equal(normalizeLang("en-US"), "en");
  assert.equal(normalizeLang("ru_RU.UTF-8"), "ru");
  assert.equal(normalizeLang("de"), null);
  assert.equal(normalizeLang(null), null);
  assert.deepEqual([...LANGS], ["ru", "en"]);
});

test("046: resolveLanguage: явная настройка → DSH_LANG → ru", () => {
  assert.equal(resolveLanguage({ explicit: "en", env: { DSH_LANG: "ru" } }), "en");
  assert.equal(resolveLanguage({ explicit: null, env: { DSH_LANG: "en" } }), "en");
  assert.equal(resolveLanguage({ explicit: null, env: { DSH_REMOTE_LANG: "en" } }), "en");
  assert.equal(resolveLanguage({ explicit: null, env: {} }), "ru");
  // Общесистемная LANG не должна переключать язык сама по себе.
  assert.equal(resolveLanguage({ explicit: null, env: { LANG: "en_US.UTF-8" } }), "ru");
  assert.equal(DEFAULT_LANG, "ru");
});

test("046: подстановка параметров и неизвестный ключ не ломают вывод", () => {
  assert.equal(formatTemplate("вопрос {index}/{total}", { index: 2, total: 3 }), "вопрос 2/3");
  assert.equal(formatTemplate("привет {name}", {}), "привет {name}", "неизвестный параметр остаётся");
  assert.equal(formatTemplate("x {n}", { n: null }), "x ");
  assert.equal(t("no.such.key"), "no.such.key", "неизвестный ключ возвращается как есть");
  assert.equal(t("commands.lang.set", { lang: "en" }, "en"), "language switched: en");
  assert.equal(t("commands.lang.set", { lang: "ru" }, "de"), "язык переключён: ru", "неизвестный язык → ru");
  assert.equal(translator("en")("commands.helpTitle"), "/remote commands:");
});

test("046: present рендерит сообщения на выбранном языке", () => {
  const ruRows = renderRows({ options: [], allowFreeText: true, lang: "ru" }, {});
  const enRows = renderRows({ options: [], allowFreeText: true, lang: "en" }, {});
  assert.deepEqual(ruRows.map((row) => row[0].label), ["Да", "Нет", "Отложить", "Решай сам"]);
  assert.deepEqual(enRows.map((row) => row[0].label), ["Yes", "No", "Later", "You decide"]);

  const enBody = renderBody({ body: "Continue?", options: [], lang: "en", index: 2, total: 2 }, {});
  assert.match(enBody, /question 2\/2/);
  assert.match(enBody, /Or reply with text/);
  assert.doesNotMatch(enBody, /вопрос|Ответьте/);

  const ruRowsWithOptions = renderRows({ options: [{ id: "o1", label: "Да" }], lang: "ru" }, {});
  assert.equal(ruRowsWithOptions.at(-1)[0].label, "Другой ответ…");
  const enRowsWithOptions = renderRows({ options: [{ id: "o1", label: "Да" }], lang: "en" }, {});
  assert.equal(enRowsWithOptions.at(-1)[0].label, "Other answer…");
});

test("046: /remote lang переключает язык и сохраняет его в состоянии", async (t) => {
  const { store, remote, invoke } = harness(t);

  const initial = await remote.handler(invoke("lang"));
  assert.match(initial.text, /язык: ru/);

  const switched = await remote.handler(invoke("lang en"));
  assert.equal(switched.kind, "success", switched.text);
  assert.match(switched.text, /language switched: en/);
  assert.equal(store.read().lang, "en", "язык сохранён в state.json");

  const current = await remote.handler(invoke("lang"));
  assert.match(current.text, /language: en/);

  const help = await remote.handler(invoke("help"));
  assert.match(help.text, /\/remote commands:/);
  assert.doesNotMatch(help.text, /Команды/);

  const status = await remote.handler(invoke("status"));
  assert.match(status.text, /language: en/);
});

test("046: неизвестный язык — ошибка на текущем языке, состояние не меняется", async (t) => {
  const { store, remote, invoke } = harness(t);
  await remote.handler(invoke("lang en"));

  const result = await remote.handler(invoke("lang de"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /unknown language: de/);
  assert.equal(store.read().lang, "en", "неизвестный язык не сохранился");
});

test("046: новый вопрос создаётся на языке из состояния", async (t) => {
  const store = tempStore(t);
  store.setLang("en");
  const sent = [];
  const handlers = new Set();
  const transport = {
    id: "telegram",
    async sendQuestion(question) { sent.push(question); return { messageId: "m" }; },
    async closeQuestion() {},
    onAnswer(handler) { handlers.add(handler); return () => handlers.delete(handler); },
  };
  const answerer = createAnswerer({
    transport,
    registry: createRegistry({ readState: () => ({ global: true }) }),
    lang: () => store.read().lang,
  });
  answerer.attach({ on: () => () => {}, get: () => null, effect: (fn) => { const d = fn(); return () => d?.(); } });

  const pending = answerer.handler({ questions: [{ id: "q1", question: "Continue?", options: [] }], agent: { id: "s" } }, () => assert.fail("next()"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent[0].lang, "en");
  assert.deepEqual(sent[0].quickReplies.map((entry) => entry.label), ["Yes", "No", "Later", "You decide"]);

  // Завершаем вопрос быстрой кнопкой, чтобы не держать открытое ожидание.
  for (const handler of handlers) handler({ shortId: sent[0].shortId, optionId: "q1" });
  const result = await pending;
  assert.equal(result.answers[0].custom, "Yes");
});

test("046: статическая проверка — в present/quick-replies нет русских литералов", async () => {
  const fs = await import("node:fs");
  const url = await import("node:url");
  const dir = url.fileURLToPath(new URL("../lib/", import.meta.url));
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const literal = /("([^"\\]|\\.)*"|`([^`\\]|\\.)*`)/g;

  for (const file of ["present.js", "quick-replies.js"]) {
    const source = stripComments(fs.readFileSync(`${dir}${file}`, "utf8"));
    const offenders = [];
    for (const match of source.matchAll(literal)) {
      if (/[А-Яа-яЁё]/.test(match[0])) offenders.push(match[0].slice(0, 60));
    }
    assert.deepEqual(offenders, [], `${file}: пользовательские строки — только через i18n.js`);
  }
});

test("049: в commands.js нет русских литералов вне словаря", async () => {
  const fs = await import("node:fs");
  const url = await import("node:url");
  const file = url.fileURLToPath(new URL("../lib/commands.js", import.meta.url));
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const source = stripComments(fs.readFileSync(file, "utf8"));
  const literal = /("([^"\\]|\\.)*"|`([^`\\]|\\.)*`)/g;
  const offenders = [];
  for (const match of source.matchAll(literal)) {
    if (/[А-Яа-яЁё]/.test(match[0])) offenders.push(match[0].slice(0, 60));
  }
  assert.deepEqual(offenders, [], "пользовательские строки должны жить в i18n-commands.js");
  assert.equal(/[А-Яа-яЁё]/.test(source), false, "в коде commands.js не осталось кириллицы");
});

test("049: вывод команд на EN без кириллицы, ключей и undefined", async (t) => {
  const { store, remote, invoke } = harness(t);
  await remote.handler(invoke("lang en"));
  store.setLang("en");

  const outputs = new Map();
  for (const command of ["status", "help", "audit", "channel list", "vacuum --dry-run", "stats", "who"]) {
    const result = await remote.handler(invoke(command));
    outputs.set(command, result.text);
    assert.doesNotMatch(result.text, /[А-Яа-яЁё]/, `${command}: кириллица в EN`);
    assert.doesNotMatch(result.text, /commands\.[a-z]+\.\d+/, `${command}: ключ просочился`);
    assert.doesNotMatch(result.text, /undefined/, `${command}: undefined в выводе`);
    assert.doesNotMatch(result.text, /\$\{/, `${command}: сырой шаблон в выводе`);
  }
  assert.match(outputs.get("status"), /language: en/);
  assert.match(outputs.get("audit"), /approval journal is empty|Last/);
  assert.match(outputs.get("vacuum --dry-run"), /nothing to delete|cleanup not needed|no old journals/);
});

test("049: help и doctor на EN не содержат русских фрагментов", async (t) => {
  const { store, remote, invoke } = harness(t);
  await remote.handler(invoke("lang en"));
  store.setLang("en");

  const help = await remote.handler(invoke("help"));
  assert.doesNotMatch(help.text, /[А-Яа-яЁё]/);

  const doctor = await remote.handler(invoke("doctor"));
  assert.doesNotMatch(doctor.text, /[А-Яа-яЁё]/, doctor.text);
  assert.doesNotMatch(doctor.text, /undefined/);
});
