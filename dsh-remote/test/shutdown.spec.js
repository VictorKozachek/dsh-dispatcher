/**
 * Graceful shutdown и восстановление после падений (задача 034).
 *
 * Проверяем: `stop()` снимает TTL-таймер и вопросы со сторожа, состояние
 * сбрасывается на диск, ответчик закрывает сообщения один раз и снимает вопросы с
 * сторожа, повторный shutdown безопасен, после dispose нет unhandledRejection, а
 * `recoverOrphans` не закрывает одно сообщение дважды и снимает вопросы мёртвых
 * сессий.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAnswerer } from "../lib/answerer.js";
import { DISPOSE_PHASES, apply, orderDisposers } from "../lib/index.js";
import { createFakeTransport } from "../lib/transport/fake.js";
import { createQuestion } from "../lib/domain/question.js";
import { createRegistry } from "../lib/domain/registry.js";
import {
  createJsonState,
  createReliability,
} from "../lib/reliability.js";

const tickMs = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-shutdown-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeTransport({ failClose = false } = {}) {
  const sent = [];
  const closed = [];
  const answerHandlers = [];
  return {
    id: "fake",
    caps: { inlineButtons: true, editAfterAnswer: true, maxText: 4096, maxOptions: 8 },
    sent,
    closed,
    async sendQuestion(question) {
      sent.push(question);
      return { messageId: 100 + sent.length };
    },
    async closeQuestion(question, summary) {
      if (failClose) throw new Error("канал недоступен");
      closed.push({ shortId: question?.shortId, summary });
    },
    onAnswer(handler) {
      answerHandlers.push(handler);
      return () => {
        const index = answerHandlers.indexOf(handler);
        if (index >= 0) answerHandlers.splice(index, 1);
      };
    },
    healthCheck() {
      return { ok: true, detail: "fake" };
    },
  };
}

function openQuestion({ id = "q1", ttlMs = 10 * 60 * 1000 } = {}) {
  const question = createQuestion(
    { id, question: `Вопрос ${id}`, options: [{ label: "Да" }, { label: "Нет" }] },
    { now: 0, ttlMs, workspace: "/p/dsh-dispatcher" },
  );
  question.markOpen(0);
  return question;
}

/** Таймер-двойник: считать взведённые/снятые интервалы. */
function fakeInterval() {
  const armed = [];
  const cleared = [];
  return {
    armed,
    cleared,
    setInterval(fn, ms) {
      const id = { fn, ms };
      armed.push(id);
      return id;
    },
    clearInterval(id) {
      cleared.push(id);
    },
  };
}

function makeReliability(t, options = {}) {
  const dir = tempDir(t);
  const files = {
    state: options.stateFile ?? path.join(dir, "state.json"),
    log: options.logFile ?? path.join(dir, "log.jsonl"),
  };
  const intervals = options.intervals ?? fakeInterval();
  const reliability = createReliability({
    transport: options.transport ?? fakeTransport(),
    state: options.state ?? createJsonState({ file: files.state, now: () => 0 }),
    logFile: files.log,
    now: () => 0,
    isSessionAlive: options.isSessionAlive ?? null,
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
    ...(options.tickIntervalMs === undefined ? {} : { tickIntervalMs: options.tickIntervalMs }),
  });
  return { reliability, files, dir, intervals };
}

test("stop(): снимает TTL-таймер, вопросы со сторожа и сбрасывает состояние", (t) => {
  const { reliability, files, intervals } = makeReliability(t);
  reliability.watch(openQuestion({ id: "q1" }));
  reliability.watch(openQuestion({ id: "q2" }));
  reliability.start();
  assert.equal(intervals.armed.length, 1, "сторож взведён");

  const stored = reliability.store.read();
  assert.equal(stored.questions.length, 2, "вопросы записаны для recovery");

  const stats = reliability.stop();

  assert.deepEqual(stats, { cancelled: 2, watched: 2, pending: 0, timers: 1 });
  assert.equal(intervals.cleared.length, 1, "интервал снят");
  const after = reliability.store.read();
  assert.deepEqual(after.questions, [], "вопросы сняты с восстановления");
  assert.deepEqual(JSON.parse(fs.readFileSync(files.state, "utf8")).questions, [], "состояние сброшено на диск");
});

test("повторный stop() безопасен: ничего не трогает и возвращает нули", (t) => {
  const { reliability, intervals } = makeReliability(t);
  reliability.watch(openQuestion());
  reliability.start();
  reliability.stop();

  const again = reliability.stop();

  assert.deepEqual(again, { cancelled: 0, watched: 0, pending: 0, timers: 0 });
  assert.equal(intervals.cleared.length, 1, "повторно интервал не снимается");
});

