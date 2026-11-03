/**
 * Сценарные тесты «безопасность» для подтверждений (задача 029).
 *
 * Здесь проверяются не отдельные функции, а обещания политики: молчание не
 * разрешает действие, `denyRemote` главнее allowlist, выключенный режим не меняет
 * DSH, аборт — не согласие, чужой чат не может подтвердить.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { APPROVAL_REQUEST_EVENT, createApprovals } from "../lib/approvals.js";
import { createApprovalPolicy } from "../lib/approvals/policy.js";
import { createTelegramTransport } from "../lib/transport/telegram.js";

const TOKEN = "123456:TEST-TOKEN";

const tick = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function fakeTransport({ failSend = false, id = "fake" } = {}) {
  const sent = [];
  const closed = [];
  const handlers = new Set();
  return {
    id,
    sent,
    closed,
    async sendQuestion(question) {
      if (failSend) throw new Error("транспорт недоступен");
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
    get() {
      return null;
    },
    provide() {},
  };
}

function request(overrides = {}) {
  return {
    agent: { id: "session-1" },
    toolName: "read_file",
    callId: "call-42",
    reason: "нужно прочитать файл",
    ...overrides,
  };
}

/** Ответчик с политикой и фейковым транспортом; часы и таймеры под контролем. */
function stand({ policy = null, transport = fakeTransport(), hybrid = null, timers = null } = {}) {
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy,
    // Как в фиче: TTL и onTimeout берутся из политики.
    ...(policy === null ? {} : { ttlMs: policy.ttlMs, onTimeout: () => policy.timeoutOutcome() }),
    hybrid,
    ...(timers === null ? {} : { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }),
    now: () => 1_700_000_000_000,
    log: () => {},
  });
  approvals.attach(fakeContext());
  const nextCalls = [];
  const next = async () => {
    nextCalls.push(true);
    return "gui";
  };
  return { approvals, transport, next, nextCalls };
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
    fire(index = 0) {
      const [timer] = timers.splice(index, 1);
      timer.fn();
    },
  };
}

// ---------------------------------------------------------------------------
// Политика: что уходит удалённо, а что нет
// ---------------------------------------------------------------------------

test("denyRemote побеждает tools: инструмент в обоих списках остаётся в GUI", () => {
  const policy = createApprovalPolicy({ tools: ["read_file", "bash"], denyRemote: ["bash"] });

  const allowed = policy.decide(request({ toolName: "read_file" }));
  const denied = policy.decide(request({ toolName: "bash" }));

  assert.equal(allowed.remote, true, "allowlist разрешает read_file");
  assert.equal(denied.remote, false, "denyRemote обязан победить allowlist");
  assert.equal(denied.reason, "deny-remote");
});

test("неизвестный и неразрешённый инструмент — только GUI", () => {
  const policy = createApprovalPolicy({ tools: ["read_file"], denyRemote: [] });

  const notListed = policy.decide(request({ toolName: "bash" }));
  const noTool = policy.decide({ agent: { id: "s" } });

  assert.equal(notListed.remote, false);
  assert.equal(notListed.reason, "tool-not-allowed");
  assert.equal(noTool.remote, false, "без имени инструмента удалённо не спрашиваем");
  assert.equal(noTool.reason, "unknown-tool");
});

test("по умолчанию удалённо подтверждается только чтение, опасное — нет", () => {
  const policy = createApprovalPolicy(null);

  assert.equal(policy.decide(request({ toolName: "read_file" })).remote, true, "чтение по умолчанию можно");
  for (const tool of ["bash", "git_push", "rm", "delete_file"]) {
    const resolution = policy.decide(request({ toolName: tool }));
    assert.equal(resolution.remote, false, `${tool} не должен подтверждаться удалённо`);
    assert.equal(resolution.reason, "deny-remote", `${tool}: причина — denyRemote`);
  }
});

test("битый конфиг политики не расширяет права", () => {
  const policy = createApprovalPolicy({ tools: "read_file", denyRemote: [42], onTimeout: "allow", ttlMs: 1 });

  assert.equal(policy.decide(request({ toolName: "bash" })).remote, false, "мусор в tools — дефолтный allowlist");
  assert.equal(policy.timeoutOutcome(), "cancelled", "неизвестный onTimeout — отказ по умолчанию");
  assert.equal(policy.ttlMs, 30 * 60 * 1000, "ttl вне диапазона — дефолт");
});

