/**
 * Панель: история вопросов из журнала (задача 070).
 *
 * Журнал читается как есть (JSONL + `.1`), события склеиваются по shortId;
 * проверяем статусы, битые строки, ротацию, фильтры и отсутствие секретов.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { panelSnapshot } from "../lib/panel.js";
import { buildQuestionHistory, readJournalEntries, readQuestionHistory } from "../lib/journal-read.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, "..");

const NOW = Date.UTC(2026, 10, 11, 18, 0, 0);
const HOUR = 60 * 60 * 1000;
const SHORT = "a1b2c3d4";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-panel-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function line(event, fields = {}) {
  return JSON.stringify({ ts: new Date(NOW).toISOString(), level: "info", event, ...fields });
}

function writeLog(file, lines, { rotate = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (rotate) fs.writeFileSync(`${file}.1`, lines.join("\n") + "\n");
  else fs.writeFileSync(file, lines.join("\n") + "\n");
}

function snapshot(t, { lines = [], rotate = false, historyWorkspace = null } = {}) {
  const dir = tempDir(t);
  const logFile = path.join(dir, "log.jsonl");
  if (lines.length > 0) writeLog(logFile, lines, { rotate });
  return panelSnapshot({
    stateFile: path.join(dir, "state.json"),
    logFile,
    now: () => NOW,
    historyWorkspace,
    workspaces: [],
  });
}

test("070: пустой журнал — история пуста, без падения", (t) => {
  const snap = snapshot(t);
  assert.deepEqual(snap.history.rows, []);
  assert.equal(snap.history.total, 0);
  assert.equal(snap.history.unreadable, false);
});

test("070: битые строки пропускаются и считаются", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  fs.writeFileSync(file, [
    line("question.send", { shortId: SHORT, transport: "max" }),
    "not-json",
    "[]",
    line("question.sent", { shortId: SHORT, transport: "max", detail: { messageId: "mid.1" } }),
  ].join("\n") + "\n");

  const read = readJournalEntries(file, { now: NOW });
  assert.equal(read.skipped, 2);
  assert.equal(read.entries.length, 2);
  const snap = panelSnapshot({ stateFile: path.join(dir, "state.json"), logFile: file, now: () => NOW });
  assert.equal(snap.history.skipped, 2);
  assert.equal(snap.history.rows[0].status, "delivered");
});

test("070: send→sent→received — статус «отвечен» и детали", (t) => {
  const snap = snapshot(t, {
    lines: [
      line("question.send", { shortId: SHORT, transport: "max", detail: { chatId: 42, options: 2 } }),
      line("question.sent", { shortId: SHORT, transport: "max", detail: { messageId: "mid.1", keyboard: true } }),
      line("answer.received", { shortId: SHORT, transport: "max", detail: { optionIds: ["o1"], customLength: 7 } }),
    ],
  });
  const row = snap.history.rows[0];
  assert.equal(row.status, "answered");
  assert.equal(row.statusText, "отвечен");
  assert.equal(row.messageId, "mid.1");
  assert.deepEqual(row.optionIds, ["o1"]);
  assert.equal(row.customLength, 7);
  assert.equal(row.transport, "max");
});

test("070: send→error — «ошибка доставки» с кодом", (t) => {
  const snap = snapshot(t, {
    lines: [
      line("question.send", { shortId: SHORT, transport: "max" }),
      line("question.error", { shortId: SHORT, transport: "max", detail: { status: 400, code: "proto.payload", message: "too long" } }),
    ],
  });
  const row = snap.history.rows[0];
  assert.equal(row.status, "error");
  assert.equal(row.code, "proto.payload");
  assert.match(row.statusText, /ошибка доставки \(proto\.payload\)/);
});

test("070: received→unmatched — причина несовпадения", (t) => {
  const snap = snapshot(t, {
    lines: [
      line("question.send", { shortId: SHORT, transport: "max" }),
      line("answer.received", { shortId: SHORT, transport: "max", detail: { optionIds: ["o9"] } }),
      line("answer.unmatched", { shortId: SHORT, transport: "max", detail: { reason: "optionId", optionIds: ["o9"] } }),
    ],
  });
  const row = snap.history.rows[0];
  assert.equal(row.status, "unmatched");
  assert.equal(row.reason, "optionId");
  assert.match(row.statusText, /не сопоставлен \(optionId\)/);
});

test("070: answer.dropped — «снят» с причиной", (t) => {
  const snap = snapshot(t, {
    lines: [
      line("question.send", { shortId: SHORT, transport: "max" }),
      line("answer.dropped", { shortId: SHORT, transport: "max", detail: { reason: "ttl" } }),
    ],
  });
  assert.equal(snap.history.rows[0].status, "cancelled");
  assert.match(snap.history.rows[0].statusText, /снят \(ttl\)/);
});

test("070: ротация читается — старый .1 и новый файл склеиваются", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  fs.writeFileSync(`${file}.1`, line("question.send", { shortId: SHORT, transport: "telegram" }) + "\n");
  fs.writeFileSync(file, line("question.sent", { shortId: SHORT, transport: "telegram", detail: { messageId: "old-1" } }) + "\n");
  const read = readJournalEntries(file, { now: NOW });
  assert.equal(read.entries.length, 2);
  assert.equal(read.entries[0].event, "question.send");
  assert.equal(read.entries[1].event, "question.sent");
  assert.equal(read.files.includes(`${file}.1`), true);
});

test("070: фильтр по времени — старые события не попадают", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const old = JSON.stringify({ ts: new Date(NOW - 30 * HOUR).toISOString(), event: "question.send", shortId: "deadbeef" });
  fs.writeFileSync(file, old + "\n" + line("question.sent", { shortId: SHORT }));
  const snap = panelSnapshot({ stateFile: path.join(dir, "state.json"), logFile: file, now: () => NOW });
  assert.deepEqual(snap.history.rows.map((row) => row.shortId), [SHORT]);
});

test("070: фильтр по проекту", (t) => {
  const snap = snapshot(t, {
    lines: [
      line("question.send", { shortId: "aaa11111", transport: "max", detail: { workspace: "/p/one", chatId: 1 } }),
      line("question.send", { shortId: "bbb22222", transport: "max", detail: { workspace: "/p/two", chatId: 2 } }),
    ],
    historyWorkspace: "/p/one",
  });
  assert.deepEqual(snap.history.rows.map((row) => row.shortId), ["aaa11111"]);
});

test("070: в историю не попадают токены и текст ответа", (t) => {
  const snap = snapshot(t, {
    lines: [
      line("question.send", { shortId: SHORT, transport: "max" }),
      line("question.error", {
        shortId: SHORT,
        transport: "max",
        detail: { status: 401, code: "unauthorized", message: "Authorization: Bearer super-secret-token" },
      }),
      line("answer.received", {
        shortId: SHORT,
        transport: "max",
        detail: { optionIds: ["o1"], customLength: 12, text: "секретный текст", token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
      }),
    ],
  });
  const rendered = JSON.stringify(snap.history);
  assert.equal(rendered.includes("super-secret-token"), false);
  assert.equal(rendered.includes("секретный текст"), false);
  assert.equal(rendered.includes("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
  assert.equal(rendered.includes("too long"), false);
  assert.match(rendered, /customLength/);
});

test("070: buildQuestionHistory лимит и порядок свежих сверху", () => {
  const entries = [
    { ts: NOW - 2 * HOUR, event: "question.send", shortId: "aaa11111", transport: "max", project: null, detail: undefined },
    { ts: NOW - HOUR, event: "question.send", shortId: "bbb22222", transport: "max", project: null, detail: undefined },
  ];
  const history = buildQuestionHistory(entries, { limit: 1 });
  assert.equal(history.rows.length, 1);
  assert.equal(history.rows[0].shortId, "bbb22222", "свежий сверху");
  assert.equal(readQuestionHistory("/no/such/log.jsonl", { now: NOW }).unreadable, false);
});

test("070: нет файла журнала — «пока нет событий», а не падение", (t) => {
  const dir = tempDir(t);
  const missing = path.join(dir, "nope", "log.jsonl");
  const snap = panelSnapshot({ stateFile: path.join(dir, "state.json"), logFile: missing, now: () => NOW });
  assert.deepEqual(snap.history.rows, []);
  assert.equal(snap.history.total, 0);
  assert.equal(snap.history.unreadable, false, "отсутствие файла — не ошибка чтения");
  // Путь не задан вовсе — тот же результат, без исключения.
  assert.deepEqual(readQuestionHistory(undefined, { now: NOW }).rows, []);
  assert.equal(readQuestionHistory(undefined, { now: NOW }).unreadable, false);
  assert.deepEqual(readQuestionHistory("", { now: NOW }).rows, []);
});

test("070: панель только читает журнал — файл и каталог не меняются", (t) => {
  const dir = tempDir(t);
  const logFile = path.join(dir, "log.jsonl");
  fs.writeFileSync(logFile, [
    line("question.send", { shortId: SHORT, transport: "max" }),
    line("question.sent", { shortId: SHORT, transport: "max", detail: { messageId: "mid.1" } }),
  ].join("\n") + "\n");
  const beforeText = fs.readFileSync(logFile, "utf8");
  const beforeStat = fs.statSync(logFile);
  const beforeFiles = fs.readdirSync(dir).sort();

  const snap = panelSnapshot({ stateFile: path.join(dir, "state.json"), logFile, now: () => NOW });

  assert.equal(snap.history.rows.length, 1);
  assert.equal(fs.readFileSync(logFile, "utf8"), beforeText, "содержимое журнала не изменилось");
  assert.equal(fs.statSync(logFile).mtimeMs, beforeStat.mtimeMs, "панель не переписывала журнал");
  assert.deepEqual(fs.readdirSync(dir).sort(), beforeFiles, "ни состояния, ни ротации панель не создаёт");
});

test("070: по умолчанию — последние 24 часа и не больше 20 строк", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const lines = [];
  for (let index = 0; index < 25; index += 1) {
    lines.push(JSON.stringify({
      ts: new Date(NOW - index * HOUR).toISOString(),
      event: "question.send",
      shortId: `q${String(index).padStart(7, "0")}`,
    }));
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");

  const snap = panelSnapshot({ stateFile: path.join(dir, "state.json"), logFile: file, now: () => NOW });
  assert.equal(snap.history.rows.length, 20, "N строк по умолчанию — 20");
  assert.equal(snap.history.total, 25, "всего событий в окне больше, чем показано");
  assert.equal(snap.history.rows[0].shortId, "q0000000", "свежие сверху");

  const five = panelSnapshot({ stateFile: path.join(dir, "state.json"), logFile: file, now: () => NOW, historyLimit: 5 });
  assert.equal(five.history.rows.length, 5, "лимит переопределяется");

  const shortWindow = panelSnapshot({ stateFile: path.join(dir, "state.json"), logFile: file, now: () => NOW, historyHours: 1 });
  assert.equal(shortWindow.history.rows.length, 2, "окно по времени тоже работает");
  assert.equal(shortWindow.history.total, 2);
});

test("070: служебные события не сбрасывают статус вопроса", (t) => {
  const snap = snapshot(t, {
    lines: [
      line("question.send", { shortId: SHORT, transport: "max" }),
      line("question.mirror.published", { detail: { mode: "full" } }),
      line("answer.received", { shortId: SHORT, transport: "max", detail: { optionIds: ["o1"] } }),
      line("answer.duplicate", { shortId: SHORT, transport: "max", detail: { reason: "duplicate" } }),
      line("question.expired", { shortId: SHORT }),
    ],
  });
  assert.equal(snap.history.rows[0].status, "answered");
});

/** Словарь подписей панели (как в `client.js`, русская локаль). */
const RU = {
  history: "история вопросов",
  historyNone: "пока нет событий",
  historySkipped: "пропущено строк",
  historyStatusQueued: "отправляется",
  historyStatusDelivered: "доставлен",
  historyStatusError: "ошибка доставки",
  historyStatusAnswered: "отвечен",
  historyStatusUnmatched: "не сопоставлен",
  historyStatusCancelled: "снят",
  historyStatusPairing: "привязка",
  historyStatusPairingError: "ошибка привязки",
};
const t = (key) => RU[key] ?? key;

