/**
 * Очередь подтверждений и роутинг (027): несколько запросов одновременно,
 * ответ попадает в свой `callId`/`shortId`, текст не подменяет кнопку,
 * поздний ответ не переигрывает закрытый исход.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { APPROVAL_REQUEST_EVENT, createApprovals } from "../lib/approvals.js";
import { APPROVAL_OUTCOME } from "../lib/domain/approval.js";

const tick = async (times = 8) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeTransport(id = "fake") {
  const sent = [];
  const closed = [];
  const handlers = new Set();
  return {
    id,
    sent,
    closed,
    async sendQuestion(question, options) {
      sent.push({ question, options: options ?? null });
      return { messageId: `m-${id}-${sent.length}` };
    },
    async closeQuestion(question, summary) {
      closed.push({ shortId: question.shortId, summary });
    },
    onAnswer(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    answer(event) {
      for (const handler of [...handlers]) handler(event);
    },
  };
}

function fakeContext() {
  const subscriptions = [];
  return {
    subscriptions,
    on(name, handler, options) {
      subscriptions.push({ name, handler, options });
      return () => {};
    },
    get: () => null,
    provide: () => {},
    onDispose: () => {},
  };
}

function setup({ transports = [fakeTransport()] } = {}) {
  const approvals = createApprovals({
    transport: transports.length === 1 ? transports[0] : null,
    transports: transports.length > 1 ? transports : null,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    now: () => 1_700_000_000_000,
    log: () => {},
  });
  const ctx = fakeContext();
  approvals.attach(ctx);
  const handler = ctx.subscriptions.find((item) => item.name === APPROVAL_REQUEST_EVENT)?.handler;
  assert.equal(typeof handler, "function");
  const nextCalls = [];
  const next = async () => {
    nextCalls.push(true);
    return "gui";
  };
  return { approvals, transport: transports[0], transports, handler, next, nextCalls };
}

function request(overrides = {}) {
  return {
    agent: { id: "session-1" },
    toolName: "Bash",
    callId: "call-1",
    reason: "нужно запустить тесты",
    ...overrides,
  };
}

test("два подтверждения параллельно: очередь нумеруется, решения независимы", async () => {
  const { transport, handler, next } = setup();

  const first = handler(request({ toolName: "Bash", callId: "call-1" }), next);
  const second = handler(request({ toolName: "Write", callId: "call-2", agent: { id: "session-2" } }), next);
  await tick();

  assert.equal(transport.sent.length, 2, "оба подтверждения ушли в канал");
  const [a, b] = transport.sent.map((item) => item.question);
  assert.notEqual(a.shortId, b.shortId, "разные shortId — разные кнопки");
  assert.match(a.title, /#1/, "первое — №1 в очереди");
  assert.match(b.title, /#2/, "второе — №2 в очереди");
  assert.equal(a.callId, "call-1");
  assert.equal(b.callId, "call-2");

  // Отвечаем второму раньше первого: каждый исход — свой.
  transport.answer({ shortId: b.shortId, optionIds: ["o2"] });
  assert.equal(await second, APPROVAL_OUTCOME.rejected);
  transport.answer({ shortId: a.shortId, optionIds: ["o1"] });
  assert.equal(await first, APPROVAL_OUTCOME.allowedOnce);

  assert.equal(next.calls ?? 0, 0);
});

test("ответ на чужой shortId игнорируется, ожидание продолжается", async () => {
  const { transport, handler, next } = setup();
  const pending = handler(request(), next);
  await tick();
  const approval = transport.sent[0].question;

  transport.answer({ shortId: "deadbeef", optionIds: ["o1"] });
  await tick();
  assert.equal(transport.closed.length, 0, "чужой shortId ничего не закрыл");

  transport.answer({ shortId: approval.shortId, optionIds: ["o3"] });
  assert.equal(await pending, APPROVAL_OUTCOME.unavailable);
});

test("свободный текст не считается ответом: подсказка и ожидание кнопки", async () => {
  const { transport, handler, next } = setup();
  const pending = handler(request(), next);
  await tick();
  const approval = transport.sent[0].question;

  transport.answer({ shortId: approval.shortId, text: "да, разрешаю" });
  await tick();

  assert.equal(transport.sent.length, 2, "отправлена подсказка");
  const hint = transport.sent[1].question;
  assert.match(hint.body, /кнопк/, "подсказка просит нажать кнопку");
  assert.deepEqual(hint.options, [], "в подсказке нет кнопок решения");
  assert.equal(transport.closed.length, 0, "подтверждение не закрыто текстом");

  // Повтор: только кнопка решает.
  transport.answer({ shortId: approval.shortId, optionIds: ["o1"] });
  assert.equal(await pending, APPROVAL_OUTCOME.allowedOnce);
});

test("поздний ответ после аборта не переигрывает исход", async () => {
  const controller = new AbortController();
  const { transport, handler, next } = setup();
  const pending = handler(request({ signal: controller.signal }), next);
  await tick();
  const approval = transport.sent[0].question;

  controller.abort();
  assert.equal(await pending, APPROVAL_OUTCOME.cancelled);
  assert.equal(transport.closed.length, 1, "сообщение снято");

  // Поздний ответ: исход уже принят, второй раз не решаем.
  transport.answer({ shortId: approval.shortId, optionIds: ["o1"] });
  await tick();
  assert.equal(transport.closed.length, 1, "повторно сообщение не закрывается");
});

test("мультиканальность: ответ в одном канале закрывает проигравший", async () => {
  const telegram = fakeTransport("telegram");
  const max = fakeTransport("max");
  const { handler, next } = setup({ transports: [telegram, max] });
  const pending = handler(request(), next);
  await tick();

  assert.equal(telegram.sent.length, 1);
  assert.equal(max.sent.length, 1);
  const shortId = telegram.sent[0].question.shortId;
  assert.equal(max.sent[0].question.shortId, shortId, "один shortId на оба канала");

  telegram.answer({ shortId, optionIds: ["o1"] });
  assert.equal(await pending, APPROVAL_OUTCOME.allowedOnce);

  assert.equal(telegram.closed.length, 1, "победивший канал закрыт");
  assert.equal(max.closed.length, 1, "проигравший канал закрыт пометкой");
  assert.match(max.closed[0].summary, /answered-elsewhere|другом канале|Отвечено/i);
});

test("повторный ответ после решения не переигрывает исход", async () => {
  const { transport, handler, next } = setup();
  const pending = handler(request(), next);
  await tick();
  const approval = transport.sent[0].question;

  transport.answer({ shortId: approval.shortId, optionIds: ["o1"] });
  assert.equal(await pending, APPROVAL_OUTCOME.allowedOnce);
  const closedAfterFirst = transport.closed.length;

  // Второй раз то же подтверждение: исход уже принят, ничего не меняется.
  transport.answer({ shortId: approval.shortId, optionIds: ["o2"] });
  await tick();
  assert.equal(transport.closed.length, closedAfterFirst, "повторно не закрываем и не меняем исход");
  assert.equal(approval.outcome, APPROVAL_OUTCOME.allowedOnce, "исход остался прежним");
});
