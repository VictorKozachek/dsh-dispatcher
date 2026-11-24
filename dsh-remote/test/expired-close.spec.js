/**
 * 084: снятый вопрос помечается «⌛ вопрос снят …», кнопки снимаются.
 *
 * После TTL, аборта запроса и рестарта профиля сообщение в мессенджере правится
 * ровно один раз: текст «снят» и пустые кнопки (Telegram — `reply_markup:
 * {inline_keyboard: []}`, MAX — `attachments: []`). Неудача правки видна в
 * журнале `question.closeFailed`, но ответ и сессию не ломает.
 *
 * Сети и реальных задержек нет: `fetch`, часы и `sleep` инжектируются.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAnswerer } from "../lib/answerer.js";
import { createRegistry } from "../lib/domain/registry.js";
import { createQuestion } from "../lib/domain/question.js";
import { createJsonState, createReliability } from "../lib/reliability.js";
import { createMaxTransport } from "../lib/transport/max.js";
import { createTelegramTransport } from "../lib/transport/telegram.js";

const TOKEN = "123456:TEST-TOKEN";

/** Дать отработать микрозадачам (без реальных задержек). */
const tickMs = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-084-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Часы и сон: время двигается только через `sleep`/`advance`, задержек нет. */
function fakeClock(start = 0) {
  let clock = start;
  const sleeps = [];
  return {
    sleeps,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    advance: (ms) => {
      clock += ms;
    },
  };
}

/** Ответ «как от fetch»: тело и статус. */
const response = (body, status = 200) => ({
  ok: status < 400,
  status,
  async json() {
    return body;
  },
});

/**
 * Фейковый Telegram Bot API: маршруты по имени метода, журнал вызовов.
 * `routes[method](payload, номерВызова)` — ответ или промис.
 */
function telegramApi(routes = {}) {
  const calls = [];
  const counts = new Map();
  const fetch = async (url, init = {}) => {
    const method = url.split("/").pop();
    const payload = init.body === undefined ? {} : JSON.parse(init.body);
    const count = (counts.get(method) ?? 0) + 1;
    counts.set(method, count);
    calls.push({ method, payload, count });
    const route = routes[method];
    if (typeof route === "function") return route(payload, count);
    if (method === "getUpdates") return new Promise(() => {});
    if (method === "sendMessage") return response({ ok: true, result: { message_id: 900 } });
    return response({ ok: true, result: true });
  };
  return { fetch, calls, of: (method) => calls.filter((call) => call.method === method) };
}

/** Фейковый MAX Bot API: маршруты по `"METHOD /path"`. */
function maxApi(routes = {}) {
  const calls = [];
  const counts = new Map();
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const key = `${method} ${parsed.pathname}`;
    const payload = init.body === undefined ? null : JSON.parse(init.body);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    calls.push({ key, query: parsed.searchParams, payload, count });
    const route = routes[key];
    if (typeof route === "function") return route(payload, count);
    if (parsed.pathname === "/updates") return new Promise(() => {});
    if (key === "POST /messages") return response({ ok: true, message: { body: { mid: "mid.84" } } });
    return response({ ok: true });
  };
  return { fetch, calls, of: (key) => calls.filter((call) => call.key === key) };
}

function telegram(clock, api) {
  return createTelegramTransport({
    token: TOKEN,
    chatId: 42,
    allowedUserIds: [7],
    fetch: api.fetch,
    jitter: () => 0,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    persistOffset: () => {},
    log: () => {},
  });
}

function max(clock, api) {
  return createMaxTransport({
    token: "max-test-token",
    chatId: 42,
    allowedUserIds: [7],
    fetch: api.fetch,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    jitter: (ms) => ms,
    log: () => {},
  });
}

function makeReliability(t, { clock, transport, transportFor = null, state = null, logFile = null } = {}) {
  const dir = tempDir(t);
  const file = logFile ?? path.join(dir, "log.jsonl");
  const reliability = createReliability({
    transport,
    ...(transportFor === null ? {} : { transportFor }),
    state: state ?? createJsonState({ file: path.join(dir, "state.json"), now: clock.now }),
    logFile: file,
    now: clock.now,
    sleep: clock.sleep,
    notifyTimeoutMs: 1_000,
    log: () => {},
  });
  return { reliability, logFile: file };
}

