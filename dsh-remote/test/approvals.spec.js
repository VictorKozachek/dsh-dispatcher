/**
 * Ответчик `approval/request` (задача 024).
 *
 * Проверяем ровно то, что важно для безопасности: закрытый словарь исходов,
 * `next()` при выключенном режиме (поведение DSH не меняется), три кнопки,
 * `prepend: true`, аборт запроса и падение транспорта.
 */

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { APPROVAL_REQUEST_EVENT, createApprovals } from "../lib/approvals.js";
import { createAudit } from "../lib/audit.js";
import { APPROVAL_OUTCOME, RemoteApproval } from "../lib/domain/approval.js";
import { features } from "../lib/features.js";
import { hybridConfigFrom } from "../lib/features/approvals.js";

const tick = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Транспорт-двойник: запоминает сообщения и умеет «нажать кнопку». */
function fakeTransport({ failSend = false, id = "fake" } = {}) {
  const sent = [];
  const sentOptions = [];
  const closed = [];
  const handlers = new Set();
  return {
    id,
    sent,
    sentOptions,
    closed,
    async sendQuestion(question, options) {
      if (failSend) throw new Error("транспорт недоступен");
      sent.push(question);
      sentOptions.push(options ?? null);
      return { messageId: `m-${sent.length}` };
    },
    async closeQuestion(question, summary) {
      closed.push({ shortId: question.shortId, summary });
    },
    onAnswer(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    /** Нажать кнопку от имени человека. */
    answer(event) {
      for (const handler of [...handlers]) handler(event);
    },
    get answerHandlers() {
      return handlers.size;
    },
  };
}

/** Контекст плагина: запоминает подписки и позволяет позвать снятие. */
function fakeContext() {
  const subscriptions = [];
  const disposes = [];
  return {
    subscriptions,
    on(name, handler, options) {
      subscriptions.push({ name, handler, options });
      return () => {
        const index = subscriptions.findIndex((item) => item.handler === handler);
        if (index >= 0) subscriptions.splice(index, 1);
      };
    },
    get() {
      return null;
    },
    provide() {},
    onDispose(fn) {
      disposes.push(fn);
    },
    disposes,
  };
}

function request(overrides = {}) {
  return {
    agent: { id: "session-1" },
    toolName: "Bash",
    callId: "call-42",
    reason: "нужно запустить тесты",
    ...overrides,
  };
}

function setup({ enabled = true, transport = fakeTransport(), requestOverride = {}, audit = null, hybrid = null, timers = null } = {}) {
  const registry = { resolve: () => ({ enabled, scope: enabled ? "global" : null }) };
  const approvals = createApprovals({
    transport,
    registry,
    audit,
    hybrid,
    ...(timers === null ? {} : { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }),
    now: () => 1_700_000_000_000,
    log: () => {},
  });
  const ctx = fakeContext();
  const detach = approvals.attach(ctx);
  const nextCalls = [];
  const next = async () => {
    nextCalls.push(true);
    return "gui";
  };
  return { approvals, transport, ctx, detach, next, nextCalls, registry, requestOverride };
}

test("режим выключен: next() ровно один раз, сообщений нет", async () => {
  const transport = fakeTransport();
  const approvals = createApprovals({
    transport,
    registry: { resolve: () => ({ enabled: false, scope: null }) },
    log: () => {},
  });
  approvals.attach(fakeContext());
  const nextCalls = [];
  const next = async () => {
    nextCalls.push(true);
    return "gui";
  };

  const outcome = await approvals.handler(request(), next);

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1, "next() должен быть вызван ровно один раз");
  assert.equal(transport.sent.length, 0, "в выключенном режиме сообщение не отправляется");
});

