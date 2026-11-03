/**
 * Тесты брокера каналов (012): один вопрос — несколько транспортов, первый ответ
 * побеждает. Без сети: транспорты фейковые, ответы эмулируются вручную.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ANSWERED_ELSEWHERE,
  ANSWERED_ELSEWHERE_TEXT,
  createBroker,
} from "../lib/broker.js";
import { createAnswerer } from "../lib/answerer.js";
import { createQuestion } from "../lib/domain/question.js";
import { createRegistry } from "../lib/domain/registry.js";

/** Фейковый транспорт по контракту 004. */
function fakeTransport(id, { failSend = false } = {}) {
  const handlers = [];
  const sent = [];
  const closed = [];
  const edited = [];
  const calls = { send: 0, close: 0, edit: 0 };
  const transport = {
    id,
    caps: { inlineButtons: true, editAfterAnswer: true, maxText: 4000, maxOptions: 8 },
    sent,
    closed,
    edited,
    calls,
    async sendQuestion(question) {
      calls.send += 1;
      if (failSend) throw new Error(`${id}: нет связи`);
      sent.push(question);
      return { messageId: `${id}-mid` };
    },
    async editQuestion(question, text) {
      calls.edit += 1;
      edited.push({ question, text });
      return true;
    },
    async closeQuestion(question, summary) {
      calls.close += 1;
      closed.push({ question, summary });
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
      return { ok: true, detail: `${id} на связи` };
    },
  };
  return transport;
}

function makeQuestion(overrides = {}) {
  const question = createQuestion({
    id: "q1",
    question: "Продолжать?",
    options: [{ label: "Да" }, { label: "Нет" }],
  }, { now: 0, workspace: "/p" });
  question.markOpen(0);
  Object.assign(question, overrides);
  return question;
}

const tick = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("publish: вопрос уходит во все каналы, доставки пишутся в модель", async () => {
  const telegram = fakeTransport("telegram");
  const max = fakeTransport("max");
  const broker = createBroker({ transports: [telegram, max] });
  const question = makeQuestion();

  const publication = await broker.publish(question);

  assert.deepEqual(publication.delivered.map((item) => item.id), ["telegram", "max"]);
  assert.equal(publication.anyDelivered, true);
  assert.equal(publication.allFailed, false);
  assert.deepEqual(question.deliveries, [
    { transport: "telegram", messageId: "telegram-mid", chatId: null },
    { transport: "max", messageId: "max-mid", chatId: null },
  ]);
});

test("publish: падение одного канала не мешает второму", async () => {
  const broken = fakeTransport("telegram", { failSend: true });
  const max = fakeTransport("max");
  const logs = [];
  const broker = createBroker({ transports: [broken, max], log: (message) => logs.push(message) });
  const question = makeQuestion();

  const publication = await broker.publish(question);

  assert.equal(publication.anyDelivered, true, "вопрос живой: доставили хотя бы в один");
  assert.deepEqual(publication.delivered.map((item) => item.id), ["max"]);
  assert.equal(publication.failed.length, 1);
  assert.match(logs.join("\n"), /канал telegram не доставил/);
  assert.deepEqual(question.deliveries.map((item) => item.transport), ["max"]);
});

test("publish: ни один канал не принял — allFailed", async () => {
  const broker = createBroker({
    transports: [fakeTransport("telegram", { failSend: true }), fakeTransport("max", { failSend: true })],
  });
  const question = makeQuestion();

  const publication = await broker.publish(question);

  assert.equal(publication.anyDelivered, false);
  assert.equal(publication.allFailed, true);
  assert.deepEqual(question.deliveries, []);
});

test("closeAll: победитель получает ответ, проигравший — пометку и снятые кнопки", async () => {
  const telegram = fakeTransport("telegram");
  const max = fakeTransport("max");
  const broker = createBroker({ transports: [telegram, max] });
  const question = makeQuestion();
  await broker.publish(question);

  await broker.closeAll(question, { winner: telegram, summary: "Да" });

  assert.deepEqual(telegram.closed.map((item) => item.summary), ["Да"], "победитель закрыт с ответом");
  assert.equal(max.edited.at(-1).text, ANSWERED_ELSEWHERE_TEXT, "проигравший получил пометку");
  assert.deepEqual(max.closed.map((item) => item.summary), [ANSWERED_ELSEWHERE], "кнопки сняты тихой причиной");
});

test("closeAll: без победителя (аборт) все каналы закрываются одной причиной", async () => {
  const telegram = fakeTransport("telegram");
  const max = fakeTransport("max");
  const broker = createBroker({ transports: [telegram, max] });
  const question = makeQuestion();
  await broker.publish(question);

  await broker.closeAll(question, { winner: null, summary: "aborted" });

  assert.deepEqual(telegram.closed.map((item) => item.summary), ["aborted"]);
  assert.deepEqual(max.closed.map((item) => item.summary), ["aborted"]);
  assert.equal(max.edited.length, 0, "пометки «в другом канале» нет: это не гонка ответов");
});

// --- ответчик с двумя каналами ---------------------------------------------

