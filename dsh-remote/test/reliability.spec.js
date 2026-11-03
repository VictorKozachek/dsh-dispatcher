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

/** Дать отработать микрозадачам (без реальных задержек). */
const tickMs = async (times = 2) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

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
  const answerHandlers = [];
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
    /** Эмуляция ответа из мессенджера (то, что транспорт отдаёт в onAnswer). */
    answer(event) {
      for (const handler of answerHandlers) handler(event);
    },
    onAnswer(handler) {
      answerHandlers.push(handler);
      return () => {
        const index = answerHandlers.indexOf(handler);
        if (index >= 0) answerHandlers.splice(index, 1);
      };
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
  // Причина служебная (silent в 004): без «✅ Отвечено» и без кнопок.
  for (const { summary } of transport.closed) assert.equal(summary, "restarted");
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


// --- регрессии по ревью 008 -------------------------------------------------

/** Таймер, который «срабатывает» сразу: тесты не ждут реальных секунд. */
const immediateTimer = (callback, _ms) => {
  callback();
  return { unref: () => {}, cancel: () => {} };
};

test("deliver без транспорта не врёт «delivered», а отдаёт give-up", async (t) => {
  const { reliability } = makeReliability(t, { transport: null });
  assert.equal(await reliability.deliver({ question: openQuestion() }), "give-up");
});

test("зависшая отправка ограничена connectTimeoutMs", async (t) => {
  const transport = { id: "fake", caps: {}, sendQuestion: () => new Promise(() => {}) };
  const clock = fakeClock();
  const { reliability } = makeReliability(t, { transport, clock, setTimeout: immediateTimer });

  const started = Date.now();
  assert.equal(await reliability.deliver({ question: openQuestion() }), "give-up");
  assert.ok(Date.now() - started < 2_000, "не ждём реальные 30 секунд");
  assert.equal(reliability.pendingList().length, 1, "вопрос в очереди");
});

test("аборт останавливает deliver: после аборта ничего не отправляется", async (t) => {
  const controller = new AbortController();
  const transport = fakeTransport({ failures: 1 });
  const clock = fakeClock();
  const { reliability } = makeReliability(t, {
    transport,
    clock,
    sleep: async (ms) => {
      clock.sleeps.push(ms);
      controller.abort(); // человек/система отменили, пока шёл backoff
    },
  });

  assert.equal(await reliability.deliver({ question: openQuestion(), signal: controller.signal }), "aborted");
  assert.equal(transport.calls.send, 1, "второй отправки после аборта нет");
});

test("рестарт правит реальное сообщение по сохранённому messageId", async (t) => {
  const clock = fakeClock();
  const state = createJsonState({ file: path.join(tempDir(t), "state.json"), now: clock.now });
  state.write({
    version: 1,
    pending: [],
    questions: [{ shortId: "a1", questionId: "q1", chatId: 42, messageId: 500 }],
  });
  const edited = [];
  const cleared = [];
  const transport = {
    id: "telegram",
    caps: {},
    async editMessage(target, text) { edited.push({ target, text }); },
    async clearButtons(target) { cleared.push(target); },
  };
  const { reliability } = makeReliability(t, { transport, clock, state });

  const result = await reliability.recoverOrphans();

  assert.deepEqual(result, { cancelled: 1, failed: 0 });
  assert.equal(edited[0].target.messageId, 500);
  assert.match(edited[0].text, /сессия перезапущена, вопрос снят/);
  assert.equal(cleared.length, 1, "кнопки сняты");
  assert.deepEqual(reliability.pendingList(), []);
});

test("TTL: зависшая правка не блокирует сторож и исход всё равно применяется", async (t) => {
  const clock = fakeClock();
  const transport = { id: "fake", caps: {}, closeQuestion: () => new Promise(() => {}), editQuestion: () => new Promise(() => {}) };
  const outcomes = [];
  const { reliability } = makeReliability(t, { transport, clock, setTimeout: immediateTimer });
  const question = openQuestion({ ttlMs: 1000, now: 0 });
  reliability.watch(question, { onExpire: (info) => outcomes.push(info) });

  clock.advance(1000);
  await reliability.tick();

  assert.equal(outcomes.length, 1, "исход истечения применён несмотря на зависшую правку");
  assert.equal(outcomes[0].kind, "abort");
  assert.equal(question.status, "expired");
});

test("redact: title, detail и метки вариантов тоже маскируются", async (t) => {
  const token = "123456789:AAH-bot_token-1234567890abcdefghij";
  const transport = fakeTransport();
  const { reliability, files } = makeReliability(t, { transport });
  const question = openQuestion({ options: [{ label: `Да ${token}` }] });
  question.title = `Заголовок ${token}`;
  question.detail = `Детали ${token}`;

  assert.equal(await reliability.deliver({ question }), "delivered");

  const outgoing = transport.sent[0].question;
  assert.equal(JSON.stringify({ title: outgoing.title, detail: outgoing.detail, options: outgoing.options }).includes(token), false);
  assert.match(outgoing.title, /<redacted>/);
  assert.match(outgoing.detail, /<redacted>/);
  assert.match(outgoing.options[0].label, /<redacted>/);

  const state = reliability.store.read();
  assert.equal(JSON.stringify(state).includes(token), false, "секрет не попал и в состояние");
});

test("redact strict: скрываются title, detail и варианты", async (t) => {
  const token = "123456789:AAH-bot_token-1234567890abcdefghij";
  const transport = fakeTransport();
  const { reliability } = makeReliability(t, { transport, redactMode: "strict" });
  const question = openQuestion({ options: [{ label: `Да ${token}` }] });
  question.title = `Заголовок ${token}`;

  assert.equal(await reliability.deliver({ question }), "delivered");

  const outgoing = transport.sent[0].question;
  assert.match(outgoing.title, /вопрос скрыт/);
  assert.match(outgoing.options[0].label, /вариант скрыт/);
  assert.equal(JSON.stringify(outgoing).includes(token), false);
});

test("redact: путь в CamelCase не маскируется, uppercase hex — маскируется", () => {
  const pathWithUppercase = "/Users/Victor/Projects/DSHDispatcher/Worktree008";
  assert.equal(redact(pathWithUppercase), pathWithUppercase, "путь не портим");
  assert.match(redact("hex ABCDEF0123456789ABCDEF0123456789"), /<redacted-hex>/);
});

test("give-up в ответчике: причина закрытия служебная (кнопки снимаются молча)", async () => {
  const transport = fakeTransport();
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({
    transport,
    registry,
    log: () => {},
    now: () => 0,
    deliver: async () => "give-up",
  });

  let nextCalls = 0;
  await answerer.handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: SESSION_ID } },
    () => {
      nextCalls += 1;
      return { answers: [] };
    },
  );

  assert.equal(nextCalls, 1);
  assert.ok(transport.closed.length >= 1);
  assert.equal(transport.closed[0].summary, "undelivered", "служебная причина, без «✅ Отвечено»");
});

