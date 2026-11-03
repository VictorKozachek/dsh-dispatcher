/**
 * Политика подтверждений в ответчике (025): решение до канала и таймаут-отказ.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { APPROVAL_REQUEST_EVENT, createApprovals } from "../lib/approvals.js";
import { APPROVAL_OUTCOME } from "../lib/domain/approval.js";
import { createApprovalPolicy } from "../lib/approvals/policy.js";
import { approvalsFeature } from "../lib/features/approvals.js";

const tick = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeTransport() {
  const sent = [];
  const closed = [];
  const handlers = new Set();
  return {
    id: "fake",
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
  const provided = new Map();
  const disposes = [];
  return {
    subscriptions,
    provided,
    on(name, handler, options) {
      subscriptions.push({ name, handler, options });
      return () => {};
    },
    get: () => null,
    provide: (name, service) => provided.set(name, service),
    onDispose: (fn) => disposes.push(fn),
  };
}

function fakeTimers() {
  const timers = new Map();
  let lastId = 0;
  return {
    timers,
    setTimeout: (callback) => {
      lastId += 1;
      timers.set(lastId, callback);
      return lastId;
    },
    clearTimeout: (id) => timers.delete(id),
    fire: () => {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
    size: () => timers.size,
  };
}

function request(overrides = {}) {
  return {
    agent: { id: "session-1" },
    toolName: "read_file",
    callId: "call-1",
    reason: "нужно прочитать файл",
    ...overrides,
  };
}

function setup({ policyConfig = {}, onTimeout, timers = null } = {}) {
  const transport = fakeTransport();
  const policy = createApprovalPolicy(policyConfig);
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy,
    ttlMs: policy.ttlMs,
    onTimeout: onTimeout ?? (() => policy.timeoutOutcome()),
    now: () => 1_700_000_000_000,
    log: () => {},
    ...(timers === null ? {} : { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }),
  });
  const ctx = fakeContext();
  approvals.attach(ctx);
  const nextCalls = [];
  const next = async () => {
    nextCalls.push(true);
    return "gui";
  };
  return { transport, policy, approvals, ctx, next, nextCalls };
}

test("неизвестный инструмент: next() до канала, отправки нет", async () => {
  const { transport, next, nextCalls } = setup();
  const { handler } = (() => {
    const ctx = fakeContext();
    const transport = fakeTransport();
    const approvals = createApprovals({
      transport,
      registry: { resolve: () => ({ enabled: true, scope: "global" }) },
      policy: createApprovalPolicy(null),
      log: () => {},
    });
    approvals.attach(ctx);
    return { handler: ctx.subscriptions[0].handler, transport };
  })();

  const outcome = await handler(request({ toolName: "dangerous_new_tool" }), next);

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1);
  assert.equal(transport.sent.length, 0, "в канал ничего не ушло");
});

test("denyRemote: bash не подтверждается удалённо даже в allowlist", async () => {
  const { transport, next, nextCalls } = setup({ policyConfig: { tools: ["bash"], denyRemote: ["bash"] } });
  const handler = (() => {
    const ctx = fakeContext();
    const transport = fakeTransport();
    const approvals = createApprovals({
      transport,
      registry: { resolve: () => ({ enabled: true, scope: "global" }) },
      policy: createApprovalPolicy({ tools: ["bash"], denyRemote: ["bash"] }),
      log: () => {},
    });
    approvals.attach(ctx);
    return ctx.subscriptions[0].handler;
  })();

  const outcome = await handler(request({ toolName: "bash" }), next);

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1);
  assert.equal(transport.sent.length, 0);
});

test("разрешённый политикой инструмент уходит в канал, ответ даёт allowed-once", async () => {
  const { transport, next } = setup();
  const ctx = fakeContext();
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy: createApprovalPolicy(null),
    log: () => {},
  });
  approvals.attach(ctx);
  const handler = ctx.subscriptions[0].handler;

  const pending = handler(request(), next);
  await tick();
  assert.equal(transport.sent.length, 1, "вопрос отправлен");

  const approval = transport.sent[0];
  transport.answer({ shortId: approval.shortId, optionIds: ["o1"], answeredBy: 7 });
  const outcome = await pending;

  assert.equal(outcome, APPROVAL_OUTCOME.allowedOnce);
});

test("таймаут: cancelled по умолчанию, сообщение закрыто, без allowed-once", async () => {
  const timers = fakeTimers();
  const transport = fakeTransport();
  const policy = createApprovalPolicy(null);
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy,
    ttlMs: policy.ttlMs,
    onTimeout: () => policy.timeoutOutcome(),
    now: () => 1_700_000_000_000,
    log: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const ctx = fakeContext();
  approvals.attach(ctx);
  const pending = ctx.subscriptions[0].handler(request(), async () => "gui");
  await tick();
  assert.equal(transport.sent.length, 1);
  assert.equal(timers.size(), 1, "таймер взведён на TTL");

  timers.fire();
  const outcome = await pending;

  assert.equal(outcome, APPROVAL_OUTCOME.cancelled);
  assert.notEqual(outcome, APPROVAL_OUTCOME.allowedOnce);
  assert.equal(transport.closed.length, 1, "сообщение закрыто пометкой об отказе");
  assert.match(transport.closed[0].summary, /снято|истекло|отказ|время/i);
});

test("onTimeout: unavailable — тоже отказ, а не разрешение", async () => {
  const timers = fakeTimers();
  const transport = fakeTransport();
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy: createApprovalPolicy({ onTimeout: "unavailable" }),
    ttlMs: 60_000,
    onTimeout: () => "unavailable",
    now: () => 1_700_000_000_000,
    log: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const ctx = fakeContext();
  approvals.attach(ctx);
  const pending = ctx.subscriptions[0].handler(request(), async () => "gui");
  await tick();
  timers.fire();

  assert.equal(await pending, APPROVAL_OUTCOME.unavailable);
});

test("ответ до таймаута снимает таймер (нет «двойного» решения)", async () => {
  const timers = fakeTimers();
  const transport = fakeTransport();
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy: createApprovalPolicy(null),
    ttlMs: 60_000,
    now: () => 1_700_000_000_000,
    log: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const ctx = fakeContext();
  approvals.attach(ctx);
  const pending = ctx.subscriptions[0].handler(request(), async () => "gui");
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o2"] });
  assert.equal(await pending, APPROVAL_OUTCOME.rejected);
  assert.equal(timers.size(), 0, "таймер снят");
});

test("фича approvals публикует политику для /remote status и применяет её к запросу", async () => {
  const transport = fakeTransport();
  const ctx = fakeContext();
  const provided = new Map();
  ctx.provide = (name, service) => provided.set(name, service);
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => {
      if (name === "remoteTransport") return transport;
      if (name === "remoteStore") {
        return { read: () => ({ enabled: { global: true, workspaces: {}, sessions: {} }, bindings: null, channels: {} }) };
      }
      return null;
    },
    onDispose: (fn) => ctx.onDispose(fn),
  };

  approvalsFeature.apply(ctx, { approvals: { tools: ["read_file"], denyRemote: ["bash"], onTimeout: "unavailable" } }, deps);

  const policy = provided.get("remoteApprovalPolicy");
  assert.ok(policy, "политика опубликована");
  assert.deepEqual(policy.tools, ["read_file"]);
  assert.match(policy.describe().join("\n"), /onTimeout=unavailable/);
  assert.ok(provided.get("remoteApprovals")?.stats, "статистика 024 на месте");

  const handler = ctx.subscriptions.find((item) => item.name === APPROVAL_REQUEST_EVENT)?.handler;
  assert.equal(typeof handler, "function", "ответчик подписан на approval/request");

  const nextCalls = [];
  const next = async () => {
    nextCalls.push(true);
    return "gui";
  };
  assert.equal(await handler(request({ toolName: "bash" }), next), "gui");
  assert.equal(transport.sent.length, 0, "denyRemote не дошёл до канала");
  assert.equal(nextCalls.length, 1);

  const pending = handler(request({ toolName: "read_file" }), next);
  await tick();
  assert.equal(transport.sent.length, 1, "разрешённый инструмент ушёл в канал");
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o1"] });
  assert.equal(await pending, APPROVAL_OUTCOME.allowedOnce);
});

// --- дефолты и аудит (ревью 025) -------------------------------------------

test("createApprovals без policy безопасен по умолчанию: Bash -> GUI, read_file -> канал", async () => {
  const transport = fakeTransport();
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    log: () => {},
  });
  const ctx = fakeContext();
  approvals.attach(ctx);
  const handler = ctx.subscriptions[0].handler;
  const nextCalls = [];
  const next = async () => {
    nextCalls.push(true);
    return "gui";
  };

  assert.equal(await handler(request({ toolName: "Bash" }), next), "gui");
  assert.equal(transport.sent.length, 0, "опасный инструмент не ушёл в канал");
  assert.equal(nextCalls.length, 1);

  const pending = handler(request({ toolName: "read_file" }), next);
  await tick();
  assert.equal(transport.sent.length, 1, "чтение разрешено дефолтом");
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o1"] });
  assert.equal(await pending, APPROVAL_OUTCOME.allowedOnce);
});

test("решение политики отдаётся аудиту (026) через onDecision", async () => {
  const transport = fakeTransport();
  const records = [];
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy: createApprovalPolicy(null),
    onDecision: (record) => records.push(record),
    now: () => 1_700_000_000_000,
    log: () => {},
  });
  const ctx = fakeContext();
  approvals.attach(ctx);
  const handler = ctx.subscriptions[0].handler;

  assert.equal(await handler(request({ toolName: "bash" }), async () => "gui"), "gui");

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    type: "approval-policy",
    decision: "gui",
    toolName: "bash",
    reason: "deny-remote",
    at: 1_700_000_000_000,
    sessionId: "session-1",
  });
  assert.equal(transport.sent.length, 0);
});

test("фича approvals передаёт решение политики в remoteAudit, если сервис есть", async () => {
  const transport = fakeTransport();
  const ctx = fakeContext();
  const records = [];
  const provided = new Map();
  ctx.provide = (name, service) => provided.set(name, service);
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => {
      if (name === "remoteTransport") return transport;
      if (name === "remoteStore") {
        return { read: () => ({ enabled: { global: true, workspaces: {}, sessions: {} }, bindings: null, channels: {} }) };
      }
      if (name === "remoteAudit") return { record: (record) => records.push(record) };
      return null;
    },
    onDispose: (fn) => ctx.onDispose(fn),
  };
  approvalsFeature.apply(ctx, { approvals: { tools: ["read_file"] } }, deps);

  const handler = ctx.subscriptions.find((item) => item.name === APPROVAL_REQUEST_EVENT)?.handler;
  assert.equal(await handler(request({ toolName: "bash" }), async () => "gui"), "gui");
  assert.equal(records.length, 1);
  assert.equal(records[0].reason, "deny-remote");
  assert.equal(records[0].toolName, "bash");
});

test("таймаут unavailable: исход модели — unavailable, не cancelled", async () => {
  const timers = fakeTimers();
  const transport = fakeTransport();
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy: createApprovalPolicy({ onTimeout: "unavailable" }),
    ttlMs: 60_000,
    onTimeout: () => "unavailable",
    now: () => 1_700_000_000_000,
    log: () => {},
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const ctx = fakeContext();
  approvals.attach(ctx);
  const pending = ctx.subscriptions[0].handler(request(), async () => "gui");
  await tick();
  timers.fire();

  assert.equal(await pending, APPROVAL_OUTCOME.unavailable);
  assert.equal(transport.sent[0].outcome, APPROVAL_OUTCOME.unavailable, "модель не врёт про cancelled");
});