function setupAnswerer() {
  const telegram = fakeTransport("telegram");
  const max = fakeTransport("max");
  const logs = [];
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({
    transports: [telegram, max],
    registry,
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
  return { telegram, max, answerer, logs };
}

const REQUEST = { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] }], agent: { id: "s1" } };

test("ответчик: первый ответ побеждает, второй канал закрывается пометкой", async () => {
  const { telegram, max, answerer } = setupAnswerer();

  const pending = answerer.handler(REQUEST, () => assert.fail("next() нельзя"));
  await tick();
  const shortId = telegram.sent[0].shortId;
  assert.equal(max.sent[0].shortId, shortId, "вопрос ушёл в оба канала");

  telegram.answer({ shortId, optionId: "o1" });
  const result = await pending;

  assert.deepEqual(result.answers, [{ id: "q1", selected: ["Да"] }]);
  assert.deepEqual(telegram.closed.map((item) => item.summary), ["Да"], "победитель — с ответом");
  assert.equal(max.edited.at(-1).text, ANSWERED_ELSEWHERE_TEXT);
  assert.deepEqual(max.closed.map((item) => item.summary), [ANSWERED_ELSEWHERE]);
});

test("ответчик: поздний ответ проигравшего канала игнорируется и логируется", async () => {
  const { telegram, max, answerer, logs } = setupAnswerer();

  const pending = answerer.handler(REQUEST, () => assert.fail("next() нельзя"));
  await tick();
  const shortId = telegram.sent[0].shortId;

  telegram.answer({ shortId, optionId: "o1" });
  const result = await pending;

  max.answer({ shortId, optionId: "o2" }); // человек нажал в MAX уже после ответа
  await tick();

  assert.deepEqual(result.answers, [{ id: "q1", selected: ["Да"] }], "решение не изменилось");
  assert.match(logs.join("\n"), /из канала max проигнорирован/);
  assert.match(logs.join("\n"), /уже отвечен в telegram/);
});

test("ответчик: оба канала молчат/падают — вопрос уходит в GUI (next)", async () => {
  const telegram = fakeTransport("telegram", { failSend: true });
  const max = fakeTransport("max", { failSend: true });
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({ transports: [telegram, max], registry, log: () => {}, now: () => 0 });

  let nextCalls = 0;
  const result = await answerer.handler(REQUEST, () => {
    nextCalls += 1;
    return { answers: [] };
  });

  assert.equal(nextCalls, 1, "ни один канал не доставил — GUI");
  assert.deepEqual(result, { answers: [] });
});

// --- регрессии по ревью 012 -------------------------------------------------

test("publish: зависший канал обрезается таймаутом и не блокирует второй", async () => {
  const hung = fakeTransport("max");
  hung.sendQuestion = () => new Promise(() => {});
  const telegram = fakeTransport("telegram");
  const timers = [];
  const broker = createBroker({
    transports: [telegram, hung],
    deliverTimeoutMs: 30_000,
    setTimeout: (callback) => {
      timers.push(callback);
      return 1;
    },
    clearTimeout: () => {},
  });
  const question = makeQuestion();

  const pending = broker.publish(question);
  await tick();
  assert.equal(telegram.sent.length, 1, "быстрый канал доставлен");
  for (const callback of timers) callback();
  const publication = await pending;

  assert.deepEqual(publication.delivered.map((item) => item.id), ["telegram"]);
  assert.equal(publication.failed[0].transport.id, "max");
  assert.equal(publication.failed[0].reason, "timeout");
});

test("closeAll: сбой editQuestion не оставляет кнопки в проигравшем канале", async () => {
  const telegram = fakeTransport("telegram");
  const max = fakeTransport("max");
  max.editQuestion = async () => {
    throw new Error("правка не удалась");
  };
  const broker = createBroker({ transports: [telegram, max], log: () => {} });
  const question = makeQuestion();
  await broker.publish(question);

  await broker.closeAll(question, { winner: telegram, summary: "Да" });

  assert.deepEqual(max.closed.map((item) => item.summary), [ANSWERED_ELSEWHERE], "кнопки всё равно сняты");
});

test("reliability.noteDeliveries сохраняет список каналов в состоянии", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createJsonState, createReliability } = await import("../lib/reliability.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = createJsonState({ file: path.join(dir, "state.json") });
  const reliability = createReliability({
    transport: fakeTransport("telegram"),
    state,
    logFile: path.join(dir, "log.jsonl"),
    log: () => {},
  });
  const question = makeQuestion();
  reliability.watch(question);
  await brokerPublish(question);

  reliability.noteDeliveries(question);

  const [saved] = state.read().questions;
  assert.deepEqual(saved.deliveries, [
    { transport: "telegram", messageId: "telegram-mid", chatId: null },
    { transport: "max", messageId: "max-mid", chatId: null },
  ], "deliveries переживут рестарт");

  async function brokerPublish(target) {
    const broker = createBroker({ transports: [fakeTransport("telegram"), fakeTransport("max")] });
    await broker.publish(target);
  }
});

