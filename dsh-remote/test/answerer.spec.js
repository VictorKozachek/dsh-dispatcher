/**
 * Тесты ответчика waterfall'а `user-questions/request`.
 *
 * Фейковый `ctx` повторяет то, что важно из cordis: `on(event, handler, options)`
 * с `prepend` (unshift) и водопад «outermost-first», где `next()` сдвигает
 * очередь. Фейковый транспорт отдаёт ответ через `onAnswer`, как будет делать
 * настоящий (задача 003). Сети и DSH здесь нет.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { apply } from "../lib/index.js";
import { createAnswerer } from "../lib/answerer.js";
import { createRegistry } from "../lib/domain/registry.js";
import { QUESTION_STATUS } from "../lib/domain/question.js";

const EVENT = "user-questions/request";

/** Дать отработать микрозадачам: слушатель успевает дойти до ожидания ответа. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Контекст в объёме, который нужен ответчику: `on`, `get`, `effect`. */
function fakeContext({ services = {} } = {}) {
  const hooks = new Map();
  const effects = [];

  return {
    hooks,
    effects,
    get(service) {
      return Object.hasOwn(services, service) ? services[service] : undefined;
    },
    on(event, handler, options) {
      const list = hooks.get(event) ?? [];
      const entry = { handler, options };
      if (options?.prepend === true) list.unshift(entry);
      else list.push(entry);
      hooks.set(event, list);
      return () => {
        const current = hooks.get(event) ?? [];
        const index = current.findIndex((item) => item.handler === handler);
        if (index >= 0) current.splice(index, 1);
      };
    },
    effect(execute, label) {
      const disposable = execute();
      effects.push({ label, disposable });
      return () => {
        if (typeof disposable === "function") disposable();
      };
    },
  };
}

/** Водопад cordis: слушатели outermost-first, `next()` идёт по очереди к fallback. */
function runWaterfall(ctx, event, request, fallback) {
  const handlers = [...(ctx.hooks.get(event) ?? [])].map((entry) => entry.handler);
  const next = () => {
    const handler = handlers.shift();
    return handler === undefined ? fallback() : handler(request, next);
  };
  return next();
}

/** Транспорт-пустышка: записывает отправку и закрытие, ответ приходит через `onAnswer`. */
function fakeTransport({ failSendAt = 0 } = {}) {
  const state = { sent: [], closed: [], sendCalls: 0, subscriber: null };

  return {
    id: "fake",
    get sent() {
      return state.sent;
    },
    get closed() {
      return state.closed;
    },
    get sendCalls() {
      return state.sendCalls;
    },
    get subscribed() {
      return state.subscriber !== null;
    },
    sendQuestion(question) {
      state.sendCalls += 1;
      if (failSendAt !== 0 && state.sendCalls === failSendAt) throw new Error("транспорт недоступен");
      state.sent.push(question);
    },
    closeQuestion(question, reason) {
      state.closed.push({ question, reason });
    },
    onAnswer(handler) {
      state.subscriber = handler;
      return () => {
        state.subscriber = null;
      };
    },
    answer(event) {
      assert.ok(state.subscriber !== null, "ответчик не подписан на onAnswer");
      state.subscriber(event);
    },
  };
}

/** Вопрос запроса DSH в минимальном виде. */
function item(overrides = {}) {
  return {
    id: "q1",
    question: "Продолжать деплой?",
    options: [{ label: "Да" }, { label: "Нет" }],
    ...overrides,
  };
}

/** Запрос со включённым режимом: сессия s1 в воркспейсе /p. */
function request(overrides = {}) {
  return { questions: [item()], agent: { id: "s1" }, ...overrides };
}

/** Ответчик с включённым режимом и подменёнными часами. */
function setup({ transport = fakeTransport(), enabled = true, logs = [] } = {}) {
  const ctx = fakeContext({ services: { sessions: { get: () => ({ cwd: "/p" }) } } });
  const registry = createRegistry({
    readState: () => (enabled ? { global: true } : {}),
  });
  const answerer = createAnswerer({
    transport,
    registry,
    log: (message) => logs.push(message),
    now: () => 1_000,
  });
  return { ctx, transport, answerer, logs };
}