test("TTL через ответчик: abort и empty разблокируют сессию", async () => {
  for (const [onExpire, expectReject] of [["abort", true], ["empty", false]]) {
    const clock = fakeClock();
    const transport = fakeTransport();
    const registry = createRegistry({ readState: () => ({ global: true }) });
    const reliability = createReliability({
      transport,
      state: createJsonState({ file: path.join(os.tmpdir(), `dsh-remote-ttl-${onExpire}-${Date.now()}.json`) }),
      logFile: path.join(os.tmpdir(), `dsh-remote-ttl-${onExpire}-${Date.now()}.jsonl`),
      now: clock.now,
      sleep: clock.sleep,
      onExpire,
      setTimeout: immediateTimer,
    });
    const answerer = createAnswerer({ transport, registry, reliability, log: () => {}, now: () => 0 });

    const pending = answerer.handler(
      { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: SESSION_ID } },
      () => ({ answers: [{ id: "q1", selected: ["GUI"] }] }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    // Двигаем время до истечения TTL вопроса (домен ставит 30 минут).
    clock.advance(31 * 60 * 1000);
    await reliability.tick();

    if (expectReject) {
      await assert.rejects(pending, (error) => error.name === "AbortError");
    } else {
      const result = await pending;
      assert.deepEqual(result.answers, [{ id: "q1", selected: [], custom: "(нет ответа)" }]);
    }
    reliability.stop();
  }
});

test("applyLateAnswer без сессии — dropped, даже когда текст передан", async (t) => {
  const { reliability } = makeReliability(t);
  const question = openQuestion();
  question.cancel("aborted");
  question.sessionId = null;

  assert.equal(await reliability.applyLateAnswer({ question, answer: { selected: ["Да"] }, text: "поздно" }), "dropped");
});

test("фича reliability подключена к плагину: сервис, сторож и ответчик", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-relfeat-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const previousState = process.env.DSH_REMOTE_STATE;
  process.env.DSH_REMOTE_STATE = path.join(stateDir, "state.json");
  t.after(() => {
    if (previousState === undefined) delete process.env.DSH_REMOTE_STATE;
    else process.env.DSH_REMOTE_STATE = previousState;
  });

  const polls = [];
  const provided = new Map();
  const hooks = new Map();
  const effects = [];
  const fetchImpl = async (url, init = {}) => {
    const method = url.split("/").pop();
    if (method === "getUpdates") {
      return new Promise((resolve, reject) => {
        polls.push(resolve);
        init.signal?.addEventListener?.("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 1, username: "test_bot" } }; } };
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const ctx = {
    provide: (name, service) => provided.set(name, service),
    get: (name) => {
      if (name === "credentials") return { resolve: async () => ({ value: "123456:TEST-TOKEN", source: "file" }) };
      if (name === "sessionController") return null;
      return provided.get(name) ?? null;
    },
    on: (event, handler, options) => {
      hooks.set(event, (hooks.get(event) ?? []).concat([{ handler, options }]));
      return () => {};
    },
    effect: (execute) => {
      const disposable = execute();
      effects.push(disposable);
      return () => disposable?.();
    },
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  };

  const { apply } = await import("../lib/index.js");
  await apply(ctx, { telegram: { tokenRef: "tg", chatId: 42, allowedUserIds: [7] } });

  const reliability = provided.get("remoteReliability");
  assert.ok(reliability, "сервис устойчивости зарегистрирован");

  const listeners = hooks.get("user-questions/request") ?? [];
  assert.equal(listeners.length, 1, "ответчик подписан после reliability");

  for (const effect of effects) effect?.();
  reliability.stop();
  await provided.get("remoteTransport")?.stop?.();
});

// --- регрессии по второму ревью 008 ----------------------------------------

test("TTL empty: вопрос снимается и из состояния (unwatch списком/tick)", async (t) => {
  const clock = fakeClock();
  const transport = fakeTransport();
  const { reliability } = makeReliability(t, { transport, clock, onExpire: "empty", setTimeout: immediateTimer });
  const question = openQuestion({ ttlMs: 1000, now: 0 });
  reliability.watch(question, { onExpire: () => {} });
  assert.equal(reliability.store.read().questions.length, 1, "вопрос сохранён как открытый");

  clock.advance(1000);
  await reliability.tick();

  assert.equal(question.status, "expired");
  assert.deepEqual(reliability.store.read().questions, [], "после истечения состояние очищено");
});

test("unwatch принимает и массив shortId", (t) => {
  const clock = fakeClock();
  const { reliability } = makeReliability(t, { clock });
  const first = openQuestion({ id: "q1" });
  const second = openQuestion({ id: "q2" });
  reliability.watch(first);
  reliability.watch(second);

  assert.equal(reliability.unwatch([first.shortId, second.shortId]), true);
  assert.deepEqual(reliability.store.read().questions, [], "оба вопроса сняты из состояния");
  assert.deepEqual(reliability.pendingList(), []);
});

test("deliver сохраняет фактический chatId, recover правит по нему", async (t) => {
  const clock = fakeClock();
  const transport = fakeTransport();
  const { reliability } = makeReliability(t, { transport, clock });
  const question = openQuestion();

  assert.equal(await reliability.deliver({ question, chatId: 42 }), "delivered");
  const [saved] = reliability.store.read().questions;
  assert.equal(saved.chatId, 42, "chatId взят из отправки, а не из вопроса (у 002 его нет)");
  assert.equal(saved.messageId, 101);

  const edited = [];
  const restarted = {
    id: "telegram",
    caps: {},
    async editMessage(target, text) { edited.push({ target, text }); },
    async clearButtons() {},
  };
  const { reliability: afterRestart } = makeReliability(t, { transport: restarted, clock, state: reliability.store });
  const result = await afterRestart.recoverOrphans();

  assert.deepEqual(result, { cancelled: 1, failed: 0 });
  assert.deepEqual(edited[0].target, { chatId: 42, messageId: 101 });
});

test("состояние 005 remoteStore без questions не ломает watch и recover", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  // Форма 005: pending/recent есть, questions нет.
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    enabled: { global: true, workspaces: {}, sessions: {} },
    bindings: null,
    pending: [],
    recent: [],
  }));
  const store = createJsonState({ file });
  const transport = fakeTransport();
  const { reliability } = makeReliability(t, { transport, state: store });

  const question = openQuestion();
  reliability.watch(question);
  assert.equal(reliability.store.read().questions.length, 1, "watch добавил questions в чужое состояние");
  assert.equal(reliability.store.read().enabled.global, true, "чужие ключи сохранены");

  const result = await reliability.recoverOrphans();
  assert.equal(result.failed, 0);
});

test("in-flight аборт отменяет саму отправку, а не только гонку", async (t) => {
  const controller = new AbortController();
  const observed = [];
  const transport = {
    id: "fake",
    caps: {},
    sendQuestion: (question, options) => new Promise((resolve, reject) => {
      observed.push(options?.signal);
      options?.signal?.addEventListener?.("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
    closeQuestion: async () => {},
  };
  const { reliability } = makeReliability(t, { transport });

  const pending = reliability.deliver({ question: openQuestion(), signal: controller.signal, chatId: 42 });
  await tickMs(1);
  controller.abort();
  assert.equal(await pending, "aborted");
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.aborted, true, "транспорт увидел отмену");
  assert.equal(typeof observed[0]?.addEventListener, "function", "в транспорт ушёл AbortSignal");
});

test("фасад без канала: deliver не врёт, recover не правит", async (t) => {
  const facade = { __isTransportFacade: true, current: null };
  const { reliability } = makeReliability(t, { transport: facade });

  assert.equal(await reliability.deliver({ question: openQuestion() }), "give-up");
  const result = await reliability.recoverOrphans();
  assert.deepEqual(result, { cancelled: 0, failed: 0 });
});

test("фасад с каналом: recover правит сообщение через current", async (t) => {
  const edited = [];
  const live = {
    id: "telegram",
    caps: {},
    async editMessage(target, text) { edited.push({ target, text }); },
    async clearButtons() {},
    async sendQuestion() { return { messageId: 1 }; },
  };
  const facade = { __isTransportFacade: true, current: live };
  const clock = fakeClock();
  const state = createJsonState({ file: path.join(tempDir(t), "state.json"), now: clock.now });
  state.write({ version: 1, pending: [], questions: [{ shortId: "a1", chatId: 42, messageId: 7 }] });
  const { reliability } = makeReliability(t, { transport: facade, clock, state });

  assert.equal(await reliability.recoverOrphans().then((r) => r.cancelled), 1);
  assert.equal(edited[0].target.messageId, 7, "правка ушла в живой транспорт фасада");
});

test("поздний ответ после закрытия уходит в applyLateAnswer (не игнор)", async () => {
  const transport = fakeTransport();
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const calls = [];
  const reliability = {
    watch: () => {},
    unwatch: () => {},
    applyLateAnswer: async (argument) => {
      calls.push(argument);
      return "steered";
    },
  };
  const answerer = createAnswerer({ transport, registry, reliability, log: () => {}, now: () => 0 });
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

  const controller = new AbortController();
  const pending = answerer.handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: SESSION_ID }, signal: controller.signal },
    () => assert.fail("next() звать нельзя"),
  );
  await tickMs(2);
  const shortId = transport.sent[0].question.shortId;

  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");

  // Ответ на кнопку приходит уже после снятия вопроса.
  transport.answer({ shortId, optionIds: [], text: "поздно" });
  await tickMs(2);

  assert.equal(calls.length, 1, "поздний ответ передан в applyLateAnswer");
  assert.equal(calls[0].question.shortId, shortId);
  assert.deepEqual(calls[0].answer, { selected: [], custom: "поздно" });
});