test(" подписка на approval/request идёт с prepend: true", () => {
  const { ctx, transport } = setup();
  const subscription = ctx.subscriptions.find((item) => item.name === APPROVAL_REQUEST_EVENT);

  assert.ok(subscription, "слушатель approval/request не подписан");
  assert.equal(subscription.options?.prepend, true, "без prepend слушатель окажется за GUI");
  assert.equal(transport.answerHandlers, 1, "ответы транспорта должны быть подписаны");
});

test("«Разрешить один раз» возвращает allowed-once, next() не зовётся", async () => {
  const { approvals, transport, next } = setup();

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  assert.equal(transport.sent.length, 1, "подтверждение должно уйти в канал");

  const message = transport.sent[0];
  assert.equal(message.kind, "approval");
  assert.match(message.body, /Bash/);
  assert.match(message.body, /нужно запустить тесты/);
  assert.equal(message.options.length, 3, "кнопок ровно три");
  assert.deepEqual(message.options.map((option) => option.label), [
    "Разрешить один раз",
    "Отклонить",
    "Не отвечать",
  ]);

  transport.answer({ shortId: message.shortId, optionIds: ["o1"] });
  const outcome = await pendingOutcome;

  assert.equal(outcome, APPROVAL_OUTCOME.allowedOnce);
  assert.equal(outcome, "allowed-once");
  assert.deepEqual(transport.closed, [{ shortId: message.shortId, summary: "Разрешено один раз" }]);
});

test("«Отклонить» возвращает rejected", async () => {
  const { approvals, transport, next } = setup();

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o2"] });

  assert.equal(await pendingOutcome, "rejected");
  assert.equal(transport.closed[0].summary, "Отклонено");
});

test("«Не отвечать» возвращает unavailable (fail closed), а не allowed", async () => {
  const { approvals, transport, next } = setup();

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o3"] });

  assert.equal(await pendingOutcome, "unavailable");
  assert.notEqual(await pendingOutcome, "allowed-once");
});

test("аборт запроса: cancelled и сообщение снимается", async () => {
  const { approvals, transport, next } = setup();
  const controller = new AbortController();

  const pendingOutcome = approvals.handler(request({ signal: controller.signal }), next);
  await tick();
  controller.abort();

  assert.equal(await pendingOutcome, "cancelled");
  await tick();
  assert.equal(transport.closed.length, 1);
  assert.equal(transport.closed[0].summary, "Снято");
});

test("поздний ответ после аборта игнорируется", async () => {
  const { approvals, transport, next } = setup();
  const controller = new AbortController();

  const pendingOutcome = approvals.handler(request({ signal: controller.signal }), next);
  await tick();
  controller.abort();
  assert.equal(await pendingOutcome, "cancelled");

  const closedBefore = transport.closed.length;
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o1"] });
  await tick();
  assert.equal(transport.closed.length, closedBefore, "после снятия сообщение не закрывается повторно");
});

test("падение транспорта: next() — подтверждение уходит в GUI", async () => {
  const transport = fakeTransport({ failSend: true });
  const { approvals, next, nextCalls } = setup({ transport });

  const outcome = await approvals.handler(request(), next);

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1);
});

test("транспорт без onAnswer: next() (ждать решение не на чем)", async () => {
  const transport = {
    id: "no-answers",
    sent: [],
    async sendQuestion(question) {
      transport.sent.push(question);
    },
    async closeQuestion() {},
  };
  const { approvals, next, nextCalls } = setup({ transport });

  const outcome = await approvals.handler(request(), next);

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1, "next() ровно один раз");
  assert.equal(transport.sent.length, 0, "недоставляемое подтверждение не отправляем");
});

test("два канала: первый доставил, второй ответил — решают оба", async () => {
  const first = fakeTransport({ id: "first" });
  const second = fakeTransport({ id: "second" });
  const approvals = createApprovals({
    transports: [first, second],
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    log: () => {},
  });
  approvals.attach(fakeContext());
  const next = async () => "gui";

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  assert.equal(first.sent.length, 1, "подтверждение ушло в первый канал");
  assert.equal(second.sent.length, 1, "и во второй");

  second.answer({ shortId: second.sent[0].shortId, optionIds: ["o1"] });
  assert.equal(await pendingOutcome, "allowed-once");
  await tick();

  assert.equal(second.closed.length, 1, "канал-победитель закрыт");
  assert.equal(first.closed.length, 1, "проигравший канал тоже закрыт — кнопки не остаются");
});

