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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  const ctx = fakeContext({ services: { sessions: { get: () => ({ header: { cwd: "/p" } }) } } });
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

test("аборт во время sendQuestion: не ждём отправку, отклоняемся, закрываем опубликованное", async () => {
  const closed = [];
  const sent = [];
  const transport = {
    sendQuestion(question) {
      sent.push(question);
      if (question.questionId === "q1") {
        return new Promise(() => {
          /* отправка первого «зависла»: именно этот случай ломал обработчик */
        });
      }
      return Promise.resolve();
    },
    closeQuestion(question, reason) {
      closed.push({ question, reason });
    },
    onAnswer() {
      return () => {};
    },
  };
  const ctx = fakeContext();
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const watched = [];
  const unwatched = [];
  const reliability = {
    watch: (question) => { watched.push(question.questionId); },
    unwatch: (ids) => { unwatched.push(...(Array.isArray(ids) ? ids : [ids])); },
  };
  const answerer = createAnswerer({ transport, registry, reliability, now: () => 1_000 });
  answerer.attach(ctx);

  const controller = new AbortController();
  const pending = runWaterfall(ctx, EVENT, {
    questions: [item({ id: "q1" }), item({ id: "q2" })],
    agent: { id: "s1" },
    signal: controller.signal,
  }, () => assert.fail("next() не должен вызываться"));
  await tick();
  assert.equal(sent.length, 1, "037: второй вопрос не публикуется до ответа на первый");
  assert.deepEqual(watched, ["q1"], "TTL-сторож только у опубликованного вопроса");
  assert.equal(answerer.pending.size, 1, "pending только у опубликованного");

  controller.abort();

  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(closed.length, 1, "закрыт уже опубликованный вопрос");
  assert.deepEqual(closed.map((item) => item.question.questionId), ["q1"]);
  assert.equal(sent[0].status, QUESTION_STATUS.cancelled);
  assert.equal(answerer.pending.size, 0, "после аборта висящих ожиданий нет");
  assert.deepEqual(watched, ["q1"], "неопубликованный вопрос не попал под TTL");
  assert.equal(unwatched.length >= 1, true, "сторож снят");
});

test("два вопроса в одном запросе задаются последовательно и не путаются", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);

  const questions = [item({ id: "q1" }), item({ id: "q2", options: [{ label: "Раз" }, { label: "Два" }] })];
  const pending = runWaterfall(ctx, EVENT, request({ questions }), () => assert.fail("next()"));
  await tick();
  assert.equal(transport.sent.length, 1, "сначала только вопрос 1");
  assert.equal(transport.sent[0].index, 1, "шапка: вопрос 1/2");
  assert.equal(transport.sent[0].total, 2);

  // Отвечаем на первый — только теперь появляется второй с корректным номером.
  transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1" });
  await tick();
  assert.equal(transport.sent.length, 2, "после ответа отправлен вопрос 2");
  assert.equal(transport.sent[1].index, 2, "шапка: вопрос 2/2");
  assert.equal(transport.sent[1].total, 2);
  assert.equal(transport.sent[1].questionId, "q2");

  transport.answer({ shortId: transport.sent[1].shortId, optionId: "o2" });

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
  // 012: повторный ответ — уже «поздний», в логе видно, из какого канала он пришёл.
  assert.match(logs.join("\n"), /вопрос уже отвечен/);
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
  const ctx = fakeContext({ services: { sessions: { get: () => ({ header: { cwd: "/p" } }) } } });
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

