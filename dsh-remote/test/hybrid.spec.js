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

function fakeTransport(id = "telegram") {
  const handlers = [];
  const sent = [];
  const closed = [];
  return {
    id,
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

// --- регрессии по ревью 013 -------------------------------------------------

test("два вопроса: ответ на первый не снимает таймер второго", async () => {
  const { answerer, transport, timers, steers, logs } = setup();
  let nextCalls = 0;
  const questions = [
    { id: "q1", question: "Первый?", options: [{ label: "Да" }] },
    { id: "q2", question: "Второй?", options: [{ label: "Да" }] },
  ];

  const pending = answerer.handler({ questions, agent: { id: SESSION_ID } }, () => {
    nextCalls += 1;
    return { answers: [] };
  });
  await tick();
  assert.equal(timers.delays().length, 2, "по таймеру на каждый вопрос");

  const first = transport.sent[0];
  transport.answer({ shortId: first.shortId, optionId: "o1" });
  await tick();

  timers.tick(); // «время вышло» по второму вопросу
  await tick();
  assert.equal(nextCalls, 0, "пачка уже частично отвечена — GUI не зовём");
  assert.match(logs.join("\n"), /пачка уже частично отвечена/);

  // Второй вопрос остался обычным ожиданием: его ответ — результат, не steer.
  const second = transport.sent[1];
  transport.answer({ shortId: second.shortId, optionId: "o1" });
  const result = await pending;
  assert.equal(result.answers.length, 2);
  assert.equal(steers.length, 0, "steer не нужен: GUI не забирал пачку");
});

test("late-steer вызывает prompt(request, signal) по контракту DSH", async () => {
  const timers = fakeTimers();
  const transport = fakeTransport();
  const prompts = [];
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const controller = new AbortController();
  const answerer = createAnswerer({
    transport,
    registry,
    hybrid: { enabled: true, waitMs: 20_000 },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    log: () => {},
    now: () => 0,
  });
  const ctx = {
    get: (name) => (name === "sessionController"
      ? {
        async prompt(request, signal) {
          prompts.push({ request, signal });
        },
      }
      : null),
    on: (event, handler) => {
      return () => {};
    },
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };
  answerer.attach(ctx);

  const pending = answerer.handler(
    { questions: [ITEM], agent: { id: SESSION_ID }, signal: controller.signal },
    () => ({ answers: [] }),
  );
  await tick();
  timers.tick();
  await pending;

  const { shortId } = transport.sent[0];
  transport.answer({ shortId, optionId: "o1" });
  await tick();

  assert.equal(prompts.length, 1);
  const { request, signal } = prompts[0];
  assert.equal(request.mode, "steer");
  assert.match(request.requestId, /^[0-9a-f-]{36}$/, "requestId — новый uuid, как в 008");
  assert.equal(request.sessionId, SESSION_ID);
  // Свежий сигнал: исходный request.signal после next() может быть aborted.
  assert.ok(signal instanceof AbortSignal, "второй аргумент — AbortSignal");
  assert.equal(signal.aborted, false, "новый сигнал не отменён");
  assert.match(request.content[0].text, /из мессенджера/);
});

test("сбой steer: ответ не теряется молча и сообщение не закрывается", async () => {
  const { answerer, transport, timers, logs } = setup({
    hybrid: { enabled: true, waitMs: 20_000 },
  });
  let failSteer = true;
  const steers = [];
  // подменяем steer через повторную сборку ответчика с падающим steer
  const timers2 = fakeTimers();
  const transport2 = fakeTransport();
  const answerer2 = createAnswerer({
    transport: transport2,
    registry: createRegistry({ readState: () => ({ global: true }) }),
    hybrid: { enabled: true, waitMs: 20_000 },
    setTimeout: timers2.setTimeout,
    clearTimeout: timers2.clearTimeout,
    steer: async (argument) => {
      steers.push(argument);
      if (failSteer) throw new Error("sessionController недоступен");
    },
    log: (message) => logs.push(message),
    now: () => 0,
  });
  void answerer;
  void transport;
  void timers;
  answerer2.attach({
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
    get: () => null,
  });

  const pending = answerer2.handler({ questions: [ITEM], agent: { id: SESSION_ID } }, () => ({ answers: [] }));
  await tick();
  const { shortId } = transport2.sent[0];
  timers2.tick();
  await pending;

  transport2.answer({ shortId, optionId: "o1" });
  await tick();
  await tick();

  assert.equal(steers.length, 1, "попытка была");
  assert.equal(transport2.closed.length, 0, "сообщение не закрыто: ответ не доставлен");
  assert.match(logs.join("\n"), /не доставлен в сессию/);

  // Повтор (после починки) закрывает сообщение и засчитывает метрику.
  failSteer = false;
  transport2.answer({ shortId, optionId: "o1" });
  await tick();
  await tick();
  assert.equal(transport2.closed.length, 1, "успешный steer закрыл сообщение");
  assert.equal(answerer2.stats.hybridPhoneAnswers, 1);
});

test("метрика гибрида видна в /remote status", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-hybrid-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ file: path.join(dir, "state.json") });
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  store.setHybrid({ enabled: true, waitMs: 20_000 });

  const ctx = {
    get: (name) => {
      if (name === "sessions") return { get: () => ({ header: { cwd: "/p" } }) };
      if (name === "remoteAnswerer") return { stats: { hybridHanded: 3, hybridPhoneAnswers: 2 } };
      return null;
    },
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };
  const remote = createRemoteCommands({ ctx, store, log: () => {}, now: () => 0, currentChannel: () => ({ id: "telegram" }) });
  const status = await remote.handler({
    commandId: "c1",
    agent: { id: SESSION_ID, session: { id: SESSION_ID } },
    rawInput: "status",
    signal: new AbortController().signal,
  });

  assert.match(status.text, /гибрид: вкл, ждём 20 с/);
  assert.match(status.text, /гибрид-метрика: в GUI 3, ответов из телефона после GUI 2/);
});