/** Открытый вопрос домена. */
function openQuestion({ id = "q1", ttlMs = 10 * 60 * 1000, now = 0 } = {}) {
  const question = createQuestion(
    { id, question: "Продолжать деплой?", options: [{ label: "Да" }, { label: "Нет" }] },
    { now, ttlMs, workspace: "/p/dsh-dispatcher" },
  );
  question.markOpen(now);
  return question;
}

test("084 TTL: Telegram — одна правка «⌛ вопрос снят (истекло время)», кнопки сняты", async (t) => {
  const clock = fakeClock();
  const api = telegramApi();
  const transport = telegram(clock, api);
  const { reliability } = makeReliability(t, { clock, transport });
  const question = openQuestion({ ttlMs: 10 * 60 * 1000, now: 0 });
  await transport.sendQuestion(question);
  reliability.watch(question);

  clock.advance(10 * 60 * 1000 + 1);
  await reliability.tick();

  const edits = api.of("editMessageText");
  assert.equal(edits.length, 1, "одна правка на вопрос: предварительной пометки «ждёт ответа» нет");
  assert.equal(edits[0].payload.chat_id, 42);
  assert.equal(edits[0].payload.message_id, 900);
  assert.match(edits[0].payload.text, /⌛ вопрос снят \(истекло время\)/);
  assert.deepEqual(edits[0].payload.reply_markup, { inline_keyboard: [] }, "кнопки сняты той же правкой");
  assert.equal(api.of("editMessageReplyMarkup").length, 0, "второй правки нет");

  await reliability.tick();
  assert.equal(api.of("editMessageText").length, 1, "повторный tick сообщение не правит");
});

test("084 TTL: MAX — одна правка PUT /messages, attachments: [], пометка «снят»", async (t) => {
  const clock = fakeClock();
  const api = maxApi();
  const transport = max(clock, api);
  const { reliability } = makeReliability(t, { clock, transport });
  const question = openQuestion({ ttlMs: 10 * 60 * 1000, now: 0 });
  await transport.sendQuestion(question);
  reliability.watch(question);

  clock.advance(10 * 60 * 1000 + 1);
  await reliability.tick();

  const puts = api.of("PUT /messages");
  assert.equal(puts.length, 1, "одна правка на вопрос");
  assert.equal(puts[0].query.get("message_id"), "mid.84");
  assert.deepEqual(puts[0].payload.attachments, [], "кнопки (attachments) сняты");
  assert.match(puts[0].payload.text, /⌛ вопрос снят \(истекло время\)/);

  await reliability.tick();
  assert.equal(api.of("PUT /messages").length, 1, "повторный tick сообщение не правит");
});

test("084 аборт: Telegram правит сообщение «⌛ вопрос снят» и снимает кнопки", async (t) => {
  const clock = fakeClock();
  const api = telegramApi();
  const transport = telegram(clock, api);
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({ transport, registry, log: () => {}, now: () => 1_000 });
  answerer.attach({ on: () => () => {}, get: () => null });

  const controller = new AbortController();
  const pending = answerer.handler(
    {
      questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }],
      agent: { id: "s1" },
      signal: controller.signal,
    },
    () => assert.fail("next() звать нельзя: вопрос забрали в мессенджер"),
  );
  await tickMs();
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");

  const edits = api.of("editMessageText");
  assert.equal(edits.length, 1, "одна правка на снятый вопрос");
  assert.match(edits[0].payload.text, /⌛ вопрос снят/);
  assert.doesNotMatch(edits[0].payload.text, /aborted/, "служебная причина не выдаётся за ответ");
  assert.deepEqual(edits[0].payload.reply_markup, { inline_keyboard: [] }, "кнопки сняты");
});