test("answererFeature: config.transports берёт каналы из реестра и публикует в оба", async () => {
  const { answererFeature } = await import("../lib/features/answerer.js");
  const telegram = fakeTransport("telegram");
  const max = fakeTransport("max");
  const registry = new Map([["telegram", telegram], ["max", max]]);
  const services = new Map([
    ["remoteTransport", telegram],
    ["remoteTransports", registry],
    ["remoteStore", { read: () => ({ enabled: { global: true }, hybrid: { enabled: false } }) }],
  ]);
  const hooks = new Map();
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services.get(name) ?? null,
    onDispose: () => {},
  };
  const ctx = {
    get: (name) => services.get(name) ?? null,
    on: (event, handler, options) => {
      hooks.set(event, { handler, options });
      return () => {};
    },
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };

  answererFeature.apply(ctx, { transports: ["telegram", "max"] }, deps);

  const listener = hooks.get("user-questions/request")?.handler;
  assert.equal(typeof listener, "function", "answerer подписан каркасом");
  const pending = listener(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: "s1" } },
    () => assert.fail("next()"),
  );
  await tick();
  assert.equal(telegram.sent.length, 1, "канал telegram из реестра");
  assert.equal(max.sent.length, 1, "канал max из реестра");

  telegram.answer({ shortId: telegram.sent[0].shortId, optionId: "o1" });
  await pending;
});

// --- регрессии по второму ревью 012 -----------------------------------------

test("мультиканал использует reliability: ретрай канала и изоляция сбоя", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createJsonState, createReliability } = await import("../lib/reliability.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-rel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = createJsonState({ file: path.join(dir, "state.json") });
  const clock = { value: 0 };
  const reliability = createReliability({
    transport: fakeTransport("telegram"),
    state,
    logFile: path.join(dir, "log.jsonl"),
    now: () => clock.value,
    sleep: async (ms) => {
      clock.value += ms;
    },
    connectTimeoutMs: 5_000,
    backoffBaseMs: 100,
    log: () => {},
  });

  const flaky = fakeTransport("telegram");
  let attempts = 0;
  flaky.sendQuestion = async (question) => {
    attempts += 1;
    if (attempts === 1) throw new Error("сеть мигнула");
    flaky.sent.push(question);
    return { messageId: "flaky-mid" };
  };
  const broken = fakeTransport("max", { failSend: true });

  const deliverFor = (target) => (argument) => reliability.deliver({ ...argument, transport: target });
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({ transports: [flaky, broken], registry, deliverFor, log: () => {}, now: () => 0 });
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
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: "s1" } },
    () => {
      nextCalls += 1;
      return { answers: [] };
    },
  );
  await tick();

  assert.equal(attempts >= 2, true, "флапающий канал повторили через reliability");
  assert.equal(flaky.sent.length, 1, "вопрос доставлен после ретрая");
  assert.equal(nextCalls, 0, "один канал доставил — GUI не нужен");

  flaky.answer({ shortId: flaky.sent[0].shortId, optionId: "o1" });
  const result = await pending;
  assert.deepEqual(result.answers, [{ id: "q1", selected: ["Да"] }]);
});

test("answererFeature передаёт deliverFor из сервиса reliability", async () => {
  const { answererFeature } = await import("../lib/features/answerer.js");
  const a = fakeTransport("telegram");
  const b = fakeTransport("max");
  const delivered = [];
  const services = new Map([
    ["remoteTransport", a],
    ["remoteTransports", new Map([["telegram", a], ["max", b]])],
    ["remoteStore", { read: () => ({ enabled: { global: true }, hybrid: { enabled: false } }) }],
    ["remoteReliabilityDeliver", (target) => async (argument) => {
      delivered.push(target.id);
      return target.sendQuestion(argument.question);
    }],
  ]);
  const hooks = new Map();
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services.get(name) ?? null,
    onDispose: () => {},
  };
  const ctx = {
    get: (name) => services.get(name) ?? null,
    on: (event, handler) => {
      hooks.set(event, { handler });
      return () => {};
    },
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };

  answererFeature.apply(ctx, { transports: ["telegram", "max"] }, deps);
  const pending = hooks.get("user-questions/request").handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: "s1" } },
    () => assert.fail("next() нельзя"),
  );
  await tick();

  assert.deepEqual(delivered.sort(), ["max", "telegram"], "каждый канал доставлен через reliability");
  a.answer({ shortId: a.sent[0].shortId, optionId: "o1" });
  await pending;
});

// --- интеграция двух настоящих каналов (012, после слияния 011) -------------

/** Ответ API. */
function apiResponse(payload, status = 200) {
  return {
    ok: status < 400,
    status,
    async json() {
      return payload;
    },
  };
}

/**
 * Fetch для двух настоящих транспортов: Telegram и MAX.
 *
 * `getUpdates`/`updates` не отвечают, пока тест не подложит пачку — так поллинг
 * не крутится вхолостую, а ответ приходит «как из мессенджера».
 */