/**
 * Загрузить клиентский бандл с подставным React: хуки живут в замыкании, поэтому
 * блок можно отрисовать, «нажать» на строку и отрисовать снова — как в браузере,
 * но без DOM.
 */
function loadClient() {
  const source = fs.readFileSync(path.join(pluginDir, "lib", "client.js"), "utf8");
  let factory = null;
  const window = { __ModuleLoader__: { load: (spec) => { factory = spec.factory; } } };
  const slots = [];
  let cursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const index = cursor;
      cursor += 1;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value) => { slots[index] = value; }];
    },
    useCallback: (fn) => fn,
    useEffect: () => {},
  };
  // eslint-disable-next-line no-new-func
  new Function("window", source)(window);
  assert.equal(typeof factory, "function", "client.js зарегистрировал фабрику");
  const client = factory((name) => (name === "react" ? React : {}));
  return {
    ...client.__internals,
    render: (props) => {
      cursor = 0;
      return client.__internals.HistoryBlock(props);
    },
  };
}

/** Текст из дерева элементов подставного React. */
function flatText(node) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatText).filter((part) => part !== "").join(" ");
  if (typeof node === "object") return flatText(node.children);
  return "";
}

/** Все элементы дерева (в порядке появления). */
function flatNodes(node, found = []) {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const item of node) flatNodes(item, found);
    return found;
  }
  if (typeof node !== "object") return found;
  found.push(node);
  flatNodes(node.children, found);
  return found;
}