test("каналы проектов (015): у каждого транспорта свой chatId", async () => {
  const telegram = fakeTransport({ id: "telegram" });
  const max = fakeTransport({ id: "max" });
  const approvals = createApprovals({
    transports: [telegram, max],
    registry: { resolve: () => ({ enabled: true, scope: "global" }) },
    channelOf: (workspace, transportId) => (
      transportId === "telegram" ? { chatId: "-100-telegram", threadId: 7 } : { chatId: "-200-max", threadId: null }
    ),
    log: () => {},
  });
  approvals.attach(fakeContext());
  const next = async () => "gui";

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  assert.equal(telegram.sentOptions[0].chatId, "-100-telegram");
  assert.equal(telegram.sentOptions[0].threadId, 7);
  assert.equal(max.sentOptions[0].chatId, "-200-max");
  assert.notEqual(max.sentOptions[0].chatId, "-100-telegram", "телеграм-чат не должен уехать в MAX");

  max.answer({ shortId: max.sent[0].shortId, optionIds: ["o2"] });
  assert.equal(await pendingOutcome, "rejected");
});

test("после доставки подтверждение открыто (status=open)", async () => {
  const { approvals, transport, next } = setup();

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  assert.equal(transport.sent[0].status, "open", "доставленное подтверждение ждёт кнопку");
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o1"] });
  await pendingOutcome;
});

test("подтверждения транзиентны: после снятия плагина не восстанавливаются", async () => {
  const { approvals, transport, next } = setup();
  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  assert.equal(approvals.pending.size, 1);

  approvals.dispose("detached");
  assert.equal(await pendingOutcome, "cancelled");
  assert.equal(approvals.pending.size, 0, "открытых подтверждений не осталось");
  assert.equal(approvals.stats.cancelled, 1, "снятие по dispose учтено в статистике");

  // Новый экземпляр (как после рестарта плагина) не знает про старый shortId:
  // позднее нажатие не решает ничего и не бросает.
  const restarted = createApprovals({ transport, registry: { resolve: () => ({ enabled: true }) }, log: () => {} });
  restarted.attach(fakeContext());
  assert.equal(restarted.pending.size, 0, "после рестарта очередь подтверждений пуста");
  restarted.handler; // экземпляр рабочий
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o1"] });
  await tick();
});

test("результат deliver give-up/aborted — «не доставили», next() в GUI", async () => {
  for (const result of ["give-up", "aborted", false]) {
    const transport = fakeTransport();
    const approvals = createApprovals({
      transport,
      registry: { resolve: () => ({ enabled: true }) },
      deliver: async () => result,
      log: () => {},
    });
    approvals.attach(fakeContext());
    const nextCalls = [];
    const outcome = await approvals.handler(request(), async () => {
      nextCalls.push(true);
      return "gui";
    });
    assert.equal(outcome, "gui", `deliver=${result} должен отдать GUI`);
    assert.equal(nextCalls.length, 1);
  }
});

test("неизвестная кнопка не решает подтверждение", async () => {
  const { approvals, transport, next } = setup();

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o99"] });
  await tick();
  assert.equal(transport.closed.length, 0, "неизвестная кнопка ничего не закрывает");

  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o2"] });
  assert.equal(await pendingOutcome, "rejected");
});

test("двойное нажатие: решение принимается один раз", async () => {
  const { approvals, transport, next } = setup();

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o1"] });
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o2"] });
  await tick();

  assert.equal(await pendingOutcome, "allowed-once");
  assert.equal(transport.closed.length, 1, "сообщение закрывается один раз");
});