test("слушатель регистрируется с prepend и обгоняет уже зарегистрированный GUI", async () => {
  const { ctx, transport, answerer } = setup();
  let guiCalled = 0;
  // Мост api-remotes: зарегистрирован раньше любого плагина профиля.
  ctx.on(EVENT, async (_request, next) => {
    guiCalled += 1;
    return next();
  });

  answerer.attach(ctx);

  const list = ctx.hooks.get(EVENT);
  assert.equal(list[0].options?.prepend, true, "наш слушатель стоит первым — prepend: true");
  assert.equal(list.length, 2);

  const pending = runWaterfall(ctx, EVENT, request(), () => ({ answers: [{ id: "q1", selected: ["GUI"] }] }));
  await tick();

  assert.equal(transport.sent.length, 1, "вопрос забрал наш слушатель");
  assert.equal(guiCalled, 0, "GUI-мост не вызывался: next() не звали");

  transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1" });
  const result = await pending;
  assert.deepEqual(result, { answers: [{ id: "q1", selected: ["Да"] }] });
  assert.equal(guiCalled, 0);
});

test("режим выключен — next() вызван, транспорт не тронут", async () => {
  const { ctx, transport, answerer } = setup({ enabled: false });
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request(), () => ({ answers: [{ id: "q1", selected: ["GUI"] }] }));
  const result = await pending;

  assert.deepEqual(result, { answers: [{ id: "q1", selected: ["GUI"] }] });
  assert.equal(transport.sendCalls, 0, "вопрос остался в GUI");
});

test("ответ кнопкой возвращается в форме AskUserQuestionAnswer", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request(), () => assert.fail("next() не должен вызываться"));
  await tick();
  assert.equal(transport.sent.length, 1);

  transport.answer({ shortId: transport.sent[0].shortId, optionId: "o2", answeredBy: "u7" });
  const result = await pending;

  assert.deepEqual(result, { answers: [{ id: "q1", selected: ["Нет"] }] }, "id — вызывающего, selected — метки");
  assert.equal(transport.sent[0].answeredBy, "u7");
  assert.equal(transport.sent[0].status, QUESTION_STATUS.answered);
});

test("свободный текст уходит как custom", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request(), () => assert.fail("next() не должен вызываться"));
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, text: "  давай позже " });
  const result = await pending;

  assert.deepEqual(result, { answers: [{ id: "q1", selected: [], custom: "давай позже" }] });
});

test("одиночный вопрос: текст заменяет выбранный вариант, как в GUI", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request(), () => assert.fail("next() не должен вызываться"));
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1", text: "своё" });
  const result = await pending;

  assert.deepEqual(result, { answers: [{ id: "q1", selected: [], custom: "своё" }] });
});

test("multiSelect: несколько кнопок едут в selected", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request({ questions: [item({ multiSelect: true })] }), () => assert.fail("next()"));
  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionIds: ["o1", "o2"] });
  const result = await pending;

  assert.deepEqual(result, { answers: [{ id: "q1", selected: ["Да", "Нет"] }] });
});

test("аборт request.signal: сообщение закрыто, вопрос cancelled, промис отклонён", async () => {
  const { ctx, transport, answerer, logs } = setup();
  answerer.attach(ctx);

  const controller = new AbortController();
  const pending = runWaterfall(ctx, EVENT, request({ signal: controller.signal }), () => assert.fail("next()"));
  await tick();
  assert.equal(transport.sent.length, 1);

  controller.abort();

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(transport.sent[0].status, QUESTION_STATUS.cancelled);
  assert.equal(transport.closed.length, 1, "сообщение в мессенджере закрыто");
  assert.equal(transport.closed[0].reason, "aborted");
  assert.match(logs.join("\n"), /режим|ответ/);
});

test("два вопроса в одном запросе не путаются", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);

  const questions = [item({ id: "q1" }), item({ id: "q2", options: [{ label: "Раз" }, { label: "Два" }] })];
  const pending = runWaterfall(ctx, EVENT, request({ questions }), () => assert.fail("next()"));
  await tick();
  assert.equal(transport.sent.length, 2);

  const [first, second] = transport.sent;
  transport.answer({ shortId: second.shortId, optionId: "o2" });
  transport.answer({ shortId: first.shortId, optionId: "o1" });

  const result = await pending;
  assert.deepEqual(result.answers, [
    { id: "q1", selected: ["Да"] },
    { id: "q2", selected: ["Два"] },
  ]);
});

test("второй ответ на тот же вопрос ничего не перезаписывает", async () => {
  const { ctx, transport, answerer, logs } = setup();
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request(), () => assert.fail("next()"));
  await tick();
  const { shortId } = transport.sent[0];

  transport.answer({ shortId, optionId: "o1" });
  transport.answer({ shortId, optionId: "o2" });

  const result = await pending;
  assert.deepEqual(result.answers, [{ id: "q1", selected: ["Да"] }], "первый ответ остался");
  assert.match(logs.join("\n"), /уже отвечен или закрыт/);
});