test("stop() не теряет pending: очередь остаётся для recovery после рестарта", async (t) => {
  const clock = () => 0;
  const dir = tempDir(t);
  const state = createJsonState({ file: path.join(dir, "state.json"), now: clock });
  state.write({ version: 1, pending: [{ shortId: "p1", questionId: "q1", sessionId: "s1" }], questions: [] });
  const transport = fakeTransport();
  const { reliability } = makeReliability(t, { transport, state });

  reliability.watch(openQuestion());
  reliability.stop();

  assert.equal(reliability.pendingList().length, 1, "недоставленный вопрос остался в очереди");
  const recovered = await reliability.recoverOrphans();
  assert.equal(recovered.cancelled, 1);
  assert.deepEqual(transport.closed, [{ shortId: "p1", summary: "restarted" }]);
  assert.deepEqual(reliability.pendingList(), [], "recovery очистил очередь");
});

test("answerer.dispose: закрывает сообщения один раз и снимает вопросы со сторожа", async (t) => {
  const transport = fakeTransport();
  const unwatched = [];
  const reliability = {
    watch: () => true,
    unwatch: (shortId) => {
      unwatched.push(shortId);
      return true;
    },
  };
  const answerer = createAnswerer({
    transport,
    reliability,
    registry: createRegistry({ readState: () => ({ global: true }) }),
    log: () => {},
    now: () => 0,
  });
  answerer.attach({
    on: () => () => {},
    get: () => null,
    provide: () => {},
  });

  const pendingOutcome = answerer.handler(
    {
      questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] }],
      agent: { id: "session-1" },
    },
    async () => "gui",
  ).catch(() => {});
  await tickMs();
  assert.equal(transport.sent.length, 1, "вопрос ушёл в канал");
  const shortId = transport.sent[0].shortId;

  const stats = answerer.dispose("detached");

  assert.deepEqual(stats, { cancelled: 1, closed: 1 });
  assert.deepEqual(transport.closed, [{ shortId, summary: "detached" }], "сообщение закрыто как cancelled");
  assert.deepEqual(unwatched, [shortId], "вопрос снят с TTL-сторожа");
  await tickMs();
  const noop = answerer.dispose("detached");
  assert.deepEqual(noop, { cancelled: 0, closed: 0 }, "повторный dispose — no-op");
  assert.equal(transport.closed.length, 1, "второго закрытия нет");
  await pendingOutcome;
});

test("после dispose нет unhandledRejection, даже если закрытие сообщения упало", async (t) => {
  const transport = fakeTransport({ failClose: true });
  const answerer = createAnswerer({
    transport,
    reliability: { watch: () => true, unwatch: () => true },
    registry: createRegistry({ readState: () => ({ global: true }) }),
    log: () => {},
    now: () => 0,
  });
  answerer.attach({ on: () => () => {}, get: () => null, provide: () => {} });
  answerer.handler(
    {
      questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }],
      agent: { id: "session-1" },
    },
    async () => "gui",
  ).catch(() => {});
  await tickMs();

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    answerer.dispose("detached");
    await tickMs(8);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, [], "отклонения снятия погашены");
});

test("recoverOrphans: один shortId в pending и questions закрывается один раз", async (t) => {
  const dir = tempDir(t);
  const state = createJsonState({ file: path.join(dir, "state.json"), now: () => 0 });
  state.write({
    version: 1,
    pending: [{ shortId: "a1", questionId: "q1", chatId: 42, messageId: 7 }],
    // Тот же вопрос остался и в списке открытых — второе закрытие недопустимо.
    questions: [{ shortId: "a1", questionId: "q1", chatId: 42, messageId: 7 }],
  });
  const transport = fakeTransport();
  transport.editQuestion = async () => true;
  transport.clearButtons = async () => true;
  const { reliability } = makeReliability(t, { transport, state });

  const result = await reliability.recoverOrphans();

  assert.deepEqual(result, { cancelled: 1, failed: 0 });
  assert.equal(reliability.pendingList().length, 0);
  const second = await reliability.recoverOrphans();
  assert.deepEqual(second, { cancelled: 0, failed: 0 }, "повторный recovery ничего не закрывает");
});

test("recoverOrphans: вопрос мёртвой сессии снимается сразу, а не ждёт", async (t) => {
  const dir = tempDir(t);
  const logFile = path.join(dir, "log.jsonl");
  const state = createJsonState({ file: path.join(dir, "state.json"), now: () => 0 });
  state.write({
    version: 1,
    pending: [],
    questions: [{ shortId: "b2", questionId: "q2", sessionId: "dead-session", chatId: 42, messageId: 9 }],
  });
  const transport = fakeTransport();
  const edited = [];
  transport.editMessage = async (target, text) => {
    edited.push({ target, text });
  };
  transport.clearButtons = async () => {};
  const { reliability } = makeReliability(t, {
    transport,
    state,
    logFile,
    isSessionAlive: (sessionId) => sessionId !== "dead-session",
  });

  const result = await reliability.recoverOrphans();

  assert.deepEqual(result, { cancelled: 1, failed: 0 });
  assert.equal(edited.length, 1, "сообщение закрыто, ожидания не было");
  assert.match(edited[0].text, /сессия перезапущена/);
  const journal = fs.readFileSync(logFile, "utf8");
  assert.match(journal, /orphan-session-dead/, "мёртвая сессия видна в журнале");
});