test("запрос без toolName — не наш: next()", async () => {
  const { approvals, transport, next, nextCalls } = setup();

  const outcome = await approvals.handler({ agent: { id: "session-1" }, reason: "?" }, next);

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1);
  assert.equal(transport.sent.length, 0);
});

test("модель подтверждения: kind=approval и исходы из словаря DSH", () => {
  const approval = new RemoteApproval(request(), { now: 1_700_000_000_000 });

  assert.equal(approval.kind, "approval");
  assert.equal(approval.toolName, "Bash");
  assert.equal(approval.callId, "call-42");
  assert.match(approval.body, /Bash/);
  assert.equal(approval.allowFreeText, false, "свободного ответа у подтверждения нет");
  assert.equal(approval.multiSelect, false);
  assert.equal(approval.decide("allowed-always"), false, "исход вне словаря отвергается");
  assert.equal(approval.decide(APPROVAL_OUTCOME.allowedOnce), true);
  assert.equal(approval.decide(APPROVAL_OUTCOME.rejected), false, "повтор не переигрывает решение");
  assert.equal(approval.cancel("поздний аборт"), false, "решение человека не отменяется абортом");
  assert.equal(approval.outcome, APPROVAL_OUTCOME.allowedOnce);
});

test("фича approvals подключена в реестр фич", () => {
  assert.ok(features.some((feature) => feature.name === "approvals"), "в features.js нет фичи approvals");
});

test("снятие плагина отвечает cancelled на открытые подтверждения", async () => {
  const { approvals, transport, next } = setup();

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  approvals.dispose("detached");

  assert.equal(await pendingOutcome, "cancelled");
  assert.equal(transport.closed[0].summary, "Снято");
});

/** Журнал во временном каталоге + чтение строк. */
function auditInTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-approvals-audit-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "audit.jsonl");
  const audit = createAudit({ file, now: () => 1_700_000_000_000 });
  return { audit, file, read: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []) };
}

test("аудит: удалённое решение пишется с каналом, исходом и временем ожидания", async (t) => {
  const { audit, read } = auditInTemp(t);
  const { approvals, transport, next } = setup({ audit });

  const pendingOutcome = approvals.handler(request({ reason: "rm -rf /tmp/project" }), next);
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o1"], answeredBy: "user-7" });
  await pendingOutcome;

  const [record] = read();
  assert.equal(record.kind, "approval");
  assert.equal(record.toolName, "Bash");
  assert.equal(record.callId, "call-42");
  assert.equal(record.outcome, "allowed-once");
  assert.equal(record.decision, "remote");
  assert.equal(record.channel, "fake");
  assert.equal(record.answeredBy, "user-7");
  assert.equal(record.sessionId, "session-1");
  assert.equal(record.waitedMs, 0);
  assert.equal(JSON.stringify(record).includes("rm -rf"), false, "тело команды в журнал не попадает");
});

test("аудит: отданное GUI подтверждение видно как decision=gui", async (t) => {
  const { audit, read } = auditInTemp(t);
  const transport = fakeTransport({ failSend: true });
  const { approvals, next } = setup({ transport, audit });

  const outcome = await approvals.handler(request(), next);

  assert.equal(outcome, "gui");
  const [record] = read();
  assert.equal(record.decision, "gui");
  assert.equal(record.outcome, "unavailable");
  assert.equal(record.toolName, "Bash");
});

test("аудит: снятое без ответа подтверждение — decision=timeout, outcome=cancelled", async (t) => {
  const { audit, read } = auditInTemp(t);
  const { approvals, transport, next } = setup({ audit });
  const controller = new AbortController();

  const pendingOutcome = approvals.handler(request({ signal: controller.signal }), next);
  await tick();
  controller.abort();
  await pendingOutcome;

  const [record] = read();
  assert.equal(record.decision, "timeout");
  assert.equal(record.outcome, "cancelled");
  assert.equal(record.channel, "fake", "канал, где осталось сообщение, виден в журнале");
  assert.equal(transport.sent.length, 1);
});

