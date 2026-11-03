/**
 * Метрики и `/remote stats` (031): только числа, фиксированные бакеты, JSON.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LATENCY_BUCKETS_MS,
  createMetrics,
  emptySnapshot,
  formatStats,
} from "../lib/metrics.js";
import { createStore } from "../lib/store.js";
import { createRemoteCommands } from "../lib/commands.js";

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-metrics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createStore({ file: path.join(dir, "state.json") });
}

test("счётчики: инкременты, неизвестное имя — ошибка, отрицательные не принимаются", () => {
  const metrics = createMetrics();
  assert.equal(metrics.inc("questions.asked"), 1);
  assert.equal(metrics.inc("questions.asked", 2), 3);
  assert.equal(metrics.inc("approvals.allowed_once"), 1);
  assert.equal(metrics.inc("deliveries.sent", 5), 5);
  assert.throws(() => metrics.inc("questions.unknown"), /неизвестный счётчик/);
  assert.throws(() => metrics.inc("questions.asked", "много"), /delta/);
  assert.throws(() => metrics.inc("questions.asked", -1), /отрицательным/);
  assert.equal(metrics.snapshot().questions.asked, 3, "отрицательный delta не изменил счётчик");
});

test("гистограмма латентности: фиксированные бакеты, память не растёт", () => {
  const metrics = createMetrics();
  metrics.observeLatency(50);   // <= 100
  metrics.observeLatency(150);  // <= 250
  metrics.observeLatency(9_000); // <= 10_000
  metrics.observeLatency(10_000_000); // в последний бакет

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.latency.count, 4);
  assert.equal(snapshot.latency.sumMs, 50 + 150 + 9_000 + 10_000_000);
  assert.equal(snapshot.latency.buckets.length, LATENCY_BUCKETS_MS.length, "бакеты фиксированы");
  assert.deepEqual(snapshot.latency.buckets.map((bucket) => bucket.le), [...LATENCY_BUCKETS_MS]);
  assert.equal(snapshot.latency.buckets.find((bucket) => bucket.le === 10_000).count, 1);
  assert.equal(snapshot.latency.buckets.at(-1).count, 1, "хвост — в последний бакет");
  assert.equal(metrics.observeLatency(-1), false);
  assert.equal(metrics.observeLatency("плохо"), false);
});

test("ошибки транспорта: известные id, остальное — other", () => {
  const metrics = createMetrics();
  metrics.transportError("telegram");
  metrics.transportError("telegram");
  metrics.transportError("unknown-transport");
  metrics.transportError("unknown-transport");

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.errors.telegram, 2);
  assert.equal(snapshot.errors.other, 2);
  assert.equal(snapshot.errors["unknown-transport"], undefined, "id не утекает в метрики");
});

test("очереди: gauge только для фиксированных имён, снимок независим", () => {
  const metrics = createMetrics();
  metrics.gauge("deliveries_pending", 3);
  metrics.gauge("timers_active", 1);
  assert.throws(() => metrics.gauge("unknown_queue", 1), /неизвестная очередь/);
  assert.throws(() => metrics.gauge("timers_active", -1), /≥ 0/);

  const first = metrics.snapshot();
  first.queues.timers_active = 99;
  assert.equal(metrics.snapshot().queues.timers_active, 1, "снимок не разделяет состояние");
});

test("сброс при старте: новые метрики пусты, uptime считается от создания", () => {
  let clock = 1_000;
  const first = createMetrics({ now: () => clock });
  first.inc("questions.asked");
  clock = 61_000;
  assert.equal(first.snapshot().uptimeMs, 60_000);

  const second = createMetrics({ now: () => clock });
  assert.deepEqual(second.snapshot().questions, emptySnapshot().questions, "новый инстанс пуст");
  assert.equal(second.snapshot().uptimeMs, 0);
});

test("в снимке только числа: нет тел вопросов, id, токенов", () => {
  const metrics = createMetrics();
  metrics.inc("questions.asked");
  metrics.observeLatency(42);
  const dump = JSON.stringify(metrics.snapshot());

  assert.equal(/token|secret|questionId|user/i.test(dump), false, dump);
  const parsed = JSON.parse(dump);
  const walk = (value) => {
    if (typeof value === "number") return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (value !== null && typeof value === "object") return Object.values(value).forEach(walk);
    assert.fail(`в метриках не число: ${JSON.stringify(value)}`);
  };
  walk(parsed);
});

test("formatStats: человеческие строки без секретов", () => {
  const metrics = createMetrics();
  metrics.inc("questions.asked");
  metrics.inc("questions.answered");
  metrics.inc("approvals.policy_gui");
  metrics.inc("deliveries.failed");
  metrics.transportError("telegram");
  const text = formatStats(metrics.snapshot());

  assert.match(text, /вопросы: задано 1, отвечено 1/);
  assert.match(text, /policy-GUI 1/);
  assert.match(text, /доставки: отправлено 0, ошибок 1/);
  assert.match(text, /ошибки транспортов: telegram=1/);
  assert.equal(/token|secret/i.test(text), false);
});

// --- команда ----------------------------------------------------------------

function harness(t, { metrics = createMetrics(), reliability = null, approvals = null } = {}) {
  const store = tempStore(t);
  const ctx = {
    get: (name) => {
      if (name === "remoteMetrics") return metrics;
      if (name === "remoteReliability") return reliability;
      if (name === "remoteApprovals") return approvals;
      return null;
    },
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };
  const remote = createRemoteCommands({ ctx, store, log: () => {}, now: () => 1_700_000_000_000 });
  return { store, remote, ctx, metrics, invoke: (rawInput) => ({
    commandId: "c1",
    agent: { id: "s1", session: { id: "s1" } },
    rawInput,
    signal: new AbortController().signal,
  }) };
}

test("/remote stats --json: парсится, структура стабильна", async (t) => {
  const metrics = createMetrics();
  metrics.inc("questions.asked");
  const stand = harness(t, {
    metrics,
    reliability: { healthCheck: async () => ({ ok: true, pending: 2, watching: 1 }) },
    approvals: { pendingOpen: 3, stats: {} },
  });

  const result = await stand.remote.handler(stand.invoke("stats --json"));

  assert.equal(result.kind, "success", result.text);
  const snapshot = JSON.parse(result.text);
  assert.deepEqual(Object.keys(snapshot), [
    "questions", "approvals", "deliveries", "errors", "queues", "latency", "uptimeMs",
  ]);
  assert.equal(snapshot.questions.asked, 1);
  assert.equal(snapshot.queues.deliveries_pending, 2);
  assert.equal(snapshot.queues.timers_active, 1);
  assert.equal(snapshot.queues.approvals_open, 3);
  assert.equal(/secret|token/i.test(result.text), false);
});

test("/remote stats: человеческий вывод, без фичи — понятная ошибка", async (t) => {
  const stand = harness(t);
  const result = await stand.remote.handler(stand.invoke("stats"));
  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /вопросы: задано 0/);
  assert.match(result.text, /очереди: доставок 0/);

  const noMetrics = harness(t, { metrics: null });
  const failed = await noMetrics.remote.handler(noMetrics.invoke("stats"));
  assert.equal(failed.kind, "error");
  assert.match(failed.text, /метрики недоступны/);
});

test("интеграция: вопрос и ответ двигают счётчики и латентность", async (t) => {
  const { createAnswerer } = await import("../lib/answerer.js");
  const { createRegistry } = await import("../lib/domain/registry.js");
  let clock = 2_000;
  const metrics = createMetrics({ now: () => 1_000 });
  const sent = [];
  const handlers = new Set();
  const transport = {
    id: "telegram",
    async sendQuestion(question) {
      sent.push(question);
      return { messageId: "m-1" };
    },
    async closeQuestion() {},
    onAnswer(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({ transport, registry, metrics, now: () => clock, log: () => {} });
  answerer.attach({
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
    get: () => null,
  });

  const pending = answerer.handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: "s1" } },
    () => assert.fail("next() нельзя"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  clock = 3_000;
  for (const handler of handlers) handler({ shortId: sent[0].shortId, optionIds: ["o1"] });
  await pending;

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.questions.asked, 1);
  assert.equal(snapshot.questions.answered, 1);
  assert.equal(snapshot.questions.cancelled, 0);
  assert.equal(snapshot.latency.count, 1);
  assert.equal(snapshot.latency.sumMs, 1_000, "латентность = now - createdAt");
});

// --- ревью 031: реальная форма сервиса approvals и отсутствие side effect ----

test("фича approvals публикует pendingOpen, а stats видит реальную очередь", async (t) => {
  const { approvalsFeature } = await import("../lib/features/approvals.js");
  const metrics = createMetrics();
  const sent = [];
  const handlers = new Set();
  const transport = {
    id: "telegram",
    async sendQuestion(question) {
      sent.push(question);
      return { messageId: "m-1" };
    },
    async closeQuestion() {},
    onAnswer(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const store = tempStore(t);
  store.setEnabled({ kind: "global" }, true);
  const provided = new Map();
  let approvalHandler = null;
  const ctx = {
    provide: (name, service) => provided.set(name, service),
    on: (name, fn) => {
      if (name === "approval/request") approvalHandler = fn;
      return () => {};
    },
    get: (name) => (name === "remoteMetrics" ? metrics : provided.get(name) ?? null),
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
    onDispose: () => {},
  };
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => {
      if (name === "remoteTransport") return transport;
      if (name === "remoteStore") return store;
      if (name === "remoteMetrics") return metrics;
      return null;
    },
    onDispose: () => {},
  };
  approvalsFeature.apply(ctx, { approvals: { tools: ["read_file"], denyRemote: [] } }, deps);

  const service = provided.get("remoteApprovals");
  assert.equal(typeof service?.pendingOpen, "number", "сервис отдаёт pendingOpen");

  const pending = approvalHandler(
    { agent: { id: "s1" }, toolName: "read_file", callId: "c-1" },
    async () => "gui",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1, "подтверждение ушло в канал");
  assert.equal(service.pendingOpen, 1, "одно открытое подтверждение");

  const before = metrics.snapshot().queues.approvals_open;
  const remote = createRemoteCommands({ ctx, store, log: () => {}, now: () => 1_700_000_000_000 });
  const invoke = (rawInput) => ({
    commandId: "c1",
    agent: { id: "s1", session: { id: "s1" } },
    rawInput,
    signal: new AbortController().signal,
  });

  const json = await remote.handler(invoke("stats --json"));
  assert.equal(json.kind, "success", json.text);
  const snapshot = JSON.parse(json.text);
  assert.equal(snapshot.queues.approvals_open, 1, "JSON видит фактическую очередь approvals");
  assert.equal(metrics.snapshot().queues.approvals_open, before, "stats не мутирует метрики");

  const human = await remote.handler(invoke("stats"));
  assert.match(human.text, /очереди: доставок \d+, таймеров \d+, подтверждений 1/);

  for (const answer of [...handlers]) answer({ shortId: sent[0].shortId, optionIds: ["o1"] });
  await pending;
  assert.equal(service.pendingOpen, 0, "после ответа очередь пуста");
});
