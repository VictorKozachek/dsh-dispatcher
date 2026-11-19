/**
 * 063: mirror — feature-detect хоста и две деградации.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAnswerer, detectMirrorMode } from "../lib/answerer.js";
import { createRegistry } from "../lib/domain/registry.js";
import { createRemoteCommands } from "../lib/commands.js";
import { createStore } from "../lib/store.js";

function fakeTransport() {
  const handlers = new Set();
  const transport = {
    id: "max",
    sent: [],
    closed: [],
    async sendQuestion(question) {
      transport.sent.push(question);
      return { messageId: `m-${transport.sent.length}` };
    },
    async closeQuestion(question, summary) {
      transport.closed.push({ question, summary });
    },
    onAnswer(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    answer(event) {
      for (const handler of [...handlers]) handler(event);
    },
  };
  return transport;
}

function fakeJournal() {
  const events = [];
  return { events, record: (event, fields = {}) => { events.push({ event, ...fields }); return true; } };
}

function mirrorHarness({ mode = "full", next = () => new Promise(() => {}), withCancel = true } = {}) {
  const transport = fakeTransport();
  const journal = fakeJournal();
  const settles = [];
  const cancels = [];
  let expire = null;
  const reliability = {
    watch: (question, options) => { expire = options.onExpire; return question; },
    unwatch: () => {},
  };
  const answerer = createAnswerer({
    transport,
    reliability,
    registry: createRegistry({ readState: () => ({ global: true }) }),
    journal,
    mirror: () => ({
      enabled: true,
      mode,
      settle: async (...args) => { settles.push(args); return true; },
      cancel: async (...args) => { cancels.push(args); return true; },
    }),
    log: () => {},
    now: () => 1000,
  });
  answerer.attach({ on: () => () => {}, get: () => null, effect: (fn) => { const dispose = fn(); return () => dispose?.(); } });
  const request = (overrides = {}) => ({
    agent: { id: "s1" },
    callId: "call-1",
    questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] }],
    ...overrides,
  });
  return { answerer, transport, journal, settles, cancels, request, next, reliability, expire: () => expire };
}

test("063: detectMirrorMode — full только с settle+cancel+resolved, иначе notify", () => {
  assert.equal(detectMirrorMode({ settle() {}, cancel() {}, capabilities: { resolvedEvent: true } }), "full");
  assert.equal(detectMirrorMode({ settle() {}, cancel() {} }), "notify", "без подтверждённого события");
  assert.equal(detectMirrorMode({ settle() {}, capabilities: { resolvedEvent: true } }), "notify", "без cancel");
  assert.equal(detectMirrorMode({ cancel() {} }), "notify", "без settle");
  assert.equal(detectMirrorMode({}), "notify");
});

test("063 full: ответ из канала settle-ит GUI один раз и возвращает ответ", async () => {
  const stand = mirrorHarness({ mode: "full" });
  const pending = stand.answerer.handler(stand.request(), stand.next);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stand.transport.sent.length, 1, "вопрос опубликован");
  stand.transport.answer({ shortId: stand.transport.sent[0].shortId, optionId: "o1", answeredBy: "7" });

  const result = await pending;
  assert.deepEqual(result.answers, [{ id: "q1", selected: ["Да"] }]);
  assert.equal(stand.settles.length, 1, "settle вызван один раз");
  assert.equal(stand.settles[0][1], "call-1");
  assert.deepEqual(stand.settles[0][2], result);
  const names = stand.journal.events.map((entry) => entry.event);
  assert.ok(names.includes("question.mirror.published"));
  assert.ok(names.includes("answer.from_transport"));
  assert.ok(names.includes("answer.settled"));
});

test("063 full: поздний ответ после settle отброшен, settle ровно один", async () => {
  const stand = mirrorHarness({ mode: "full" });
  const pending = stand.answerer.handler(stand.request(), stand.next);
  await new Promise((resolve) => setImmediate(resolve));
  stand.transport.answer({ shortId: stand.transport.sent[0].shortId, optionId: "o1" });

  await pending;
  stand.transport.answer({ shortId: stand.transport.sent[0].shortId, optionId: "o2" });
  assert.equal(stand.settles.length, 1, "второй ответ не делает второй settle");
  assert.equal(stand.journal.events.filter((entry) => entry.event === "answer.dropped").length, 1);
});

test("063 full: TTL/аборт снимает оба представления и отменяет GUI", async () => {
  const stand = mirrorHarness({ mode: "full" });
  const pending = stand.answerer.handler(stand.request(), stand.next);
  await new Promise((resolve) => setImmediate(resolve));
  const question = stand.transport.sent[0];
  // Реальная reliability сначала гасит канал, затем зовёт onExpire.
  await stand.transport.closeQuestion(question, "expired");
  const error = new Error("ASK_ABORTED");
  error.name = "AbortError";
  stand.expire()({ kind: "abort", error });

  await assert.rejects(pending, (caught) => caught?.name === "AbortError");
  assert.equal(stand.cancels.length, 1, "GUI-вопрос отменён");
  assert.ok(stand.transport.closed.length >= 1, "канал погашен");
});

test("063 full: GUI выиграл — сообщение закрыто, поздний клик dropped без settle", async () => {
  const guiAnswer = { answers: [{ id: "q1", selected: ["GUI"] }] };
  const stand = mirrorHarness({ mode: "full", next: async () => guiAnswer });
  const result = await stand.answerer.handler(stand.request(), stand.next);

  assert.deepEqual(result, guiAnswer);
  assert.equal(stand.transport.closed.length, 1, "сообщение в канале погашено");
  assert.equal(stand.settles.length, 0, "settle не вызывался");
  assert.equal(stand.journal.events.some((entry) => entry.event === "answer.from_gui"), true);

  stand.transport.answer({ shortId: stand.transport.sent[0].shortId, optionId: "o1" });
  const dropped = stand.journal.events.filter((entry) => entry.event === "answer.dropped");
  assert.equal(dropped.length, 1, "поздний ответ отброшен в журнал");
  assert.equal(stand.transport.closed.length, 1, "второй раз сообщение не закрывается");
});

test("071 notify: ответ GUI закрывает сообщение и снимает кнопки сразу", async () => {
  const guiAnswer = { answers: [{ id: "q1", selected: ["GUI"] }] };
  const stand = mirrorHarness({ mode: "notify", next: async () => guiAnswer });
  const result = await stand.answerer.handler(stand.request(), stand.next);

  assert.deepEqual(result, guiAnswer, "GUI — источник истины");
  assert.equal(stand.settles.length, 0);
  assert.equal(stand.transport.closed.length, 1, "сообщение закрыто после next(), не после клика");
  assert.match(String(stand.transport.closed[0].summary), /GUI|answered-in-gui/);
  const fromGui = stand.journal.events.find((entry) => entry.event === "answer.from_gui");
  assert.ok(fromGui, "answer.from_gui в журнале");
  assert.equal(fromGui.detail.mode, "notify");
  assert.deepEqual(fromGui.detail.targets, ["max"]);

  stand.transport.answer({ shortId: stand.transport.sent[0].shortId, optionId: "o1" });
  const dropped = stand.journal.events.find((entry) => entry.event === "answer.dropped");
  assert.ok(dropped);
  assert.equal(dropped.detail.reason, "gui");
  assert.equal(stand.journal.events.some((entry) => entry.event === "answer.unmatched"), false);
});

test("071 notify: ошибка закрытия не мешает ответу и пишется в журнал", async () => {
  const guiAnswer = { answers: [{ id: "q1", selected: ["GUI"] }] };
  const stand = mirrorHarness({ mode: "notify", next: async () => guiAnswer });
  stand.transport.closeQuestion = async () => { throw new Error("MAX 500"); };
  const result = await stand.answerer.handler(stand.request(), stand.next);

  assert.deepEqual(result, guiAnswer, "ответ дошёл до сессии");
  const error = stand.journal.events.find((entry) => entry.event === "question.error");
  assert.ok(error);
  assert.equal(error.detail.status, "close-failed");
  assert.match(String(error.detail.message), /MAX 500/);
});

test("063 full: аборт снимает сообщение и отменяет GUI", async () => {
  const stand = mirrorHarness({ mode: "full" });
  const controller = new AbortController();
  const pending = stand.answerer.handler(stand.request({ signal: controller.signal }), stand.next);
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(stand.transport.closed.length, 1, "канал погашен");
  assert.equal(stand.cancels.length, 1, "host.cancel вызван");
});

function commandStand({ host = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-cmd-"));
  const store = createStore({ file: path.join(dir, "state.json") });
  store.setBinding({ transport: "max", chatId: 42, userId: 7, botUsername: "max_bot" });
  const channel = { id: "max", start: async () => {}, stop: async () => {}, sendQuestion: async () => ({}) };
  const remote = createRemoteCommands({
    ctx: {
      get: (name) => (name === "userQuestions" ? host : null),
      on: () => () => {},
    },
    store,
    log: () => {},
    now: () => 1000,
    currentChannel: () => channel,
  });
  return { store, remote };
}

test("063: /remote mirror on|off и status показывают режим и причину", async () => {
  const full = commandStand({ host: { settle: async () => true, cancel: async () => true, capabilities: { resolvedEvent: true } } });
  const on = await full.remote.handler({ commandId: "1", agent: { id: "s1", session: { id: "s1" } }, rawInput: "mirror on", signal: new AbortController().signal });
  assert.equal(on.kind, "success");
  assert.match(on.text, /full/);
  const status = await full.remote.handler({ commandId: "2", agent: { id: "s1", session: { id: "s1" } }, rawInput: "mirror", signal: new AbortController().signal });
  assert.equal(status.kind, "success");
  assert.match(status.text, /mirror: full/);
  const off = await full.remote.handler({ commandId: "3", agent: { id: "s1", session: { id: "s1" } }, rawInput: "mirror off", signal: new AbortController().signal });
  assert.equal(off.kind, "success");
  assert.match(off.text, /выключен|disabled/);

  const notify = commandStand({ host: {} });
  await notify.remote.handler({ commandId: "4", agent: { id: "s1", session: { id: "s1" } }, rawInput: "mirror on", signal: new AbortController().signal });
  const notifyStatus = await notify.remote.handler({ commandId: "5", agent: { id: "s1", session: { id: "s1" } }, rawInput: "mirror", signal: new AbortController().signal });
  assert.match(notifyStatus.text, /mirror: notify/);
  assert.match(notifyStatus.text, /settle|хост/);
});

test("063 answerer: mode full без cancel деградирует в notify", async () => {
  const guiAnswer = { answers: [{ id: "q1", selected: ["GUI"] }] };
  const stand = mirrorHarness({ mode: "full", withCancel: false, next: async () => guiAnswer });
  const result = await stand.answerer.handler(stand.request(), stand.next);
  assert.deepEqual(result, guiAnswer, "GUI остаётся источником истины");
  stand.transport.answer({ shortId: stand.transport.sent[0].shortId, optionId: "o1" });
  assert.equal(stand.settles.length, 0);
  assert.equal(stand.transport.closed.length, 1);
});

test("063: settle без cancel не включает full — режим notify", async () => {
  const host = { settle: async () => true };
  assert.equal(detectMirrorMode(host), "notify");
  const stand = commandStand({ host });
  await stand.remote.handler({ commandId: "7", agent: { id: "s1", session: { id: "s1" } }, rawInput: "mirror on", signal: new AbortController().signal });
  const status = await stand.remote.handler({ commandId: "8", agent: { id: "s1", session: { id: "s1" } }, rawInput: "mirror", signal: new AbortController().signal });
  assert.match(status.text, /mirror: notify/);
});

test("063: mirror в status — none, если режим не включён", async () => {
  const stand = commandStand({ host: { settle: async () => true } });
  const result = await stand.remote.handler({ commandId: "6", agent: { id: "s1", session: { id: "s1" } }, rawInput: "status", signal: new AbortController().signal });
  assert.equal(result.kind, "success");
  assert.match(result.text, /mirror: none/);
});