test("аудит: dispose снимает открытые подтверждения и пишет timeout", async (t) => {
  const { audit, read } = auditInTemp(t);
  const { approvals, next } = setup({ audit });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  approvals.dispose("detached");
  await pendingOutcome;

  const records = read();
  assert.equal(records.length, 1);
  assert.equal(records[0].decision, "timeout");
  assert.equal(records[0].outcome, "cancelled");
});

test("аудит: транспорт без sendQuestion — decision=gui, запрос не отправлен", async (t) => {
  const { audit, read } = auditInTemp(t);
  const transport = { id: "no-send", onAnswer: () => () => {} };
  const { approvals, next, nextCalls } = setup({ transport, audit });

  const outcome = await approvals.handler(request(), next);

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1);
  const [record] = read();
  assert.equal(record.decision, "gui");
  assert.equal(record.outcome, "unavailable");
  assert.equal(record.toolName, "Bash");
  assert.equal(record.sessionId, "session-1", "синтетическая запись несёт маркировку сессии");
});

test("аудит: транспорт без onAnswer — decision=gui, в журнале и в статусе", async (t) => {
  const { audit, read } = auditInTemp(t);
  const transport = {
    id: "no-answers",
    sent: [],
    async sendQuestion(question) {
      transport.sent.push(question);
    },
    async closeQuestion() {},
  };
  const { approvals, next } = setup({ transport, audit });

  const outcome = await approvals.handler(request(), next);

  assert.equal(outcome, "gui");
  assert.equal(transport.sent.length, 0, "подтверждение без канала ответа не отправляем");
  const [record] = read();
  assert.equal(record.decision, "gui");
  assert.equal(record.outcome, "unavailable");
  assert.equal(record.callId, "call-42");
});

test("аудит: аборт на входе — decision=timeout, outcome=cancelled", async (t) => {
  const { audit, read } = auditInTemp(t);
  const { approvals, next } = setup({ audit });
  const controller = new AbortController();
  controller.abort();

  const outcome = await approvals.handler(request({ signal: controller.signal }), next);

  assert.equal(outcome, "cancelled");
  const [record] = read();
  assert.equal(record.decision, "timeout");
  assert.equal(record.outcome, "cancelled");
  assert.equal(record.toolName, "Bash");
});

/** Таймеры-двойники: тесты не ждут реальные секунды. */
function fakeTimers() {
  const timers = [];
  const cleared = [];
  let seq = 0;
  return {
    timers,
    cleared,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout(id) {
      cleared.push(id);
    },
    fire(index = 0) {
      const [timer] = timers.splice(index, 1);
      timer.fn();
    },
  };
}

test("гибрид (028): таймер → next() один раз, gui в аудите, сообщение «устарело»", async (t) => {
  const { audit, read } = auditInTemp(t);
  const timers = fakeTimers();
  const { approvals, transport, next, nextCalls } = setup({
    audit,
    timers,
    hybrid: { enabled: true, waitMs: 5_000 },
  });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  assert.equal(timers.timers.length, 1, "гибридный таймер взведён");
  assert.equal(timers.timers[0].ms, 5_000);

  timers.fire(0);
  const outcome = await pendingOutcome;

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1, "next() вызван ровно один раз");
  assert.equal(transport.closed[0].summary, "Устарело: запрос ушёл в GUI");
  const [record] = read();
  assert.equal(record.decision, "gui", "таймаут ушёл в GUI и попал в аудит");
  assert.equal(record.outcome, "unavailable");
  assert.equal(approvals.late.size, 1, "ждём поздний ответ для аудита");
});

