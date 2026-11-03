/**
 * Совместная семантика гибрида (028) и TTL-политики (025).
 *
 * При включённых обоих срабатывает тот таймер, который раньше: hybrid отдаёт
 * запрос в GUI (`next()`), TTL — отказ (`cancelled`/`unavailable`). Второй
 * таймер обязан быть снят: ровно один исход, один `next()` и одна audit-запись.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { APPROVAL_REQUEST_EVENT, createApprovals } from "../lib/approvals.js";
import { APPROVAL_OUTCOME } from "../lib/domain/approval.js";
import { createApprovalPolicy } from "../lib/approvals/policy.js";

const tick = async (times = 8) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeTransport() {
  const sent = [];
  const closed = [];
  const handlers = new Set();
  return {
    sent,
    closed,
    async sendQuestion(question) {
      sent.push(question);
      return { messageId: `m-${sent.length}` };
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

/** Таймеры с запоминанием задержек: можно поджечь конкретный, даже снятый. */
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay, cleared: false });
      return timers.length;
    },
    clearTimeout: (id) => {
      const timer = timers[id - 1];
      if (timer !== undefined) timer.cleared = true;
    },
    byDelay: (delay) => timers.filter((timer) => timer.delay === delay),
    fire: (timer) => timer.callback(),
  };
}

function request(overrides = {}) {
  return {
    agent: { id: "session-1" },
    toolName: "read_file",
    callId: "call-1",
    reason: "прочитать файл",
    ...overrides,
  };
}

function setup({ ttlMs, hybridWaitMs, audit }) {
  const timers = fakeTimers();
  const transport = fakeTransport();
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy: createApprovalPolicy(null),
    ttlMs,
    hybrid: { enabled: true, waitMs: hybridWaitMs },
    audit,
    now: () => 1_700_000_000_000,
    log: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const ctx = fakeContext();
  approvals.attach(ctx);
  const nextCalls = [];
  const next = async () => {
    nextCalls.push(true);
    return "gui";
  };
  return { timers, transport, approvals, handler: ctx.subscriptions[0].handler, next, nextCalls };
}

const makeAudit = () => ({ entries: [], append(entry) { this.entries.push(entry); } });

test("TTL раньше hybrid: отказ, ровно один исход и одна audit-запись, hybrid снят", async () => {
  const audit = makeAudit();
  const { timers, transport, handler, next, nextCalls } = setup({ ttlMs: 60_000, hybridWaitMs: 120_000, audit });
  const pending = handler(request(), next);
  await tick();
  assert.equal(transport.sent.length, 1, "подтверждение доставлено");

  const ttlTimer = timers.byDelay(60_000)[0];
  const hybridTimer = timers.byDelay(120_000)[0];
  assert.ok(ttlTimer && hybridTimer, "оба таймера взведены");
  assert.equal(hybridTimer.cleared, false);

  timers.fire(ttlTimer);
  assert.equal(await pending, APPROVAL_OUTCOME.cancelled);
  assert.equal(nextCalls.length, 0, "next() не звали: TTL — отказ, а не GUI");
  assert.equal(audit.entries.length, 1, "одна audit-запись");
  assert.equal(audit.entries[0].decision, "timeout");
  assert.equal(audit.entries[0].outcome, APPROVAL_OUTCOME.cancelled);
  assert.equal(hybridTimer.cleared, true, "гибридный таймер снят");

  // Даже если снятый таймер «выстрелит» (гонка), второго исхода/записи нет.
  timers.fire(hybridTimer);
  assert.equal(nextCalls.length, 0);
  assert.equal(audit.entries.length, 1);
});

test("hybrid раньше TTL: GUI один раз, TTL снят и не пишет второй аудит", async () => {
  const audit = makeAudit();
  const { timers, transport, handler, next, nextCalls } = setup({ ttlMs: 120_000, hybridWaitMs: 20_000, audit });
  const pending = handler(request(), next);
  await tick();
  assert.equal(transport.sent.length, 1);

  const hybridTimer = timers.byDelay(20_000)[0];
  const ttlTimer = timers.byDelay(120_000)[0];
  assert.ok(hybridTimer && ttlTimer);

  timers.fire(hybridTimer);
  assert.equal(await pending, "gui");
  assert.equal(nextCalls.length, 1, "next() ровно один раз");
  assert.equal(audit.entries.length, 1, "одна audit-запись");
  assert.equal(audit.entries[0].decision, "gui");
  assert.equal(audit.entries[0].outcome, APPROVAL_OUTCOME.unavailable);
  assert.equal(ttlTimer.cleared, true, "TTL-таймер снят");

  timers.fire(ttlTimer);
  assert.equal(nextCalls.length, 1);
  assert.equal(audit.entries.length, 1, "поздний TTL не пишет второй аудит");
});

test("ответ кнопкой снимает оба таймера: ни GUI, ни отказа", async () => {
  const audit = makeAudit();
  const { timers, transport, handler, next, nextCalls } = setup({ ttlMs: 60_000, hybridWaitMs: 30_000, audit });
  const pending = handler(request(), next);
  await tick();
  const approval = transport.sent[0];

  transport.answer({ shortId: approval.shortId, optionIds: ["o1"] });
  assert.equal(await pending, APPROVAL_OUTCOME.allowedOnce);
  assert.equal(nextCalls.length, 0);
  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].decision, "remote");

  for (const timer of timers.timers) assert.equal(timer.cleared, true, `таймер ${timer.delay} снят`);
  for (const timer of timers.timers) timers.fire(timer);
  assert.equal(nextCalls.length, 0);
  assert.equal(audit.entries.length, 1, "снятые таймеры не пишут аудит");
});

test("dispose снимает оба таймера и не даёт второму исходу", async () => {
  const audit = makeAudit();
  const { timers, approvals, handler, next, nextCalls } = setup({ ttlMs: 60_000, hybridWaitMs: 30_000, audit });
  const pending = handler(request(), next);
  await tick();

  approvals.dispose("detached");
  assert.equal(await pending, APPROVAL_OUTCOME.cancelled);
  assert.equal(audit.entries.length, 1);
  for (const timer of timers.timers) {
    assert.equal(timer.cleared, true, `таймер ${timer.delay} снят при dispose`);
    timers.fire(timer);
  }
  assert.equal(nextCalls.length, 0);
  assert.equal(audit.entries.length, 1);
});