test("после stop() сторож можно поднять снова (повторный старт безопасен)", (t) => {
  const { reliability, intervals } = makeReliability(t);

  reliability.start();
  reliability.stop();
  reliability.start();

  assert.equal(intervals.armed.length, 2, "сторож взведён повторно");
  assert.equal(intervals.cleared.length, 1, "старый интервал снят один раз");
  reliability.watch(openQuestion({ id: "after-restart" }));
  assert.equal(reliability.store.read().questions.length, 1, "новый вопрос снова под восстановлением");
  const stats = reliability.stop();
  assert.equal(stats.cancelled, 1);
});

// ---------------------------------------------------------------------------
// Порядок снятия ресурсов (034): фазы, а не просто reverse монтирования
// ---------------------------------------------------------------------------

test("orderDisposers: фазы shutdown в фиксированном порядке, внутри фазы — LIFO", () => {
  const calls = [];
  const entries = [
    { fn: () => calls.push("commands"), phase: "commands" },
    { fn: () => calls.push("transport-1"), phase: "transports" },
    { fn: () => calls.push("answerer"), phase: "closers" },
    { fn: () => calls.push("panel"), phase: "other" },
    { fn: () => calls.push("reliability"), phase: "timers" },
    { fn: () => calls.push("transport-2"), phase: "transports" },
    { fn: () => calls.push("approvals"), phase: "closers" },
    { fn: () => calls.push("unknown-phase"), phase: "nonsense" },
    null,
    { fn: "не функция", phase: "closers" },
  ];

  const ordered = orderDisposers(entries);
  for (const entry of ordered) entry.fn();

  assert.deepEqual(calls, [
    // other — в порядке монтирования, LIFO: сюда попал и неизвестный phase
    "unknown-phase",
    "panel",
    // closers: approvals смонтирован позже answerer → снимается первым
    "approvals",
    "answerer",
    "reliability",
    // transports: transport-2 смонтирован позже
    "transport-2",
    "transport-1",
    "commands",
  ]);
  assert.deepEqual([...DISPOSE_PHASES], ["other", "closers", "timers", "transports", "commands"]);
});

test("выгрузка реального плагина: сообщение закрывается ДО остановки транспорта", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    enabled: { global: true, workspaces: {}, sessions: {} },
    bindings: null,
    hybrid: { enabled: false, waitMs: 20_000 },
  }));
  const previous = process.env.DSH_REMOTE_STATE;
  process.env.DSH_REMOTE_STATE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_REMOTE_STATE;
    else process.env.DSH_REMOTE_STATE = previous;
  });

  const transport = createFakeTransport({ now: () => 0 });
  const order = [];
  const realClose = transport.closeQuestion.bind(transport);
  transport.closeQuestion = async (question, summary) => {
    order.push("close");
    return realClose(question, summary);
  };
  const realStop = transport.stop.bind(transport);
  transport.stop = async () => {
    order.push("stop");
    return realStop();
  };

  const handlers = [];
  const effects = [];
  const provided = new Map();
  const services = { remoteTransport: transport };
  const ctx = {
    get: (service) => (Object.hasOwn(services, service) ? services[service] : provided.get(service) ?? null),
    provide: (service, value) => provided.set(service, value),
    on: (event, handler) => {
      handlers.push({ event, handler });
      return () => {};
    },
    effect: (execute, label) => {
      const disposable = execute();
      effects.push({ label, disposable });
      return () => disposable?.();
    },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  };

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await apply(ctx, {});
    assert.equal(effects.length, 1, "dispose зарегистрирован через ctx.effect");

    const requestHandler = handlers.find((item) => item.event === "user-questions/request");
    assert.ok(requestHandler, "ответчик подписан на waterfall вопросов");
    const pending = requestHandler.handler(
      {
        agent: { id: "session-1" },
        questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] }],
      },
      async () => "gui",
    );
    pending.catch(() => {});
    await tickMs(6);
    assert.equal(transport.calls.send, 1, "вопрос ушёл в канал");

    // Выгрузка плагина настоящим путём cordis.
    effects[0].disposable();

    assert.equal(order[0], "close", `сначала закрытие сообщения, потом транспорт: ${order.join(" → ")}`);
    assert.ok(order.includes("stop"), "транспорт остановлен");
    assert.ok(order.indexOf("close") < order.indexOf("stop"), "close до stop");
    assert.equal(order.filter((item) => item === "close").length, 1, "закрытие ровно одно");
    assert.equal(transport.closed.length, 1, "сообщение закрыто в канале");

    // Повторная выгрузка — no-op: новых close/stop нет.
    const before = order.length;
    effects[0].disposable();
    assert.equal(order.length, before, "повторный dispose ничего не делает");
    await tickMs(6);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, [], "после выгрузки нет unhandledRejection");
});