// ---------------------------------------------------------------------------
// Таймаут не разрешает действие
// ---------------------------------------------------------------------------

test("политика: таймаут никогда не даёт allowed-once", () => {
  for (const onTimeout of [undefined, "cancelled", "unavailable"]) {
    const policy = createApprovalPolicy(onTimeout === undefined ? {} : { onTimeout });
    const outcome = policy.timeoutOutcome();
    assert.ok(["cancelled", "unavailable"].includes(outcome), `onTimeout=${onTimeout}: ${outcome}`);
    assert.notEqual(outcome, "allowed-once");
  }
});

test("ответчик: TTL-таймаут отдаёт отказ, а не разрешение", async () => {
  const timers = fakeTimers();
  const policy = createApprovalPolicy({ onTimeout: "cancelled", ttlMs: 60_000 });
  const { approvals, next, nextCalls } = stand({ policy, timers });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  assert.equal(timers.timers.length, 1, "TTL-таймер взведён");
  timers.fire(0);

  const outcome = await pendingOutcome;
  assert.equal(outcome, "cancelled", "молчание = отказ по политике");
  assert.notEqual(outcome, "allowed-once");
  assert.equal(nextCalls.length, 0, "при TTL-отказе GUI не зовём (решение уже принято)");
  assert.equal(approvals.stats.cancelled >= 1, true);
});

test("гибрид: таймаут отдаёт запрос в GUI и тоже не разрешает", async () => {
  const timers = fakeTimers();
  const { approvals, next, nextCalls } = stand({
    hybrid: { enabled: true, waitMs: 5_000 },
    timers,
  });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  // С политикой (025) взведён и TTL-таймер: жмём именно гибридный.
  const hybridTimer = timers.timers.findIndex((timer) => timer.ms === 5_000);
  assert.ok(hybridTimer >= 0, "гибридный таймер взведён");
  timers.fire(hybridTimer);

  const outcome = await pendingOutcome;
  assert.equal(outcome, "gui", "гибрид отдаёт запрос в GUI");
  assert.notEqual(outcome, "allowed-once");
  assert.equal(nextCalls.length, 1);
});

test("«Отклонить»: исход rejected — действие не выполняется", async () => {
  const { approvals, transport, next, nextCalls } = stand({
    policy: createApprovalPolicy({ tools: ["read_file"] }),
  });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o2"] });

  assert.equal(await pendingOutcome, "rejected");
  assert.equal(nextCalls.length, 0, "явный отказ не уходит в GUI");
});

test("«Не отвечать»: исход unavailable (fail closed), а не allowed-once", async () => {
  const { approvals, transport, next } = stand({
    policy: createApprovalPolicy({ tools: ["read_file"] }),
  });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o3"] });

  const outcome = await pendingOutcome;
  assert.equal(outcome, "unavailable");
  assert.notEqual(outcome, "allowed-once");
});

test("политика onTimeout=unavailable: TTL тоже отказ, но другой исход", async () => {
  const timers = fakeTimers();
  const policy = createApprovalPolicy({ onTimeout: "unavailable", ttlMs: 60_000 });
  const { approvals, next, nextCalls } = stand({ policy, timers });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  timers.fire(0);

  const outcome = await pendingOutcome;
  assert.equal(outcome, "unavailable");
  assert.notEqual(outcome, "allowed-once");
  assert.equal(nextCalls.length, 0, "решение принято (отказ), GUI не зовём");
});

test("нумерация: сбой доставки тратит номер, policy-GUI и ранний аборт — нет", async () => {
  let sends = 0;
  const sent = [];
  const transport = {
    id: "flaky",
    async sendQuestion(question) {
      sends += 1;
      if (sends === 1) throw new Error("сеть недоступна");
      sent.push(question);
      return { messageId: 100 + sent.length };
    },
    async closeQuestion() {},
    onAnswer() {
      return () => {};
    },
  };
  const policy = createApprovalPolicy({ tools: ["read_file"], denyRemote: [] });
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy,
    log: () => {},
  });
  approvals.attach(fakeContext());
  const next = async () => "gui";

  // 1) Политика отдаёт GUI (инструмент не в allowlist) — номер не тратится.
  await approvals.handler(request({ toolName: "bash", callId: "call-policy" }), next);
  // 2) Ранний аборт — номер тоже не тратится.
  const aborted = new AbortController();
  aborted.abort();
  await approvals.handler(request({ callId: "call-abort", signal: aborted.signal }), next);
  // 3) Сбой доставки: номер уже выдан перед sendQuestion и остаётся потраченным.
  const failed = approvals.handler(request({ callId: "call-1" }), next);
  await tick();
  assert.equal(await failed, "gui", "сбой доставки уходит в GUI");
  // 4) Следующее подтверждение получает #2, хотя в канале сообщений с #1 не было.
  const second = approvals.handler(request({ callId: "call-2" }), next);
  await tick();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].queueNumber, 2, "неудачная отправка израсходовала номер #1");
  assert.match(sent[0].title, /#2$/, "заголовок — «Подтверждение действия #2»");
  assert.equal(approvals.pending.size, 1, "второе подтверждение ждёт ответа");
  approvals.dispose("test-cleanup");
  await second.catch(() => {});
});

