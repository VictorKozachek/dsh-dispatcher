/**
 * Тесты устойчивости: доставка с повторами, рестарт, TTL, поздний ответ,
 * redact и журнал.
 *
 * Всё на фейковых часах, фейковом транспорте и временных файлах — без реальных
 * задержек и без сети.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createQuestion } from "../lib/domain/question.js";
import { createRegistry } from "../lib/domain/registry.js";
import { createAnswerer } from "../lib/answerer.js";
import {
  CONNECT_TIMEOUT_MS,
  REMINDER_MS,
  createJsonState,
  createReliability,
  findSecrets,
  redact,
} from "../lib/reliability.js";

const SESSION_ID = "session-s1";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-rel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Часы и сон: время двигается только через `sleep`, реальных задержек нет. */
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
    get clock() {
      return clock;
    },
  };
}

/** Транспорт-пустышка: считает вызовы, умеет падать N раз и «не уметь» правку. */
function fakeTransport({ failures = 0, retryAfterMs = 0, edit = true } = {}) {
  let remaining = failures;
  const sent = [];
  const closed = [];
  const edited = [];
  const calls = { send: 0, close: 0, edit: 0 };
  const transport = {
    id: "fake",
    caps: { inlineButtons: true, editAfterAnswer: true, maxText: 4096, maxOptions: 8 },
    sent,
    closed,
    edited,
    calls,
    async sendQuestion(question, options) {
      calls.send += 1;
      if (remaining > 0) {
        remaining -= 1;
        const error = new Error("нет связи");
        if (retryAfterMs > 0) error.retryAfterMs = retryAfterMs;
        throw error;
      }
      sent.push({ question, options });
      return { messageId: 100 + sent.length };
    },
    async closeQuestion(question, summary) {
      calls.close += 1;
      if (question?.failClose === true) throw new Error("правка не удалась");
      closed.push({ question, summary });
    },
    healthCheck() {
      return { ok: true, detail: "fake на связи" };
    },
  };
  if (edit) {
    transport.editQuestion = async (question, text) => {
      calls.edit += 1;
      edited.push({ question, text });
    };
  }
  return transport;
}

/** Открытый вопрос домена с нужным TTL. */
function openQuestion({ id = "q1", ttlMs = 10 * 60 * 1000, now = 0, options, failClose = false } = {}) {
  const question = createQuestion({
    id,
    question: `Вопрос ${id}`,
    options: options ?? [{ label: "Да" }, { label: "Нет" }],
  }, { now, ttlMs, workspace: "/p/dsh-dispatcher" });
  question.markOpen(now);
  if (failClose) question.failClose = true;
  return question;
}

/** Модуль устойчивости с временными файлами. */
function makeReliability(t, {
  transport = fakeTransport(),
  clock = fakeClock(),
  state = null,
  stateFile,
  logFile,
  onExpire,
  redactMode,
  sessionController = null,
  setInterval: setIntervalImpl,
  connectTimeoutMs,
  ...rest
} = {}) {
  const dir = tempDir(t);
  const files = {
    state: stateFile ?? path.join(dir, "state.json"),
    log: logFile ?? path.join(dir, "log.jsonl"),
  };
  const reliability = createReliability({
    transport,
    state: state ?? createJsonState({ file: files.state, now: clock.now }),
    logFile: files.log,
    sessionController,
    now: clock.now,
    sleep: clock.sleep,
    ...(onExpire === undefined ? {} : { onExpire }),
    ...(redactMode === undefined ? {} : { redactMode }),
    ...(setIntervalImpl === undefined ? {} : { setInterval: setIntervalImpl }),
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    ...rest,
  });
  return { reliability, transport, clock, files, dir };
}

test("доставка с первой попытки", async (t) => {
  const { reliability, transport } = makeReliability(t);
  const question = openQuestion();

  assert.equal(await reliability.deliver({ question }), "delivered");
  assert.equal(transport.calls.send, 1);
  assert.equal(transport.sent[0].question, question);
});

test("недоставка → повторы с backoff → доставлено", async (t) => {
  const transport = fakeTransport({ failures: 2 });
  const clock = fakeClock();
  const { reliability } = makeReliability(t, { transport, clock });

  assert.equal(await reliability.deliver({ question: openQuestion() }), "delivered");
  assert.equal(transport.calls.send, 3, "две неудачи и успех");
  assert.deepEqual(clock.sleeps, [500, 1000], "экспоненциальный backoff");
});