test("084 recover: осиротевший вопрос снимается в обоих каналах, состояние очищается", async (t) => {
  const clock = fakeClock();
  const tgApi = telegramApi();
  const maxMock = maxApi();
  const telegramTransport = telegram(clock, tgApi);
  const maxTransport = max(clock, maxMock);
  const registry = new Map([["telegram", telegramTransport], ["max", maxTransport]]);
  const dir = tempDir(t);
  const stateFile = path.join(dir, "state.json");
  const state = createJsonState({ file: stateFile, now: clock.now });
  state.write({
    version: 1,
    // Недоставленный вопрос: сообщения нет, снимать нечего — важна только очистка.
    pending: [{ shortId: "pend0001", questionId: "q2", chatId: 42, messageId: null }],
    questions: [{
      shortId: "abc12345",
      questionId: "q1",
      chatId: 42,
      messageId: 7,
      deliveries: [
        { transport: "telegram", messageId: 7, chatId: 42 },
        { transport: "max", messageId: "mid.7", chatId: 42 },
      ],
    }],
  });
  const { reliability, logFile } = makeReliability(t, {
    clock,
    transport: telegramTransport,
    transportFor: (id) => registry.get(id) ?? null,
    state,
  });

  const result = await reliability.recoverOrphans();

  assert.deepEqual(result, { cancelled: 2, failed: 0 });

  const tgEdits = tgApi.of("editMessageText");
  assert.equal(tgEdits.length, 1, "Telegram: одна правка, а не текст + отдельное снятие кнопок");
  assert.equal(tgEdits[0].payload.message_id, 7);
  assert.match(tgEdits[0].payload.text, /⌛ вопрос снят \(сессия перезапущена\)/);
  assert.deepEqual(tgEdits[0].payload.reply_markup, { inline_keyboard: [] }, "кнопки сняты");
  assert.equal(tgApi.of("editMessageReplyMarkup").length, 0);

  const maxPuts = maxMock.of("PUT /messages");
  assert.equal(maxPuts.length, 1, "MAX: одна правка");
  assert.equal(maxPuts[0].query.get("message_id"), "mid.7");
  assert.deepEqual(maxPuts[0].payload.attachments, [], "кнопки сняты");
  assert.match(maxPuts[0].payload.text, /⌛ вопрос снят \(сессия перезапущена\)/);

  const stored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepEqual(stored.pending, [], "очередь недоставленных очищена");
  assert.deepEqual(stored.questions, [], "открытые вопросы очищены");

  const journal = fs.readFileSync(logFile, "utf8");
  assert.match(journal, /"event":"question\.expired"/, "снятие видно в журнале");
  assert.match(journal, /"reason":"restart"/);
});

test("084 ошибка правки: question.closeFailed в журнале, но вопрос снят и сессия не страдает", async (t) => {
  const clock = fakeClock();
  const api = telegramApi({
    editMessageText: () => response({ ok: false, description: "message can't be edited" }, 400),
  });
  const transport = telegram(clock, api);
  const { reliability, logFile } = makeReliability(t, { clock, transport });
  const question = openQuestion({ ttlMs: 1_000, now: 0 });
  await transport.sendQuestion(question);
  const outcomes = [];
  reliability.watch(question, { onExpire: (info) => outcomes.push(info) });

  clock.advance(1_001);
  await assert.doesNotReject(() => reliability.tick());

  const journal = fs.readFileSync(logFile, "utf8");
  assert.match(journal, /"event":"question\.closeFailed"/, "неудача правки видна в журнале");
  assert.match(journal, /"event":"question\.expired"/, "вопрос всё равно снят");
  assert.equal(outcomes.length, 1, "исход истечения применён: сессия не ждёт вечно");
});

test("084 429 при правке: повтор с backoff, затем успех — пометка есть, closeFailed нет", async (t) => {
  const clock = fakeClock();
  const api = telegramApi({
    editMessageText: (_payload, count) => (count === 1
      ? response({ ok: false, description: "Too Many Requests", parameters: { retry_after: 1 } }, 429)
      : response({ ok: true, result: true })),
  });
  const transport = telegram(clock, api);
  const { reliability, logFile } = makeReliability(t, { clock, transport });
  const question = openQuestion({ ttlMs: 1_000, now: 0 });
  await transport.sendQuestion(question);
  reliability.watch(question);

  clock.advance(1_001);
  await reliability.tick();

  const edits = api.of("editMessageText");
  assert.equal(edits.length, 2, "429 → повтор правки");
  assert.ok(clock.sleeps.includes(1_000), "пауза взята из retry_after");
  const journal = fs.readFileSync(logFile, "utf8");
  assert.doesNotMatch(journal, /question\.closeFailed/, "успешный повтор не считается неудачей");
  assert.match(journal, /"event":"question\.expired"/);
});