function dualFetch() {
  const state = { tg: [], max: [], tgSent: [], maxSent: [], maxPuts: [], tgEdits: [], tgMarkup: [] };
  const waiter = (list, init) => new Promise((resolve, reject) => {
    list.push({ resolve, reject });
    init?.signal?.addEventListener?.("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  });
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body === undefined ? null : JSON.parse(init.body);
    if (parsed.hostname === "platform-api2.max.ru") {
      if (parsed.pathname === "/updates") return waiter(state.max, init);
      if (parsed.pathname === "/messages" && method === "POST") {
        state.maxSent.push(body);
        return apiResponse({ message: { body: { mid: "max-mid-1" } } });
      }
      if (parsed.pathname === "/messages" && method === "PUT") {
        state.maxPuts.push(body);
        return apiResponse({ ok: true });
      }
      return apiResponse({ ok: true });
    }
    if (parsed.pathname.endsWith("/getUpdates")) return waiter(state.tg, init);
    if (parsed.pathname.endsWith("/sendMessage")) {
      state.tgSent.push(body);
      return apiResponse({ ok: true, result: { message_id: 501 } });
    }
    if (parsed.pathname.endsWith("/editMessageText")) {
      state.tgEdits.push(body);
      return apiResponse({ ok: true, result: true });
    }
    if (parsed.pathname.endsWith("/editMessageReplyMarkup")) {
      state.tgMarkup.push(body);
      return apiResponse({ ok: true, result: true });
    }
    if (parsed.pathname.endsWith("/answerCallbackQuery")) return apiResponse({ ok: true, result: true });
    if (parsed.pathname.endsWith("/getMe")) return apiResponse({ ok: true, result: { username: "tg_bot" } });
    return apiResponse({ ok: true, result: true });
  };
  return { fetch, state };
}

test("два настоящих канала: ответ из Telegram закрывает MAX пометкой, поздний MAX игнорируется", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createJsonState, createReliability } = await import("../lib/reliability.js");
  const { createTelegramTransport } = await import("../lib/transport/telegram.js");
  const { createMaxTransport } = await import("../lib/transport/max.js");
  const { answererFeature } = await import("../lib/features/answerer.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-real-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const api = dualFetch();
  const logs = [];
  // Логи транспортов и ответчика — в один список: поздний клик должен быть виден.
  const options = {
    fetch: api.fetch,
    jitter: () => 0,
    now: () => 0,
    sleep: async () => {},
    log: (message) => logs.push(message),
  };
  const telegram = createTelegramTransport({ token: "123456:TEST", chatId: 42, allowedUserIds: [7], persistOffset: () => {}, ...options });
  const max = createMaxTransport({ token: "max-token", chatId: 42, allowedUserIds: [7], ...options });
  t.after(() => {
    void telegram.stop?.();
    void max.stop?.();
  });

  const reliability = createReliability({
    transport: telegram,
    state: createJsonState({ file: path.join(dir, "state.json") }),
    logFile: path.join(dir, "log.jsonl"),
    now: () => 0,
    sleep: async () => {},
    log: () => {},
  });
  const deliverFor = (target) => (argument) => reliability.deliver({ ...argument, transport: target });

  const services = new Map([
    ["remoteTransport", telegram],
    ["remoteTransports", new Map([["telegram", telegram], ["max", max]])],
    ["remoteStore", { read: () => ({ enabled: { global: true }, hybrid: { enabled: false } }) }],
    ["remoteReliabilityDeliver", deliverFor],
  ]);
  const hooks = new Map();
  const deps = {
    logger: { debug: (m) => logs.push(m), info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    get: (name) => services.get(name) ?? null,
    onDispose: () => {},
  };
  const ctx = {
    get: (name) => services.get(name) ?? null,
    on: (event, handler) => {
      hooks.set(event, { handler });
      return () => {};
    },
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };

  answererFeature.apply(ctx, { transports: ["telegram", "max"] }, deps);
  const listener = hooks.get("user-questions/request").handler;

  await telegram.start();
  await max.start();

  const pending = listener(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] }], agent: { id: "s1" } },
    () => assert.fail("next() нельзя"),
  );
  await tick();

  assert.equal(api.state.tgSent.length, 1, "вопрос ушёл в Telegram");
  assert.equal(api.state.maxSent.length, 1, "вопрос ушёл в MAX");
  const shortId = api.state.maxSent[0].attachments[0].payload.buttons[0][0].payload.split(":")[1];

  // Ответ из Telegram: человек нажал «Да».
  const tgWaiter = api.state.tg.pop();
  tgWaiter.resolve(apiResponse({
    ok: true,
    result: [{
      update_id: 1,
      callback_query: { id: "cb1", from: { id: 7 }, data: `q:${shortId}:o1`, message: { message_id: 501, chat: { id: 42 } } },
    }],
  }));
  const result = await pending;

  assert.deepEqual(result.answers, [{ id: "q1", selected: ["Да"] }]);
  await tick(); // closeAll идёт в фоне после ответа сессии
  const maxPut = api.state.maxPuts.at(-1);
  assert.equal(maxPut.text, "Отвечено в другом канале", "проигравший канал помечен");
  assert.deepEqual(maxPut.attachments, [], "кнопки в MAX сняты");

  // Поздний ответ из MAX: решение уже принято — игнорируем, но видно в логе.
  const maxWaiter = api.state.max.pop();
  maxWaiter.resolve(apiResponse({
    updates: [{
      type: "message_callback",
      timestamp: 2,
      callback: { callback_id: "cb2", payload: `q:${shortId}:o2`, user: { user_id: 7 }, chat: { chat_id: 42 } },
    }],
    marker: 2,
  }));
  await tick();

  // MAX-транспорт уже удалил запись после закрытия: поздний клик отбрасывается
  // на его уровне (и это видно в логе), решение сессии не меняется.
  assert.match(logs.join("\n"), /вопроса уже нет|проигнорирован/);
  // Первый PUT — пометка (кнопки ещё на месте), второй — закрытие (attachments []).
  const maxCloses = api.state.maxPuts.filter((put) => Array.isArray(put.attachments) && put.attachments.length === 0);
  assert.equal(maxCloses.length, 1, "закрытие ровно одно");
});