test("070: блок истории рисует строки, клик раскрывает детали", () => {
  const client = loadClient();
  const history = {
    rows: [
      {
        key: SHORT,
        shortId: SHORT,
        time: NOW,
        project: "/p/one",
        transport: "max",
        status: "answered",
        statusText: "отвечен",
        messageId: "mid.1",
        optionIds: ["o1", "o2"],
        customLength: 7,
        code: null,
        reason: null,
      },
      {
        key: "deadbeef",
        shortId: "deadbeef",
        time: NOW - 60_000,
        project: null,
        transport: "telegram",
        status: "error",
        code: "proto.payload",
        reason: null,
      },
      {
        key: "cafebabe",
        shortId: "cafebabe",
        time: NOW - 120_000,
        project: null,
        transport: "max",
        status: "unmatched",
        code: null,
        reason: "optionId",
      },
    ],
    total: 3,
    skipped: 2,
    unreadable: false,
  };

  let tree = client.render({ history, t });
  let text = flatText(tree);
  assert.match(text, /история вопросов/);
  assert.match(text, /отвечен/);
  assert.match(text, /ошибка доставки \(proto\.payload\)/, "код ошибки виден в статусе");
  assert.match(text, /не сопоставлен \(optionId\)/, "причина несовпадения видна в статусе");
  assert.match(text, new RegExp(SHORT), "короткий идентификатор в строке");
  assert.match(text, /\/p\/one/, "проект в строке");
  assert.match(text, /пропущено строк: 2/, "битые строки посчитаны");
  assert.equal(text.includes("messageId"), false, "детали скрыты до клика");

  const clickable = flatNodes(tree).find((node) => typeof node.props?.onClick === "function");
  assert.ok(clickable, "строка кликабельна");
  clickable.props.onClick();

  tree = client.render({ history, t });
  text = flatText(tree);
  assert.match(text, /messageId: mid\.1/);
  assert.match(text, /optionIds: o1, o2/);
  assert.match(text, /customLength: 7/, "длина ответа вместо текста");

  const rowOf = (node) => flatNodes(node).filter((item) => typeof item.props?.onClick === "function");
  // Вторая строка (ошибка доставки) раскрывает код, а детали первой — прячет.
  rowOf(tree)[1].props.onClick();
  text = flatText(client.render({ history, t }));
  assert.match(text, /code: proto\.payload/);
  assert.equal(text.includes("messageId"), false, "раскрыта только одна строка");

  // Третья строка — причина несовпадения.
  tree = client.render({ history, t });
  rowOf(tree)[2].props.onClick();
  text = flatText(client.render({ history, t }));
  assert.match(text, /reason: optionId/);

  // Повторный клик сворачивает строку.
  tree = client.render({ history, t });
  rowOf(tree)[2].props.onClick();
  text = flatText(client.render({ history, t }));
  assert.equal(text.includes("reason: optionId"), false);
});

test("070: пустая история в панели — «пока нет событий»", () => {
  const client = loadClient();
  const text = flatText(client.render({ history: { rows: [], total: 0, skipped: 0, unreadable: false }, t }));
  assert.match(text, /пока нет событий/);
});

test("070: подписи статусов блока истории", () => {
  const { historyStatus } = loadClient();
  assert.equal(historyStatus({ status: "delivered" }, t), "доставлен");
  assert.equal(historyStatus({ status: "answered" }, t), "отвечен");
  assert.equal(historyStatus({ status: "error", code: 400 }, t), "ошибка доставки (400)");
  assert.equal(historyStatus({ status: "unmatched", reason: "shortId" }, t), "не сопоставлен (shortId)");
  assert.equal(historyStatus({ status: "cancelled", reason: "ttl" }, t), "снят (ttl)");
  assert.equal(historyStatus({ status: "cancelled" }, t), "снят");
});
