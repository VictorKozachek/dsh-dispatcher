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