// ---------------------------------------------------------------------------
// Выключенный режим, аборт, падение транспорта
// ---------------------------------------------------------------------------

test("режим выключен: DSH ведёт себя как без плагина", async () => {
  const transport = fakeTransport();
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: false, scope: null }) },
    policy: createApprovalPolicy({ tools: ["read_file"] }),
    log: () => {},
  });
  approvals.attach(fakeContext());
  const nextCalls = [];

  const outcome = await approvals.handler(request(), async () => {
    nextCalls.push(true);
    return "gui";
  });

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1, "next() ровно один раз");
  assert.equal(transport.sent.length, 0, "в выключенном режиме ничего не отправляем");
});

test("аборт сигнала: cancelled — это не согласие", async () => {
  const { approvals, next } = stand({ policy: createApprovalPolicy({ tools: ["read_file"] }) });
  const controller = new AbortController();

  const pendingOutcome = approvals.handler(request({ signal: controller.signal }), next);
  await tick();
  controller.abort();

  const outcome = await pendingOutcome;
  assert.equal(outcome, "cancelled");
  assert.notEqual(outcome, "allowed-once");
});

test("падение транспорта: GUI, действие не разрешено", async () => {
  const transport = fakeTransport({ failSend: true });
  const { approvals, next, nextCalls } = stand({
    policy: createApprovalPolicy({ tools: ["read_file"] }),
    transport,
  });

  const outcome = await approvals.handler(request(), next);

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1, "подтверждение уходит в GUI");
});

// ---------------------------------------------------------------------------
// Чужой чат не может подтвердить
// ---------------------------------------------------------------------------

test("чужой чат/человек не может подтвердить действие", async () => {
  const polls = [];
  const calls = [];
  const response = (body) => ({
    ok: true,
    status: 200,
    async json() {
      return body;
    },
  });
  const fetch = async (url, init = {}) => {
    const method = url.split("/").pop();
    const payload = init.body === undefined ? {} : JSON.parse(init.body);
    calls.push({ method, payload });
    if (method === "getMe") return response({ ok: true, result: { username: "test_bot", id: 42 } });
    if (method === "getUpdates") {
      return new Promise((resolve) => polls.push(resolve));
    }
    return response({ ok: true, result: { message_id: 100 + calls.length } });
  };

  const transport = createTelegramTransport({
    token: TOKEN,
    chatId: 42,
    allowedUserIds: [7],
    fetch,
    jitter: () => 0,
    now: () => 1_000,
    sleep: async () => {},
    log: () => {},
  });
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    policy: createApprovalPolicy({ tools: ["read_file"] }),
    now: () => 1_000,
    log: () => {},
  });
  approvals.attach(fakeContext());

  const next = async () => "gui";
  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  await transport.start();
  await tick();
  const shortId = [...approvals.pending.keys()][0];
  assert.ok(shortId, "подтверждение ушло в канал и ждёт ответа");

  const callback = (updateId, from, chat) => ({
    update_id: updateId,
    callback_query: {
      id: `cb${updateId}`,
      from: { id: from },
      message: { chat: { id: chat } },
      data: `q:${shortId}:o1`,
    },
  });

  // Чужой человек и чужой чат: транспорт обязан отбросить оба нажатия.
  polls.shift()(response({ ok: true, result: [callback(1, 99, 42), callback(2, 7, 999)] }));
  await tick(8);
  assert.equal(approvals.pending.size, 1, "чужое нажатие не решило подтверждение");

  // Свой человек в своём чате — и только теперь исход.
  polls.shift()(response({ ok: true, result: [callback(3, 7, 42)] }));
  assert.equal(await pendingOutcome, "allowed-once");
  await transport.stop();
});