test("retry_after транспорта уважается", async (t) => {
  const transport = fakeTransport({ failures: 1, retryAfterMs: 5000 });
  const clock = fakeClock();
  const { reliability } = makeReliability(t, { transport, clock });

  assert.equal(await reliability.deliver({ question: openQuestion() }), "delivered");
  assert.deepEqual(clock.sleeps, [5000], "ждём ровно retry_after");
});

test("после connectTimeoutMs вопрос уходит в очередь, ответчик получит give-up", async (t) => {
  const transport = fakeTransport({ failures: 1000 });
  const clock = fakeClock();
  const { reliability } = makeReliability(t, { transport, clock });

  assert.equal(await reliability.deliver({ question: openQuestion({ id: "q1" }) }), "give-up");

  assert.ok(clock.clock >= CONNECT_TIMEOUT_MS, `ждали ${clock.clock} мс`);
  const pending = reliability.pendingList();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].questionId, "q1", "в очереди — вопрос, который не доехал");
  assert.equal(pending[0].sessionId, null);
  assert.ok(typeof pending[0].shortId === "string" && pending[0].shortId !== "");
});

test("рестарт: осиротевшие вопросы снимаются и не спамят", async (t) => {
  const clock = fakeClock();
  const dir = tempDir(t);
  const stateFile = path.join(dir, "state.json");
  const state = createJsonState({ file: stateFile, now: clock.now });
  state.write({
    version: 1,
    pending: [
      { shortId: "a1", questionId: "q1", sessionId: SESSION_ID },
      { shortId: "b2", questionId: "q2", sessionId: SESSION_ID },
    ],
    questions: [],
  });
  const transport = fakeTransport();
  const { reliability } = makeReliability(t, { transport, clock, state });

  const result = await reliability.recoverOrphans();

  assert.deepEqual(result, { cancelled: 2, failed: 0 });
  assert.equal(transport.closed.length, 2);
  for (const { summary } of transport.closed) assert.match(summary, /сессия перезапущена, вопрос снят/);
  assert.deepEqual(reliability.pendingList(), [], "очередь очищена — повторно не спамим");
});

test("рестарт: ошибка правки не валит старт и считается", async (t) => {
  const clock = fakeClock();
  const state = createJsonState({ file: path.join(tempDir(t), "state.json"), now: clock.now });
  state.write({
    version: 1,
    pending: [
      { shortId: "a1", questionId: "q1" },
      { shortId: "b2", questionId: "q2", failClose: true },
    ],
    questions: [],
  });
  const transport = fakeTransport();
  const original = transport.closeQuestion;
  transport.closeQuestion = async (question, summary) => {
    if (question?.shortId === "b2") throw new Error("правка невозможна");
    return original(question, summary);
  };
  const { reliability } = makeReliability(t, { transport, clock, state });

  const result = await reliability.recoverOrphans();

  assert.deepEqual(result, { cancelled: 1, failed: 1 });
  assert.deepEqual(reliability.pendingList(), [], "очередь всё равно очищена");
});

test("TTL: напоминание за 5 минут и expired со снятыми кнопками", async (t) => {
  const clock = fakeClock();
  const { reliability, transport } = makeReliability(t, { clock });
  const question = openQuestion({ ttlMs: 10 * 60 * 1000, now: 0 });
  const outcomes = [];
  reliability.watch(question, { sessionId: SESSION_ID, onExpire: (info) => outcomes.push(info) });

  assert.deepEqual(await reliability.tick(), { reminded: 0, expired: 0 }, "рано");

  clock.advance(10 * 60 * 1000 - REMINDER_MS);
  assert.deepEqual(await reliability.tick(), { reminded: 1, expired: 0 });
  assert.equal(transport.edited.length, 1);
  assert.match(transport.edited[0].text, /⏳ осталось 5 минут/);

  clock.advance(REMINDER_MS);
  assert.deepEqual(await reliability.tick(), { reminded: 0, expired: 1 });
  assert.equal(question.status, "expired");
  assert.equal(transport.closed.at(-1).summary, "expired", "кнопки сняты");
  assert.equal(outcomes[0].kind, "abort");
  assert.equal(outcomes[0].error.name, "AbortError");
});