test("redact: base64 со слэшем маскируется целиком, путь — нет", () => {
  const secret = "aB3+xY/9Pq7Zm2Kd4Ls6Nv8Rt0Uw1Ee3Ff5Gg7Hh9Ii2Jj4Kk6Ll8Mm0Nn2Oo4Pp6Qq8";
  assert.match(redact(secret), /^<redacted-base64>$/);
  assert.equal(redact("/Users/Victor/Projects/DSHDispatcher/Worktree008"), "/Users/Victor/Projects/DSHDispatcher/Worktree008");
  assert.match(redact("base64: QWxhZGRpbjpvcGVuIHNlc2FtZQ1aGVsbG8gd29ybGQ"), /<redacted-base64>/);
});

test("timeout отменяет саму отправку: транспорт видит aborted", async (t) => {
  let seen = null;
  const transport = {
    id: "fake",
    caps: {},
    sendQuestion: (question, options) => {
      seen = options?.signal;
      return new Promise(() => {}); // висит, пока не отменят
    },
    closeQuestion: async () => {},
  };
  const { reliability } = makeReliability(t, { transport, setTimeout: (callback) => setTimeout(callback, 0) });

  assert.equal(await reliability.deliver({ question: openQuestion() }), "give-up");
  assert.equal(seen?.aborted, true, "дедлайн отменил отправку, а не только гонку");
});