// --- регрессии по третьему ревью 012 ----------------------------------------

test("features: при config.transports два канала не гасят друг друга фасадом", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { telegramFeature } = await import("../lib/features/telegram.js");
  const { maxFeature } = await import("../lib/features/max.js");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/getUpdates") || parsed.pathname === "/updates") {
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener?.("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    if (parsed.pathname.endsWith("/sendMessage")) return apiResponse({ ok: true, result: { message_id: 1 } });
    if (parsed.pathname === "/messages") return apiResponse({ message: { body: { mid: "mid-1" } } });
    return apiResponse({ ok: true, result: { username: "tg_bot" } });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const registry = new Map();
  const stopped = [];
  const facade = {
    __isTransportFacade: true,
    current: null,
    set(transport) {
      if (this.current !== null && this.current !== transport) stopped.push(this.current.id);
      this.current = transport;
    },
    async stop() {
      if (this.current !== null) stopped.push(this.current.id);
      this.current = null;
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-msig-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const services = new Map([
    ["credentials", { resolve: async () => ({ value: "token", source: "file" }), availableFor: () => true }],
    ["remoteTransport", facade],
    ["remoteTransports", registry],
  ]);
  const disposers = [];
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services.get(name) ?? null,
    onDispose: (disposer) => disposers.push(disposer),
  };
  const ctx = {
    get: (name) => services.get(name) ?? null,
    provide: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };
  const config = {
    transports: ["telegram", "max"],
    telegram: { tokenRef: "TG", chatId: 42, allowedUserIds: [7] },
    max: { chatId: 42, allowedUserIds: [7] },
  };

  await maxFeature.apply(ctx, config, deps);
  await telegramFeature.apply(ctx, config, deps);

  assert.deepEqual([...registry.keys()].sort(), ["max", "telegram"], "оба канала в реестре");
  assert.equal(facade.current, null, "фасад в мультиканальном режиме не трогали");
  assert.deepEqual(stopped, [], "ни один канал не был погашен");
  assert.equal(registry.get("telegram").polling, true);
  assert.equal(registry.get("max").polling, true);

  for (const dispose of [...disposers].reverse()) await dispose?.();
  void dir;
});

test("TTL на двух каналах: пометка и закрытие идут во все доставки", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createJsonState, createReliability } = await import("../lib/reliability.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-ttl-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { value: 0 };
  const telegram = fakeTransport("telegram");
  const max = fakeTransport("max");
  const registry = new Map([["telegram", telegram], ["max", max]]);
  const reliability = createReliability({
    transport: telegram,
    transportFor: (id) => registry.get(id) ?? null,
    state: createJsonState({ file: path.join(dir, "state.json") }),
    logFile: path.join(dir, "log.jsonl"),
    now: () => clock.value,
    sleep: async () => {},
    connectTimeoutMs: 5_000,
    notifyTimeoutMs: 1_000,
    setTimeout: (callback) => {
      callback();
      return 1;
    },
    log: () => {},
  });
  const question = makeQuestion();
  question.expiresAt = question.createdAt + 10 * 60 * 1000; // TTL 10 минут
  question.deliveries = [
    { transport: "telegram", messageId: "tg-mid", chatId: 42 },
    { transport: "max", messageId: "max-mid", chatId: 42 },
  ];
  reliability.watch(question);

  // Напоминание — во все каналы (за 5 минут до expiresAt = 10 минут).
  clock.value += 5 * 60 * 1000 + 1;
  await reliability.tick();

  assert.equal(telegram.edited.length, 1, "напоминание в telegram");
  assert.equal(max.edited.length, 1, "напоминание в max");
  assert.match(telegram.edited[0].text, /осталось 5 минут/);

  // Истечение — закрываем и помечаем оба.
  clock.value += 5 * 60 * 1000;
  await reliability.tick();

  assert.deepEqual(telegram.closed.map((item) => item.summary), ["expired"]);
  assert.deepEqual(max.closed.map((item) => item.summary), ["expired"]);
  assert.equal(max.edited.at(-1).text, "⌛ ждёт ответа");
});