// --- мультиканальный гибрид (012 + 013) -------------------------------------

test("гибрид на двух каналах: таймер после публикации в оба, late-ответ из одного, close всех", async () => {
  const timers = fakeTimers();
  const telegram = fakeTransport("telegram");
  const max = fakeTransport("max");
  const steers = [];
  const logs = [];
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({
    transports: [telegram, max],
    registry,
    hybrid: { enabled: true, waitMs: 20_000 },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    steer: async (argument) => {
      steers.push(argument);
    },
    log: (message) => logs.push(message),
    now: () => 0,
  });
  answerer.attach({
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
    get: () => null,
  });

  let nextCalls = 0;
  const pending = answerer.handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] }], agent: { id: SESSION_ID } },
    () => {
      nextCalls += 1;
      return { answers: [] };
    },
  );
  await tick();

  assert.equal(telegram.sent.length, 1, "вопрос ушёл в telegram");
  assert.equal(max.sent.length, 1, "вопрос ушёл в max");
  assert.equal(timers.delays().length, 1, "гибридный таймер взведён");

  timers.tick();
  await pending;
  assert.equal(nextCalls, 1, "next() ровно один раз");
  assert.equal(answerer.stats.hybridHanded, 1);

  // Ответ приходит из MAX уже после ухода вопроса в GUI.
  const shortId = max.sent[0].shortId;
  max.answer({ shortId, optionId: "o1" });
  await tick();

  assert.equal(steers.length, 1, "поздний ответ доставлен steer-ом один раз");
  assert.match(steers[0].text, /из мессенджера/);
  assert.equal(max.closed.at(-1).summary, "Да", "победивший канал закрыт ответом");
  assert.equal(telegram.closed.at(-1).summary, "answered-elsewhere", "проигравший закрыт пометкой");
  assert.equal(answerer.stats.hybridPhoneAnswers, 1);
});