test("TTL: onExpire 'empty' и 'default-first' дают ответ, а не ошибку", async (t) => {
  for (const [onExpire, expected] of [
    ["empty", { selected: [], custom: "(нет ответа)" }],
    ["default-first", { selected: ["Да"] }],
  ]) {
    const clock = fakeClock();
    const question = openQuestion({ ttlMs: 1000, now: 0 });
    const outcomes = [];
    const { reliability } = makeReliability(t, { clock, onExpire });
    reliability.watch(question, { onExpire: (info) => outcomes.push(info) });

    clock.advance(1000);
    await reliability.tick();

    assert.equal(outcomes[0].kind, "answer");
    assert.deepEqual(outcomes[0].answer, { id: "q1", ...expected });
    assert.equal(question.status, "expired");
  }
});

test("TTL: без правки напоминание уходит коротким новым сообщением", async (t) => {
  const clock = fakeClock();
  const transport = fakeTransport({ edit: false });
  const { reliability } = makeReliability(t, { clock, transport });
  const question = openQuestion({ ttlMs: 10 * 60 * 1000, now: 0 });
  reliability.watch(question);

  clock.advance(10 * 60 * 1000 - REMINDER_MS);
  await reliability.tick();

  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0].question.body, /⏳ осталось 5 минут/);
  assert.deepEqual(transport.sent[0].question.options, []);
});

test("сторож включается через setInterval с unref и выключается", () => {
  const intervals = [];
  let unrefCalls = 0;
  const setIntervalImpl = (callback, ms) => {
    intervals.push({ callback, ms });
    return { unref: () => { unrefCalls += 1; } };
  };
  const { reliability } = makeReliability(t2(), { setInterval: setIntervalImpl });

  reliability.start();
  reliability.start();
  assert.equal(intervals.length, 1, "повторный start не плодит таймеры");
  assert.equal(unrefCalls, 1, "unref, чтобы не держать процесс");
  assert.ok(intervals[0].ms > 0);

  reliability.stop();
  reliability.start();
  assert.equal(intervals.length, 2, "после stop таймер создаётся заново");
  reliability.stop();
});

/** Пустой тест-контекст для не-aсинхронных тестов. */
function t2() {
  return { after: (fn) => fn() };
}

test("поздний ответ: открытый вопрос принимается", async (t) => {
  const { reliability } = makeReliability(t);
  const question = openQuestion();

  const result = await reliability.applyLateAnswer({
    question,
    answer: { selected: ["Да"], answeredBy: "7" },
    sessionId: SESSION_ID,
  });

  assert.equal(result, "accepted");
  assert.equal(question.status, "answered");
  assert.deepEqual(question.toAnswer(), { id: "q1", selected: ["Да"] });
});

test("поздний ответ: снятый вопрос уходит в сессию сообщением steer", async (t) => {
  const prompts = [];
  const sessionController = {
    async prompt(request, signal) {
      prompts.push({ request, signal });
      return { accepted: true };
    },
  };
  const { reliability } = makeReliability(t, { sessionController });
  const question = openQuestion();
  question.cancel("aborted");

  const result = await reliability.applyLateAnswer({
    question,
    answer: { selected: [], custom: "поздно" },
    sessionId: SESSION_ID,
  });

  assert.equal(result, "steered");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].request.sessionId, SESSION_ID);
  assert.equal(prompts[0].request.mode, "steer");
  assert.equal(prompts[0].request.content[0].type, "text");
  assert.match(prompts[0].request.content[0].text, /поздно/);
});

test("поздний ответ без сервиса сессий отбрасывается с журналом", async (t) => {
  const { reliability, files } = makeReliability(t);
  const question = openQuestion();
  question.cancel("aborted");

  assert.equal(await reliability.applyLateAnswer({ question, answer: { selected: ["Да"] } }), "dropped");
  assert.match(fs.readFileSync(files.log, "utf8"), /late-answer/);
});

test("redact: маскирует токены, ключи, PEM, base64 и hex", () => {
  const token = "123456789:AAH-bot_token-1234567890abcdefghij";
  assert.equal(redact(`токен ${token}`).includes(token), false);
  assert.match(redact(`токен ${token}`), /\d+:<redacted>/);

  assert.equal(redact("ключ sk-abcdefghijklmnop1234567890").includes("sk-abcdefghijklmnop1234567890"), false);
  assert.match(redact("ключ sk-abcdefghijklmnop1234567890"), /sk-<redacted>/);

  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
  assert.match(redact(pem), /<private key скрыт>/);

  const base64 = "QWxwaGFCZXRhR2FtbWEyMDI2MTIzNDU2Nzg5MEFCQ0RFRg==";
  assert.match(redact(`base ${base64}`), /<redacted-base64>/);

  assert.match(redact("sha 0123456789abcdef0123456789abcdef"), /<redacted-hex>/);
});