test("recover после рестарта закрывает обе доставки из state.questions", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createJsonState, createReliability } = await import("../lib/reliability.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-recover-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const edited = { telegram: [], max: [] };
  const cleared = { telegram: [], max: [] };
  const makeChannel = (id) => ({
    id,
    caps: {},
    async editMessage(target, text) {
      edited[id].push({ target, text });
    },
    async clearButtons(target) {
      cleared[id].push(target);
    },
    async sendQuestion() {
      return { messageId: "1" };
    },
    async closeQuestion() {},
  });
  const registry = new Map([["telegram", makeChannel("telegram")], ["max", makeChannel("max")]]);
  const state = createJsonState({ file: path.join(dir, "state.json") });
  state.write({
    version: 1,
    pending: [],
    questions: [{
      shortId: "abc12345",
      chatId: 42,
      messageId: null,
      deliveries: [
        { transport: "telegram", messageId: "tg-1", chatId: 42 },
        { transport: "max", messageId: "max-1", chatId: 42 },
      ],
    }],
  });
  const reliability = createReliability({
    transport: registry.get("telegram"),
    transportFor: (id) => registry.get(id) ?? null,
    state,
    logFile: path.join(dir, "log.jsonl"),
    now: () => 0,
    log: () => {},
  });

  const result = await reliability.recoverOrphans();

  assert.deepEqual(result, { cancelled: 1, failed: 0 });
  assert.equal(edited.telegram.length, 1, "правка в telegram");
  assert.equal(edited.max.length, 1, "правка в max");
  assert.match(edited.max[0].text, /сессия перезапущена/);
  assert.deepEqual(cleared.telegram[0], { chatId: 42, messageId: "tg-1" });
  assert.deepEqual(cleared.max[0], { chatId: 42, messageId: "max-1" });
});

// --- регрессии по четвёртому ревью 012 --------------------------------------

test("reliabilityFeature передаёт transportFor: TTL и recover идут в оба канала", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { reliabilityFeature } = await import("../lib/features/reliability.js");
  const { createStore } = await import("../lib/store.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-relfeat-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ file: path.join(dir, "state.json") });
  const edited = { telegram: [], max: [] };
  const closed = { telegram: [], max: [] };
  const makeChannel = (id) => ({
    id,
    caps: {},
    async editQuestion(question, text) {
      edited[id].push({ question, text });
      return true;
    },
    async closeQuestion(question, summary) {
      closed[id].push({ question, summary });
    },
    async sendQuestion() {
      return { messageId: "x" };
    },
  });
  const registry = new Map([["telegram", makeChannel("telegram")], ["max", makeChannel("max")]]);
  const provided = new Map();
  const services = new Map([
    ["remoteTransport", null],
    ["remoteTransports", registry],
    ["remoteStore", store],
  ]);
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services.get(name) ?? null,
    onDispose: () => {},
  };
  const ctx = {
    get: (name) => services.get(name) ?? null,
    provide: (name, service) => provided.set(name, service),
  };

  await reliabilityFeature.apply(ctx, { logFile: path.join(dir, "log.jsonl") }, deps);
  const reliability = provided.get("remoteReliability");
  assert.ok(reliability, "сервис устойчивости зарегистрирован");

  const question = makeQuestion();
  question.expiresAt = 0; // уже истёк: tick сразу закроет
  question.deliveries = [
    { transport: "telegram", messageId: "tg-1", chatId: 42 },
    { transport: "max", messageId: "max-1", chatId: 42 },
  ];
  reliability.watch(question, { onExpire: () => {} });
  await reliability.tick();

  assert.equal(edited.telegram.length, 1, "пометка в telegram");
  assert.equal(edited.max.length, 1, "пометка в max");
  assert.deepEqual(closed.telegram.map((item) => item.summary), ["expired"]);
  assert.deepEqual(closed.max.map((item) => item.summary), ["expired"]);

  reliability.stop();
});

test("disconnect останавливает все каналы реестра в мультиканальном режиме", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createRemoteCommands } = await import("../lib/commands.js");
  const { createStore } = await import("../lib/store.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-disconnect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ file: path.join(dir, "state.json") });
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });

  const stopped = [];
  const registry = new Map([
    ["telegram", { id: "telegram", async stop() { stopped.push("telegram"); } }],
    ["max", { id: "max", async stop() { stopped.push("max"); } }],
  ]);
  const ctx = {
    get: (name) => {
      if (name === "remoteTransports") return registry;
      if (name === "remoteTransport") return null; // в multi фасад пуст
      if (name === "credentials") return { describe: async () => ({ present: false, writable: false }), unset: async () => true };
      return null;
    },
    userQuestions: { ask: async () => ({ answers: [{ id: "remote-disconnect-confirm", selected: ["Да, отвязать"] }] }) },
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };
  const remote = createRemoteCommands({ ctx, store, log: () => {}, now: () => 0 });

  const result = await remote.handler({
    commandId: "c1",
    agent: { id: "s1", session: { id: "s1" } },
    rawInput: "disconnect",
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, "success", result.text);
  assert.deepEqual(stopped.sort(), ["max", "telegram"], "оба канала остановлены");
  assert.equal(registry.size, 0, "реестр очищен");
  assert.equal(store.read().bindings, null);
});