test("фича answerer из реестра: с транспортом слушатель поднимается каркасом", async () => {
  const transport = fakeTransport();
  const ctx = fakeContext({ services: { remoteTransport: transport } });

  await apply(ctx, {}); // каркас прогоняет реестр фич из lib/features.js (apply async)

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

test("фича answerer без живого канала: подписка есть, вопрос уходит в GUI", async () => {
  const ctx = fakeContext();

  await assert.doesNotReject(() => apply(ctx, {}));

  // Фасад транспорта команды создают сразу (он же точка подключения), поэтому
  // ответчик подписан; но канала внутри нет — и запрос обязан уйти в GUI.
  const list = ctx.hooks.get(EVENT) ?? [];
  assert.equal(list.length, 1, "ответчик подписан на waterfall");

  let delegated = 0;
  const controller = new AbortController();
  const outcome = await list[0].handler(
    { questions: [{ id: "q1", question: "Продолжать?" }], agent: { id: "s" }, signal: controller.signal },
    async () => { delegated += 1; return { answers: [{ id: "q1", selected: ["GUI"] }] }; },
  );
  assert.equal(delegated, 1, "без канала вызывается next() — вопрос уходит в GUI");
  assert.deepEqual(outcome.answers, [{ id: "q1", selected: ["GUI"] }]);
});

test("вопрос получает роль и задачу из контекста сессии (006)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-ctx-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".kanban", "tasks"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".kanban", "tasks", "006.md"),
    "---\nid: \"006\"\nstatus: in-progress\nowner: session-ctx\n---\n",
  );

  const transport = fakeTransport();
  const ctx = fakeContext({ services: { sessions: { get: () => ({ header: { cwd: dir, agentPreset: "worker" } }) } } });
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({ transport, registry, log: () => {}, now: () => 1_000 });
  answerer.attach(ctx);

  const controller = new AbortController();
  const pending = runWaterfall(ctx, EVENT, {
    questions: [item()],
    agent: { id: "session-ctx" },
    signal: controller.signal,
  }, () => assert.fail("next() звать нельзя"));
  await tick();

  const question = transport.sent[0];
  assert.equal(question.workspace, dir);
  assert.equal(question.role, "worker");
  assert.equal(question.taskId, "006");

  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("служебные кнопки free/more не ломают вопрос (006)", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);

  const pending = runWaterfall(ctx, EVENT, request(), () => assert.fail("next()"));
  await tick();
  const { shortId } = transport.sent[0];

  // «Другой ответ…» — не ответ: вопрос остаётся открытым, ответа нет.
  transport.answer({ shortId, optionIds: ["free"] });
  assert.equal(transport.sent[0].isOpen, true, "после «Другого ответа» вопрос открыт");

  // «Показать ещё» — тоже не ответ.
  transport.answer({ shortId, optionIds: ["more"] });
  assert.equal(transport.sent[0].isOpen, true);

  // Свободный текст, пришедший следом, засчитывается.
  transport.answer({ shortId, text: "своё" });
  const result = await pending;
  assert.deepEqual(result.answers, [{ id: "q1", selected: [], custom: "своё" }]);
});

// --- 044: быстрые ответы для вопросов без вариантов -------------------------

test("044: быстрая кнопка возвращает custom с человекочитаемым текстом", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);
  const pending = runWaterfall(ctx, EVENT, request({
    questions: [item({ id: "q-free", question: "Продолжать?", options: [] })],
  }), () => assert.fail("next()"));

  await tick();
  const sent = transport.sent[0];
  assert.deepEqual(sent.quickReplies.map((entry) => entry.label), ["Да", "Нет", "Отложить", "Решай сам"]);

  transport.answer({ shortId: sent.shortId, optionId: "q1" });
  const result = await pending;
  assert.deepEqual(result.answers, [{ id: "q-free", selected: [], custom: "Да" }]);
});

test("044: «Решай сам» возвращает понятный модели текст, а не id кнопки", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);
  const pending = runWaterfall(ctx, EVENT, request({
    questions: [item({ id: "q-delegate", options: [] })],
  }), () => assert.fail("next()"));

  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionId: "q4" });
  const result = await pending;
  assert.equal(result.answers[0].custom, "Реши сам, я делегирую");
  assert.equal(/q4/.test(JSON.stringify(result)), false, "внутренний id не утёк в ответ");
});