test("ответ на неизвестный shortId игнорируется", async () => {
  const { ctx, transport, answerer, logs } = setup();
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request(), () => assert.fail("next()"));
  await tick();
  transport.answer({ shortId: "deadbeef", optionId: "o1" });
  assert.match(logs.join("\n"), /вопроса нет/);

  transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1" });
  await pending;
});

test("транспорт без onAnswer: warn и слушатель не регистрируется", () => {
  const logs = [];
  const ctx = fakeContext();
  const transport = {
    sendQuestion() {
      throw new Error("не должен вызываться");
    },
    closeQuestion() {},
  };
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({ transport, registry, log: (message) => logs.push(message) });

  const detach = answerer.attach(ctx);

  assert.deepEqual(ctx.hooks.get(EVENT) ?? [], [], "водопад не тронут — вопрос уйдёт в GUI");
  assert.match(logs.join("\n"), /нет onAnswer/);
  assert.equal(typeof detach, "function");
  detach();
});

test("ошибка отправки: сообщения закрыты, вопрос отдан GUI через next()", async () => {
  const logs = [];
  const { ctx, transport, answerer } = setup({ transport: fakeTransport({ failSendAt: 1 }), logs });
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request(), () => ({ answers: [{ id: "q1", selected: ["GUI"] }] }));
  const result = await pending;

  assert.deepEqual(result, { answers: [{ id: "q1", selected: ["GUI"] }] });
  assert.equal(transport.closed.length, 1);
  assert.equal(transport.closed[0].reason, "send-failed");
  assert.match(logs.join("\n"), /доставить не удалось/);
});

test("пустой список вопросов — next(): это ошибка ядра, не наша", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, { questions: [], agent: { id: "s1" } }, () => "empty");
  assert.equal(await pending, "empty");
  assert.equal(transport.sendCalls, 0);
});

test("режим выбирается по воркспейсу сессии из ctx.sessions", async () => {
  const ctx = fakeContext({ services: { sessions: { get: () => ({ cwd: "/p" }) } } });
  const transport = fakeTransport();
  const registry = createRegistry({ readState: () => ({ workspaces: { "/p": true } }) });
  const answerer = createAnswerer({ transport, registry, now: () => 1_000 });
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request(), () => assert.fail("next()"));
  await tick();
  assert.equal(transport.sent.length, 1, "воркспейс /p включён — вопрос ушёл в транспорт");
  assert.equal(transport.sent[0].workspace, "/p", "воркспейс попал в модель");

  transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1" });
  await pending;
});

test("dispose закрывает ожидание и сообщение, промис отклоняется", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request(), () => assert.fail("next()"));
  await tick();
  answerer.dispose("plugin-disposed");

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(transport.closed.length, 1);
  assert.equal(transport.sent[0].status, QUESTION_STATUS.cancelled);
});

test("detach снимает слушатель и подписку на ответы", async () => {
  const { ctx, transport, answerer } = setup();
  const detach = answerer.attach(ctx);
  assert.equal(transport.subscribed, true);
  assert.equal((ctx.hooks.get(EVENT) ?? []).length, 1);

  detach();

  assert.equal(transport.subscribed, false);
  assert.equal((ctx.hooks.get(EVENT) ?? []).length, 0);
});

test("фича answerer из реестра: с транспортом слушатель поднимается каркасом", () => {
  const transport = fakeTransport();
  const ctx = fakeContext({ services: { remoteTransport: transport } });

  apply(ctx, {}); // каркас прогоняет реестр фич из lib/features.js

  const list = ctx.hooks.get(EVENT) ?? [];
  assert.equal(list.length, 1, "ответчик подписан на waterfall");
  assert.equal(list[0].options?.prepend, true, "и стоит первым");
  assert.equal(transport.subscribed, true, "и слушает ответы транспорта");

  // Выгрузка плагина: disposer эффекта снимает подписку на вопрос и на ответы.
  for (const { disposable } of ctx.effects) {
    if (typeof disposable === "function") disposable();
  }
  assert.equal((ctx.hooks.get(EVENT) ?? []).length, 0);
  assert.equal(transport.subscribed, false);
});

test("фича answerer без транспорта не поднимается: вопрос уходит в GUI", () => {
  const ctx = fakeContext();

  assert.doesNotThrow(() => apply(ctx, {}));

  assert.equal((ctx.hooks.get(EVENT) ?? []).length, 0, "без транспорта слушателя нет");
});