test("фичевая сборка max+telegram+reliability+answerer: два канала, ответ и TTL-покрытие", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { telegramFeature } = await import("../lib/features/telegram.js");
  const { maxFeature } = await import("../lib/features/max.js");
  const { reliabilityFeature } = await import("../lib/features/reliability.js");
  const { answererFeature } = await import("../lib/features/answerer.js");
  const { createStore } = await import("../lib/store.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-e2e-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ file: path.join(dir, "state.json") });
  store.setEnabled({ kind: "global" }, true); // режим включён: вопрос идёт в мессенджеры
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });

  const originalFetch = globalThis.fetch;
  const api = dualFetch();
  globalThis.fetch = api.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const registry = new Map();
  const provided = new Map();
  const facade = { __isTransportFacade: true, current: null, set(transport) { this.current = transport; }, async stop() { this.current = null; } };
  const services = new Map([
    ["credentials", { resolve: async () => ({ value: "token", source: "file" }), availableFor: () => true, describe: async () => ({ source: "file", writable: true }) }],
    ["remoteTransport", facade],
    ["remoteTransports", registry],
    ["remoteStore", store],
  ]);
  const logs = [];
  const disposers = [];
  const deps = {
    logger: { debug: (m) => logs.push(m), info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    get: (name) => services.get(name) ?? null,
    onDispose: (disposer) => disposers.push(disposer),
  };
  const hooks = new Map();
  const ctx = {
    get: (name) => services.get(name) ?? null,
    provide: (name, service) => {
      provided.set(name, service);
      services.set(name, service);
    },
    on: (event, handler) => {
      hooks.set(event, { handler });
      return () => {};
    },
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };
  const config = {
    transports: ["telegram", "max"],
    telegram: { tokenRef: "TG", chatId: 42, allowedUserIds: [7] },
    max: { chatId: 42, allowedUserIds: [7] },
    logFile: path.join(dir, "log.jsonl"),
  };

  await maxFeature.apply(ctx, config, deps);
  await telegramFeature.apply(ctx, config, deps);
  await reliabilityFeature.apply(ctx, config, deps);
  answererFeature.apply(ctx, config, deps);

  assert.deepEqual([...registry.keys()].sort(), ["max", "telegram"]);
  assert.equal(facade.current, null, "мультиканальный режим не трогает фасад");
  assert.ok(provided.get("remoteReliability"), "reliability доступен");
  assert.ok(hooks.get("user-questions/request"), "ответчик подписан");

  const listener = hooks.get("user-questions/request").handler;
  const pending = listener(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: "s1" } },
    () => assert.fail("next() нельзя"),
  );
  await tick();

  assert.equal(api.state.tgSent.length, 1, "вопрос в telegram");
  assert.equal(api.state.maxSent.length, 1, "вопрос в max");
  const shortId = api.state.maxSent[0].attachments[0].payload.buttons[0][0].payload.split(":")[1];

  const tgWaiter = api.state.tg.pop();
  tgWaiter.resolve(apiResponse({
    ok: true,
    result: [{
      update_id: 1,
      callback_query: { id: "cb1", from: { id: 7 }, data: `q:${shortId}:o1`, message: { message_id: 501, chat: { id: 42 } } },
    }],
  }));
  const result = await pending;
  await tick();
  await tick();

  assert.deepEqual(result.answers, [{ id: "q1", selected: ["Да"] }]);
  // Правки транспорта идут через троттлинг (500 мс на канал) — дождёмся его.
  await new Promise((resolve) => setTimeout(resolve, 750));
  const maxClose = api.state.maxPuts.filter((put) => Array.isArray(put.attachments) && put.attachments.length === 0);
  assert.equal(maxClose.length, 1, "MAX закрыт пометкой после ответа в Telegram");

  for (const dispose of [...disposers].reverse()) await dispose?.();
});

// --- регрессии по ревью тестировщика 012 ------------------------------------

test("аборт в мультиканале закрывает оба канала (не только фасад)", async () => {
  const telegram = fakeTransport("telegram");
  const max = fakeTransport("max");
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({ transports: [telegram, max], registry, log: () => {}, now: () => 0 });
  answerer.attach({
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
    get: () => null,
  });

  const controller = new AbortController();
  const pending = answerer.handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: "s1" }, signal: controller.signal },
    () => assert.fail("next() нельзя"),
  );
  await tick();
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");

  assert.deepEqual(telegram.closed.map((item) => item.summary), ["aborted"], "telegram закрыт");
  assert.deepEqual(max.closed.map((item) => item.summary), ["aborted"], "max закрыт");
});