test("044: конфиг переопределяет набор, пустой — выключает кнопки", async () => {
  const custom = setup();
  const answerer = (await import("../lib/answerer.js")).createAnswerer({
    transport: custom.transport,
    registry: createRegistry({ readState: () => ({ global: true }) }),
    quickReplies: [{ label: "Ок", text: "Хорошо" }],
    now: () => 1_000,
  });
  answerer.attach(custom.ctx);
  const pending = runWaterfall(custom.ctx, EVENT, request({
    questions: [item({ id: "q-custom", options: [] })],
  }), () => assert.fail("next()"));
  await tick();
  assert.deepEqual(custom.transport.sent[0].quickReplies.map((entry) => entry.label), ["Ок"]);
  custom.transport.answer({ shortId: custom.transport.sent[0].shortId, optionId: "q1" });
  const result = await pending;
  assert.equal(result.answers[0].custom, "Хорошо");

  const disabled = setup();
  const emptyAnswerer = (await import("../lib/answerer.js")).createAnswerer({
    transport: disabled.transport,
    registry: createRegistry({ readState: () => ({ global: true }) }),
    quickReplies: [],
    now: () => 1_000,
  });
  emptyAnswerer.attach(disabled.ctx);
  const emptyPending = runWaterfall(disabled.ctx, EVENT, request({
    questions: [item({ id: "q-empty", options: [] })],
  }), () => assert.fail("next()"));
  await tick();
  assert.deepEqual(disabled.transport.sent[0].quickReplies, [], "пустой набор — кнопок нет");

  // Кнопки нет — «нажатие» q1 игнорируется, вопрос остаётся открытым.
  disabled.transport.answer({ shortId: disabled.transport.sent[0].shortId, optionId: "q1" });
  await tick();
  assert.equal(disabled.transport.sent[0].status, QUESTION_STATUS.open);
  disabled.transport.answer({ shortId: disabled.transport.sent[0].shortId, text: "текстом" });
  const emptyResult = await emptyPending;
  assert.equal(emptyResult.answers[0].custom, "текстом");
});

test("044: вопрос с вариантами не получает быстрых кнопок", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);
  const pending = runWaterfall(ctx, EVENT, request({
    questions: [item({ id: "q-options", options: [{ label: "Да" }, { label: "Нет" }] })],
  }), () => assert.fail("next()"));
  await tick();
  const sent = transport.sent[0];
  assert.equal(sent.quickReplies.length, 4, "набор хранится в модели, но не рендерится");
  assert.equal(rowsFor(sent).some((row) => row.some((button) => button.kind === "quick")), false);

  transport.answer({ shortId: sent.shortId, optionId: "o1" });
  const result = await pending;
  assert.deepEqual(result.answers, [{ id: "q-options", selected: ["Да"] }]);
});

function rowsFor(question) {
  // Локальный аналог renderRows для проверки: вопрос с вариантами даёт option-кнопки.
  return (question.options ?? []).map((option) => [{ kind: "option", optionId: option.id, label: option.label }]);
}

// --- 037: пачка вопросов публикуется последовательно ------------------------

test("037: ответ на ещё не опубликованный вопрос игнорируется, пачка завершается", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);

  const questions = [item({ id: "q1" }), item({ id: "q2", options: [{ label: "Раз" }, { label: "Два" }] })];
  const pending = runWaterfall(ctx, EVENT, request({ questions }), () => assert.fail("next()"));
  await tick();
  assert.equal(transport.sent.length, 1);

  // «Ответ» на второй вопрос до его публикации: shortId неизвестен — игнор.
  transport.answer({ shortId: "deadbeef", optionId: "o2" });
  await tick();
  assert.equal(transport.sent.length, 1, "второй вопрос всё ещё не опубликован");
  assert.equal(transport.sent[0].status, QUESTION_STATUS.open, "первый не тронут чужим ответом");

  transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1" });
  await tick();
  assert.equal(transport.sent.length, 2);

  transport.answer({ shortId: transport.sent[1].shortId, optionId: "o2" });
  const result = await pending;
  assert.deepEqual(result.answers, [
    { id: "q1", selected: ["Да"] },
    { id: "q2", selected: ["Два"] },
  ]);
});