test("гибрид: ответ до таймера — GUI не зовётся, таймер снят", async (t) => {
  const timers = fakeTimers();
  const { approvals, transport, next, nextCalls } = setup({
    timers,
    hybrid: { enabled: true, waitMs: 5_000 },
  });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  const timerId = timers.timers[0].id;
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o1"] });

  assert.equal(await pendingOutcome, "allowed-once");
  assert.equal(nextCalls.length, 0, "GUI не зовём");
  assert.deepEqual(timers.cleared, [timerId], "таймер снят");
  assert.equal(approvals.late.size, 0);
});

test("гибрид: поздний ответ после таймаута — аудит late, решение не меняется", async (t) => {
  const { audit, read } = auditInTemp(t);
  const timers = fakeTimers();
  const { approvals, transport, next, nextCalls } = setup({
    audit,
    timers,
    hybrid: { enabled: true, waitMs: 5_000 },
  });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  const shortId = transport.sent[0].shortId;
  timers.fire(0);
  assert.equal(await pendingOutcome, "gui");

  transport.answer({ shortId, optionIds: ["o2"], answeredBy: "user-9" });
  await tick();

  const records = read();
  assert.equal(records.length, 2);
  assert.equal(records[0].decision, "gui");
  assert.equal(records[1].decision, "late", "поздний ответ виден в аудите");
  assert.equal(records[1].outcome, "rejected", "исход нажатия сохранён как факт");
  assert.equal(records[1].answeredBy, "user-9");
  assert.equal(nextCalls.length, 1, "next() по-прежнему один");
  assert.equal(approvals.late.size, 0, "поздний ответ разобран");
});

test("гибрид выключен: таймеры не взводятся, поведение как в 024", async () => {
  const timers = fakeTimers();
  const { approvals, transport, next } = setup({ timers, hybrid: { enabled: false, waitMs: 5_000 } });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  assert.equal(timers.timers.length, 0, "без hybrid таймера нет");
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o1"] });
  assert.equal(await pendingOutcome, "allowed-once");
});

test("гибрид + недоступный транспорт: сразу GUI, таймер не нужен", async (t) => {
  const { audit, read } = auditInTemp(t);
  const timers = fakeTimers();
  const transport = fakeTransport({ failSend: true });
  const { approvals, next, nextCalls } = setup({
    transport,
    audit,
    timers,
    hybrid: { enabled: true, waitMs: 5_000 },
  });

  const outcome = await approvals.handler(request(), next);

  assert.equal(outcome, "gui");
  assert.equal(nextCalls.length, 1);
  assert.equal(timers.timers.length, 0, "доставлять нечего — таймер не взводим");
  assert.equal(read()[0].decision, "gui");
});

test("гибрид: выгрузка плагина снимает таймер", async () => {
  const timers = fakeTimers();
  const { approvals, next } = setup({ timers, hybrid: { enabled: true, waitMs: 5_000 } });

  const pendingOutcome = approvals.handler(request(), next);
  await tick();
  const timerId = timers.timers[0].id;
  approvals.dispose("detached");

  assert.equal(await pendingOutcome, "cancelled");
  assert.deepEqual(timers.cleared, [timerId]);
  assert.equal(approvals.pending.size, 0);
  assert.equal(approvals.late.size, 0);
});

test("конфиг гибрида: по умолчанию выключен, значения из строки плагина", () => {
  assert.deepEqual(hybridConfigFrom({}), { enabled: false, waitMs: 20_000 });
  assert.deepEqual(hybridConfigFrom({ approvals: {} }), { enabled: false, waitMs: 20_000 });
  assert.deepEqual(hybridConfigFrom({ approvals: { hybrid: true, hybridWaitMs: 1_234.9 } }), {
    enabled: true,
    waitMs: 1_234,
  });
  assert.deepEqual(hybridConfigFrom({ approvals: { hybrid: false, hybridWaitMs: -5 } }), {
    enabled: false,
    waitMs: 20_000,
  });
});