test("deliveries.messageId переживает reliability-доставку и recover правит оба канала", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createJsonState, createReliability } = await import("../lib/reliability.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-mid-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const makeSend = (id) => ({
    id,
    chatId: id === "telegram" ? 42 : 43,
    caps: {},
    async sendQuestion() {
      return { messageId: `${id}-mid` };
    },
    onAnswer: () => () => {},
    async closeQuestion() {},
  });
  const telegram = makeSend("telegram");
  const max = makeSend("max");
  const registry = new Map([["telegram", telegram], ["max", max]]);
  const state = createJsonState({ file: path.join(dir, "state.json") });
  const reliability = createReliability({
    transport: telegram,
    transportFor: (id) => registry.get(id) ?? null,
    state,
    logFile: path.join(dir, "log.jsonl"),
    now: () => 0,
    sleep: async () => {},
    log: () => {},
  });
  // Та же обёртка, что публикует фича reliability.
  const deliverFor = (target) => async (argument) => {
    const outcome = await reliability.deliver({ ...argument, transport: target });
    if (outcome !== "delivered") return outcome;
    const info = reliability.deliveryInfo?.(argument?.question?.shortId, target.id) ?? null;
    return { delivered: true, messageId: info?.messageId ?? null, chatId: info?.chatId ?? target.chatId ?? null };
  };
  const broker = createBroker({ transports: [telegram, max], deliverFor });
  const question = makeQuestion();

  const publication = await broker.publish(question);
  assert.equal(publication.anyDelivered, true);
  assert.deepEqual(question.deliveries.map((item) => item.messageId), ["telegram-mid", "max-mid"], "messageId не теряется");
  reliability.noteDeliveries(question);

  // Рестарт: новые каналы (in-memory пусто), но state помнит оба messageId.
  const edited = { telegram: [], max: [] };
  const cleared = { telegram: [], max: [] };
  for (const id of ["telegram", "max"]) {
    registry.set(id, {
      id,
      caps: {},
      async editMessage(target, text) { edited[id].push({ target, text }); },
      async clearButtons(target) { cleared[id].push(target); },
      async sendQuestion() { return { messageId: "x" }; },
      async closeQuestion() {},
    });
  }
  const { createReliability: makeReliability } = await import("../lib/reliability.js");
  const afterRestart = makeReliability({
    transport: registry.get("telegram"),
    transportFor: (id) => registry.get(id) ?? null,
    state,
    logFile: path.join(dir, "log2.jsonl"),
    now: () => 0,
    log: () => {},
  });

  const result = await afterRestart.recoverOrphans();

  assert.deepEqual(result, { cancelled: 1, failed: 0 });
  assert.equal(edited.telegram.length, 1, "правим telegram");
  assert.equal(edited.max.length, 1, "правим max");
  assert.deepEqual(cleared.telegram[0], { chatId: 42, messageId: "telegram-mid" });
  assert.deepEqual(cleared.max[0], { chatId: 43, messageId: "max-mid" });
});

test("аборт на уровне фичевой сборки закрывает оба канала (сетевые вызовы есть)", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { telegramFeature } = await import("../lib/features/telegram.js");
  const { maxFeature } = await import("../lib/features/max.js");
  const { reliabilityFeature } = await import("../lib/features/reliability.js");
  const { answererFeature } = await import("../lib/features/answerer.js");
  const { createStore } = await import("../lib/store.js");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-012-abort-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ file: path.join(dir, "state.json") });
  store.setEnabled({ kind: "global" }, true);
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });

  const originalFetch = globalThis.fetch;
  const api = dualFetch();
  globalThis.fetch = api.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const registry = new Map();
  const provided = new Map();
  const facade = { __isTransportFacade: true, current: null, set(t) { this.current = t; }, async stop() { this.current = null; } };
  const services = new Map([
    ["credentials", { resolve: async () => ({ value: "token", source: "file" }), availableFor: () => true, describe: async () => ({ source: "file", writable: true }) }],
    ["remoteTransport", facade],
    ["remoteTransports", registry],
    ["remoteStore", store],
  ]);
  const disposers = [];
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services.get(name) ?? null,
    onDispose: (disposer) => disposers.push(disposer),
  };
  const hooks = new Map();
  const ctx = {
    get: (name) => services.get(name) ?? null,
    provide: (name, service) => {
      provided.set(name, service);
      services.set(name, service);
    },
    on: (event, handler) => {
      hooks.set(event, { handler });
      return () => {};
    },
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };
  const config = {
    transports: ["telegram", "max"],
    telegram: { tokenRef: "TG", chatId: 42, allowedUserIds: [7] },
    max: { chatId: 42, allowedUserIds: [7] },
    logFile: path.join(dir, "log.jsonl"),
  };

  await maxFeature.apply(ctx, config, deps);
  await telegramFeature.apply(ctx, config, deps);
  await reliabilityFeature.apply(ctx, config, deps);
  answererFeature.apply(ctx, config, deps);

  const controller = new AbortController();
  const pending = hooks.get("user-questions/request").handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: "s1" }, signal: controller.signal },
    () => assert.fail("next() нельзя"),
  );
  await tick();
  assert.equal(api.state.tgSent.length, 1);
  assert.equal(api.state.maxSent.length, 1);

  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  await new Promise((resolve) => setTimeout(resolve, 750)); // троттлинг правок

  // Тихая причина в Telegram правки текста не требует: кнопки снимаются
  // через editMessageReplyMarkup.
  assert.ok(api.state.tgEdits.length + api.state.tgMarkup.length >= 1, "Telegram: кнопки сняты");
  const maxClose = api.state.maxPuts.filter((put) => Array.isArray(put.attachments) && put.attachments.length === 0);
  assert.ok(maxClose.length >= 1, "MAX: кнопки сняты");

  for (const dispose of [...disposers].reverse()) await dispose?.();
});
