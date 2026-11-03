/**
 * Тесты гибридного режима (013): мессенджер → GUI через N секунд.
 *
 * Фейковые часы и таймеры, фейковый транспорт, фейковый `steer` — без сети и без
 * реальных ожиданий.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createAnswerer } from "../lib/answerer.js";
import { createRegistry } from "../lib/domain/registry.js";
import { createRemoteCommands } from "../lib/commands.js";
import { createStore, DEFAULT_HYBRID_WAIT_MS } from "../lib/store.js";

const SESSION_ID = "session-hybrid";

/** Таймеры на фейковом времени: тест сам решает, когда «время вышло». */
function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout: (callback, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    /** «Время вышло»: срабатывают все таймеры. */
    tick: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
    get size() {
      return timers.size;
    },
    delays: () => [...timers.values()].map((timer) => timer.ms),
  };
}

function fakeTransport() {
  const handlers = [];
  const sent = [];
  const closed = [];
  return {
    id: "telegram",
    caps: { inlineButtons: true, editAfterAnswer: true, maxText: 4096, maxOptions: 8 },
    sent,
    closed,
    async sendQuestion(question) {
      sent.push(question);
      return { messageId: "mid-1" };
    },
    async closeQuestion(question, summary) {
      closed.push({ question, summary });
    },
    async editQuestion() {
      return true;
    },
    onAnswer(handler) {
      handlers.push(handler);
      return () => {
        const index = handlers.indexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
    answer(event) {
      for (const handler of handlers) handler(event);
    },
    async healthCheck() {
      return { ok: true, detail: "ok" };
    },
  };
}

const ITEM = { id: "q1", question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] };

function setup({ hybrid = { enabled: true, waitMs: 20_000 } } = {}) {
  const timers = fakeTimers();
  const transport = fakeTransport();
  const delays = [];
  const steers = [];
  const logs = [];
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({
    transport,
    registry,
    hybrid,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    steer: async (argument) => {
      steers.push(argument);
    },
    log: (message) => logs.push(message),
    now: () => 0,
  });
  const hooks = new Map();
  answerer.attach({
    on: (event, handler) => {
      hooks.set(event, handler);
      return () => hooks.delete(event);
    },
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
    get: () => null,
  });
  return { answerer, transport, timers, delays, steers, logs };
}

const tick = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("гибрид: нет ответа N секунд — next() вызван один раз, сообщение открыто", async () => {
  const { answerer, transport, timers } = setup();
  let nextCalls = 0;

  const pending = answerer.handler({ questions: [ITEM], agent: { id: SESSION_ID } }, () => {
    nextCalls += 1;
    return { answers: [] };
  });
  await tick();
  assert.equal(transport.sent.length, 1, "сначала мессенджер");
  assert.deepEqual(timers.delays(), [20_000], "гибрид ждёт hybridWaitMs");
  assert.equal(transport.closed.length, 0, "сообщение не закрыто: человек ещё может ответить");

  timers.tick();
  const result = await pending;

  assert.equal(nextCalls, 1, "next() ровно один раз");
  assert.deepEqual(result, { answers: [] });
  assert.equal(transport.closed.length, 0, "сообщение в мессенджере осталось открытым");
  assert.equal(answerer.stats.hybridHanded, 1);
});

test("гибрид: ответ до таймера — GUI не зовётся, таймер снят", async () => {
  const { answerer, transport, timers } = setup();
  let nextCalls = 0;

  const pending = answerer.handler({ questions: [ITEM], agent: { id: SESSION_ID } }, () => {
    nextCalls += 1;
    return { answers: [] };
  });
  await tick();
  const { shortId } = transport.sent[0];

  transport.answer({ shortId, optionId: "o1" });
  const result = await pending;
  timers.tick(); // «время вышло» уже после ответа

  assert.equal(nextCalls, 0, "GUI не звали");
  assert.deepEqual(result.answers, [{ id: "q1", selected: ["Да"] }]);
  assert.equal(timers.size, 0, "таймер снят");
  assert.equal(transport.closed.at(-1).summary, "Да", "сообщение закрыто ответом");
});

test("гибрид: ответ после ухода в GUI доставляется steer-ом и закрывает сообщение", async () => {
  const { answerer, transport, timers, steers, logs } = setup();
  let nextCalls = 0;

  const pending = answerer.handler({ questions: [ITEM], agent: { id: SESSION_ID } }, () => {
    nextCalls += 1;
    return { answers: [] };
  });
  await tick();
  const { shortId } = transport.sent[0];

  timers.tick();
  await pending;
  assert.equal(nextCalls, 1);

  transport.answer({ shortId, optionId: "o2" });
  await tick();

  assert.equal(steers.length, 1, "поздний ответ доставлен ровно один раз");
  assert.match(steers[0].text, /ответ человека на вопрос .* из мессенджера/);
  assert.match(steers[0].text, /Нет/);
  assert.equal(transport.closed.at(-1).summary, "Нет", "сообщение закрыто как отвеченное");
  assert.equal(answerer.stats.hybridPhoneAnswers, 1);
  assert.match(logs.join("\n"), /после ухода в GUI/);

  // Дубль того же ответа не превращается во второй steer.
  transport.answer({ shortId, optionId: "o2" });
  await tick();
  assert.equal(steers.length, 1, "дублей нет");
});

test("гибрид выключен: поведение как в 008 — таймера нет, next() не зовётся", async () => {
  const { answerer, transport, timers } = setup({ hybrid: { enabled: false, waitMs: 20_000 } });
  let nextCalls = 0;

  const pending = answerer.handler({ questions: [ITEM], agent: { id: SESSION_ID } }, () => {
    nextCalls += 1;
    return { answers: [] };
  });
  await tick();
  assert.equal(timers.size, 0, "таймер не взводился");

  const { shortId } = transport.sent[0];
  transport.answer({ shortId, optionId: "o1" });
  await pending;

  assert.equal(nextCalls, 0);
  assert.equal(answerer.stats.hybridHanded, 0);
});

test("/remote on --hybrid: состояние и status", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-hybrid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const store = createStore({ file });

  const ctx = {
    get: (name) => (name === "sessions" ? { get: () => ({ header: { cwd: "/p" } }) } : null),
    commands: { register: () => () => {} },
    userQuestions: { ask: async () => ({ answers: [] }) },
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const channel = { id: "telegram", start: async () => {}, stop: async () => {} };
  const remote = createRemoteCommands({ ctx, store, log: () => {}, now: () => 0, currentChannel: () => channel });
  const invoke = (rawInput) => ({
    commandId: "c1",
    agent: { id: SESSION_ID, session: { id: SESSION_ID } },
    rawInput,
    signal: new AbortController().signal,
  });

  const on = await remote.handler(invoke("on --hybrid"));
  assert.equal(on.kind, "success", on.text);
  assert.equal(store.read().hybrid.enabled, true);
  assert.equal(store.read().hybrid.waitMs, DEFAULT_HYBRID_WAIT_MS);

  const status = await remote.handler(invoke("status"));
  assert.match(status.text, /гибрид: вкл, ждём 20 с/);

  const off = await remote.handler(invoke("off --hybrid"));
  assert.equal(off.kind, "success", off.text);
  assert.equal(store.read().hybrid.enabled, false);
  assert.match((await remote.handler(invoke("status"))).text, /гибрид: выкл/);
});