test("037: аборт после ответа на первый снимает опубликованный второй", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);
  const controller = new AbortController();
  const pending = runWaterfall(ctx, EVENT, request({
    questions: [item({ id: "q1" }), item({ id: "q2" })],
    signal: controller.signal,
  }), () => assert.fail("next()"));

  await tick();
  transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1" });
  await tick();
  assert.equal(transport.sent.length, 2, "второй опубликован после первого ответа");

  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  const closedIds = transport.closed.map((entry) => entry.question.questionId);
  assert.ok(closedIds.includes("q2"), "опубликованный второй закрыт");
  assert.equal(transport.sent[1].status, QUESTION_STATUS.cancelled);
});

test("037: TTL второго вопроса не тикает до его публикации", async () => {
  const { ctx, transport, answerer } = setup();
  // Пересоздаём ответчик с наблюдаемой устойчивостью: нужен факт watch().
  const watched = [];
  const watchedAnswerer = (await import("../lib/answerer.js")).createAnswerer({
    transport,
    registry: createRegistry({ readState: () => ({ global: true }) }),
    reliability: { watch: (question) => watched.push(question.questionId), unwatch: () => {} },
    now: () => 1_000,
  });
  watchedAnswerer.attach(ctx);
  void answerer;

  const pending = runWaterfall(ctx, EVENT, request({
    questions: [item({ id: "q1" }), item({ id: "q2" })],
  }), () => assert.fail("next()"));
  await tick();
  assert.deepEqual(watched, ["q1"], "q2 не под TTL, пока не опубликован");
  assert.equal(watchedAnswerer.pending.size, 1);

  transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1" });
  await tick();
  assert.deepEqual(watched, ["q1", "q2"], "q2 под TTL только после публикации");
  transport.answer({ shortId: transport.sent[1].shortId, optionId: "o1" });
  await pending;
});

test("037: ответ по реальному shortId q2 до публикации игнорируется", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);
  const pending = runWaterfall(ctx, EVENT, request({
    questions: [item({ id: "q1" }), item({ id: "q2" })],
  }), () => assert.fail("next()"));
  await tick();
  assert.equal(transport.sent.length, 1);

  const q2 = [...answerer.known.values()].find((question) => question.questionId === "q2");
  assert.ok(q2, "q2 создан и известен");
  transport.answer({ shortId: q2.shortId, optionId: "o1" });
  await tick();
  assert.equal(transport.sent.length, 1, "q2 всё ещё не опубликован");
  assert.equal(q2.status, QUESTION_STATUS.pending, "ответ по q2 до публикации не принят");
  assert.equal(q2.answer, undefined);

  transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1" });
  await tick();
  assert.equal(transport.sent.length, 2);
  transport.answer({ shortId: transport.sent[1].shortId, optionId: "o1" });
  const result = await pending;
  assert.equal(result.answers.length, 2, "обе части ответа в результате, висящих промисов нет");
  assert.equal(answerer.pending.size, 0);
});

test("037: свободный текст без shortId при одном открытом вопросе принимается", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);
  const pending = runWaterfall(ctx, EVENT, request({
    questions: [item({ id: "q1", question: "Что дальше?", options: [] })],
  }), () => assert.fail("next()"));

  await tick();
  assert.equal(transport.sent.length, 1);
  // Текст без reply/shortId: открыт ровно один вопрос — это его ответ.
  transport.answer({ text: "деплой в пятницу" });

  const result = await pending;
  assert.deepEqual(result.answers, [{ id: "q1", selected: [], custom: "деплой в пятницу" }]);
});

test("037: свободный текст без shortId после публикации второго вопроса идёт ему", async () => {
  const { ctx, transport, answerer } = setup();
  answerer.attach(ctx);
  const pending = runWaterfall(ctx, EVENT, request({
    questions: [item({ id: "q1", options: [] }), item({ id: "q2", options: [] })],
  }), () => assert.fail("next()"));
  await tick();
  assert.equal(transport.sent.length, 1);

  // Пока открыт только первый — текст без reply однозначно его.
  transport.answer({ text: "первому" });
  await tick();
  assert.equal(transport.sent.length, 2, "после ответа опубликован второй");

  transport.answer({ text: "второму" });
  const result = await pending;
  assert.deepEqual(result.answers.map((answer) => answer.custom), ["первому", "второму"]);
});