test("поздний ответ кнопкой: в steer уходят выбранные метки", async (t) => {
  const clock = fakeClock();
  const promptCalls = [];
  const sessionController = {
    prompt: async (request) => {
      promptCalls.push(request);
    },
  };
  const { reliability } = makeReliability(t, { cluster: clock, sessionController, clock });
  const question = openQuestion({ options: [{ id: "o1", label: "Да" }] });
  question.cancel("aborted");

  assert.equal(
    await reliability.applyLateAnswer({ question, sessionId: "s1", answer: { selected: ["Да"], custom: "" }, text: "" }),
    "steered",
  );
  assert.equal(promptCalls.length, 1);
  assert.match(promptCalls[0].content[0].text, /Да/, "метка варианта попала в steer");
});

test("redact: путь с датами не маскируется, base64 со слэшем — маскируется", () => {
  assert.equal(
    redact("/Users/Victor/Projects/2026/11/03/DSH/Worktree008"),
    "/Users/Victor/Projects/2026/11/03/DSH/Worktree008",
    "путь с большим числом цифр остаётся целым",
  );
  assert.match(redact("QWxh/ZGRpbjpvcGVu/c2FtZQ1hZWxsbw/QWxh/ZGRpbjpvcG"), /<redacted-base64>/);
});

test("tick: закрытый не нами вопрос снимается и из состояния", async (t) => {
  const clock = fakeClock();
  const { reliability } = makeReliability(t, { clock });
  const question = openQuestion();
  reliability.watch(question);
  assert.equal(reliability.store.read().questions.length, 1);

  question.cancel("aborted"); // закрыли в обход answerer
  clock.advance(1000);
  await reliability.tick();

  assert.deepEqual(reliability.store.read().questions, []);
});