test("redactMode warn: секрет в теле маскируется перед отправкой", async (t) => {
  const token = "123456789:AAH-bot_token-1234567890abcdefghij";
  const transport = fakeTransport();
  const { reliability, files } = makeReliability(t, { transport });
  const question = openQuestion();
  question.body = `Мой токен ${token} — продолжать?`;

  assert.equal(await reliability.deliver({ question }), "delivered");

  const sentBody = transport.sent[0].question.body;
  assert.equal(sentBody.includes(token), false, "токен не уехал в мессенджер");
  assert.match(sentBody, /:<redacted>/);
  assert.equal(question.body.includes(token), true, "домен не мутирован");
  assert.match(fs.readFileSync(files.log, "utf8"), /question-redacted/);
});

test("redactMode strict: тело с секретом не отправляется вовсе", async (t) => {
  const token = "123456789:AAH-bot_token-1234567890abcdefghij";
  const transport = fakeTransport();
  const { reliability, files } = makeReliability(t, { transport, redactMode: "strict" });
  const question = openQuestion();
  question.body = `Токен ${token}`;

  assert.equal(await reliability.deliver({ question }), "delivered");

  const sentBody = transport.sent[0].question.body;
  assert.equal(sentBody.includes(token), false);
  assert.match(sentBody, /вопрос скрыт/);
  assert.match(fs.readFileSync(files.log, "utf8"), /question-hidden/);
});

test("redact: обычный текст не портит", () => {
  for (const text of [
    "Удалить ветку task/007 после слияния?",
    "путь /Users/victor/projects/dsh-dispatcher/worktrees/008",
    "слово из сорока строчных букв без цифр aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "https://core.telegram.org/bots/api#sendmessage",
  ]) {
    assert.equal(redact(text), text, `испорчен текст: ${text}`);
    assert.equal(findSecrets(text).redacted, false);
  }
});

test("журнал: без секретов и тел вопросов, с ротацией", async (t) => {
  const clock = fakeClock();
  const { reliability, files } = makeReliability(t, { clock, logMaxBytes: 100 });

  reliability.journal.append({
    event: "send",
    url: "https://api.telegram.org/bot123456789:AAH-bot_token-1234567890abcdefghij/sendMessage",
    body: "секретный текст вопроса",
    text: "и это тоже",
  });
  reliability.journal.append({ event: "ok", shortId: "a1" });
  reliability.journal.append({ event: "ok", shortId: "b2" });

  const content = fs.readFileSync(files.log, "utf8") + (fs.existsSync(`${files.log}.1`) ? fs.readFileSync(`${files.log}.1`, "utf8") : "");
  assert.equal(content.includes("AAH-bot_token"), false, "токен не попал в журнал");
  assert.equal(content.includes("секретный текст вопроса"), false, "тело вопроса не пишется");
  assert.ok(fs.existsSync(`${files.log}.1`), "старый журнал повёрнут в .1");
});

test("healthCheck: транспорт, очередь, сторож и политики", async (t) => {
  const clock = fakeClock();
  const { reliability } = makeReliability(t, { clock });
  reliability.watch(openQuestion());

  const health = await reliability.healthCheck();

  assert.equal(health.ok, true);
  assert.equal(health.transport.detail, "fake на связи");
  assert.equal(health.pending, 0);
  assert.equal(health.watching, 1);
  assert.equal(health.ttl.onExpire, "abort");
  assert.equal(health.redactMode, "warn");
  assert.match(health.log, /log\.jsonl$/);
});

test("конфиг: onExpire и redactMode проверяются", () => {
  assert.throws(() => createReliability({ onExpire: "guess" }), TypeError);
  assert.throws(() => createReliability({ redactMode: "silent" }), TypeError);
});

test("ответчик на give-up возвращает next(): вопрос достаётся GUI", async (t) => {
  // Даже с «пустым» транспортом: доставку делает reliability.
  const transport = fakeTransport();
  delete transport.sendQuestion;
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({
    transport,
    registry,
    log: () => {},
    now: () => 0,
    deliver: async () => "give-up",
  });

  let nextCalls = 0;
  const result = await answerer.handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: SESSION_ID } },
    () => {
      nextCalls += 1;
      return { answers: [{ id: "q1", selected: ["GUI"] }] };
    },
  );

  assert.equal(nextCalls, 1, "ответчик отдал вопрос GUI");
  assert.deepEqual(result, { answers: [{ id: "q1", selected: ["GUI"] }] });
});

