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

import { panelSnapshot } from "../lib/panel.js";
import { buildQuestionHistory, readJournalEntries, readQuestionHistory } from "../lib/journal-read.js";

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