test("answerer -> watch/deliver -> state с chatId -> recover после рестарта", async (t) => {
  const clock = fakeClock();
  const chatId = 42;
  const transport = {
    id: "telegram",
    chatId,
    caps: {},
    async sendQuestion() {
      return { messageId: 500 };
    },
    async closeQuestion() {},
    onAnswer: () => () => {},
  };
  const { reliability } = makeReliability(t, { clock, transport });
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({
    transport,
    registry,
    reliability,
    deliver: (argument) => reliability.deliver(argument),
    log: () => {},
    now: () => 0,
  });

  const pending = answerer.handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: SESSION_ID } },
    () => assert.fail("next() звать нельзя"),
  );
  await tickMs(2);

  const [saved] = reliability.store.read().questions;
  assert.equal(saved.chatId, chatId, "chatId живого транспорта сохранён");
  assert.equal(saved.messageId, 500);
  void pending;

  // Рестарт: новый процесс правит сообщение по сохранённым id.
  const edited = [];
  const restarted = {
    id: "telegram",
    caps: {},
    async editMessage(target, text) { edited.push({ target, text }); },
    async clearButtons() {},
  };
  const { reliability: afterRestart } = makeReliability(t, { transport: restarted, clock, state: reliability.store });
  await afterRestart.recoverOrphans();
  assert.deepEqual(edited[0].target, { chatId, messageId: 500 }, "recover не падает на chatId null");
});
