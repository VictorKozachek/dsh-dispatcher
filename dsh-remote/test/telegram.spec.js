/**
 * Тесты Telegram-транспорта на фейковом `fetch`.
 *
 * Реального Bot API здесь нет: `fetch` инжектируется, время и `sleep` — тоже,
 * поэтому сценарий «вопрос → кнопка → ответ», 429, 409, дедуп и остановка цикла
 * проверяются быстро и без сети. Форма апдейтов — из отчёта
 * `docs/research/messengers.md` §1.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createTelegramTransport, TelegramError } from "../lib/transport/telegram.js";
import { checkTransport } from "../lib/transport/base.js";
import { telegramFeature } from "../lib/features/telegram.js";

const TOKEN = "123456:TEST-TOKEN";
const SHORT = "a1b2c3d4";

/** Микрозадачи + макрозадачи: цикл успевает обработать апдейт. */
async function settle(times = 3) {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/** Ответ «как от fetch»: `{status, body}`; хендлер может вернуть ошибку. */
function response(body, status = 200) {
  return { body, status };
}

/**
 * Обёртка над ожиданием с уважением к `signal`: без неё `stop()` не смог бы
 * дождаться цикла, ведь «зависший» опрос в тесте иначе не отменить.
 */
function withAbort(promise, signal) {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Фейковый `fetch`: маршруты по имени метода, журнал вызовов, отмена по `signal`. */
function fakeFetch(routes = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = url.split("/").pop();
    const payload = init.body === undefined ? {} : JSON.parse(init.body);
    const call = { method, payload, url };
    calls.push(call);
    const count = calls.filter((item) => item.method === method).length;
    const route = routes[method];
    const result = await withAbort(
      Promise.resolve(
        route === undefined
          ? response({ ok: true, result: { message_id: 100 + count, username: "test_bot" } })
          : route(call, count),
      ),
      init.signal,
    );
    if (result instanceof Error) throw result;
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return result.body ?? { ok: true, result: {} };
      },
    };
  };
  return { fetch, calls };
}

/**
 * Транспорт с фейковым API. `getUpdates` всегда «висит», пока тест не решит
 * ответить — так цикл не крутится вхолостую и тесты детерминированы.
 */
function setup({ routes = {}, caps, options = {} } = {}) {
  const sleeps = [];
  const logs = [];
  const polls = [];
  const offsets = [];
  const api = fakeFetch({
    sendMessage: (call, count) => response({ ok: true, result: { message_id: 100 + count } }),
    editMessageText: () => response({ ok: true, result: true }),
    editMessageReplyMarkup: () => response({ ok: true, result: true }),
    answerCallbackQuery: () => response({ ok: true, result: true }),
    getMe: () => response({ ok: true, result: { username: "test_bot", id: 42 } }),
    getUpdates: () => new Promise((resolve) => polls.push(resolve)),
    ...routes,
  });

  const transport = createTelegramTransport({
    token: TOKEN,
    chatId: 42,
    allowedUserIds: [7],
    fetch: api.fetch,
    jitter: () => 0,
    now: () => 1_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (message) => logs.push(message),
    persistOffset: (offset) => offsets.push(offset),
    ...(caps === undefined ? {} : { caps }),
    ...options,
  });

  // `calls` — журнал фейкового fetch: тесты смотрят именно на реальные вызовы.
  return { transport, api, calls: api.calls, sleeps, logs, polls, offsets };
}

/** Вопрос в том виде, в каком его отдаёт домен (задача 002). */
function question(overrides = {}) {
  return {
    shortId: SHORT,
    title: "Деплой",
    body: "Продолжать деплой?",
    options: [{ id: "o1", label: "Да" }, { id: "o2", label: "Нет" }],
    ...overrides,
  };
}

/** Апдейт с нажатой кнопкой. */
function callbackUpdate({ updateId = 10, data = `q:${SHORT}:o1`, from = 7, chat = 42 } = {}) {
  return {
    update_id: updateId,
    callback_query: { id: `cb${updateId}`, from: { id: from }, message: { chat: { id: chat } }, data },
  };
}

/** Апдейт со свободным текстом. */
function textUpdate({ updateId = 11, text = "свой ответ", from = 7, chat = 42, replyTo } = {}) {
  return {
    update_id: updateId,
    message: {
      from: { id: from },
      chat: { id: chat },
      text,
      ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }),
    },
  };
}

test("транспорт соответствует контракту 003", () => {
  const { transport } = setup();
  assert.deepEqual(checkTransport(transport), { ok: true, missing: [] });
  assert.equal(transport.id, "telegram");
  assert.equal(transport.caps.maxText, 4096);
});

test("без токена или chatId транспорт не создаётся", () => {
  assert.throws(() => createTelegramTransport({ chatId: 42 }), /токен/);
  assert.throws(() => createTelegramTransport({ token: TOKEN }), /chatId/);
});

test("отправка вопроса: HTML, кнопки по одной в ряд, callback_data из хелперов", async () => {
  const { transport, calls } = setup();
  const sent = await transport.sendQuestion(question({ body: "a < b & c" }));

  const send = calls.find((call) => call.method === "sendMessage");
  assert.equal(send.payload.chat_id, 42);
  assert.equal(send.payload.parse_mode, "HTML");
  assert.match(send.payload.text, /a &lt; b &amp; c/, "HTML экранируется");
  assert.match(send.payload.text, /<b>Деплой<\/b>/, "заголовок жирным");
  assert.deepEqual(send.payload.reply_markup.inline_keyboard, [
    [{ text: "Да", callback_data: `q:${SHORT}:o1` }],
    [{ text: "Нет", callback_data: `q:${SHORT}:o2` }],
  ]);
  assert.equal(sent.messageId, 101);
});

test("длинный текст режется на несколько сообщений, кнопки — на последнем", async () => {
  const { transport, calls } = setup({ caps: { maxText: 10 } });
  await transport.sendQuestion(question({ title: "", body: "слово ".repeat(10).trim(), options: [{ id: "o1", label: "Да" }] }));

  const sends = calls.filter((call) => call.method === "sendMessage");
  assert.ok(sends.length > 1, "текст разбит");
  for (const send of sends.slice(0, -1)) {
    assert.equal(send.payload.reply_markup, undefined, "кнопки только на последнем");
  }
  assert.ok(sends.at(-1).payload.reply_markup.inline_keyboard.length === 1);
});

test("полный цикл: вопрос → кнопка → ответ в onAnswer, «часики» погашены", async () => {
  const { transport, calls, polls } = setup();
  const received = [];
  transport.onAnswer((answer) => received.push(answer));

  await transport.sendQuestion(question());
  await transport.start();

  polls.shift()(response({ ok: true, result: [callbackUpdate()] }));
  await settle();

  const ack = calls.find((call) => call.method === "answerCallbackQuery");
  assert.equal(ack.payload.callback_query_id, "cb10");
  assert.deepEqual(received, [{ shortId: SHORT, optionIds: ["o1"], answeredBy: "7" }]);
  await transport.stop();
});

test("свободный текст на reply: ответ уходит с текстом", async () => {
  const { transport, polls } = setup();
  const received = [];
  transport.onAnswer((answer) => received.push(answer));

  const sent = await transport.sendQuestion(question());
  await transport.start();

  polls.shift()(response({ ok: true, result: [textUpdate({ replyTo: sent.messageId })] }));
  await settle();

  assert.deepEqual(received, [{ shortId: SHORT, text: "свой ответ", answeredBy: "7" }]);
  await transport.stop();
});

test("свободный текст без reply и без единственного вопроса — игнор", async () => {
  const { transport, logs, polls } = setup();
  const received = [];
  transport.onAnswer((answer) => received.push(answer));

  await transport.sendQuestion(question({ shortId: "aaaa1111" }));
  await transport.sendQuestion(question({ shortId: "bbbb2222" }));
  await transport.start();

  polls.shift()(response({ ok: true, result: [textUpdate({ text: "непонятно куда" })] }));
  await settle();

  assert.deepEqual(received, []);
  assert.match(logs.join("\n"), /свободный текст без открытого вопроса/);
  await transport.stop();
});

test("allowlist: чужой from.id и чужой чат игнорируются", async () => {
  const { transport, logs, polls } = setup();
  const received = [];
  transport.onAnswer((answer) => received.push(answer));
  await transport.sendQuestion(question());
  await transport.start();

  polls.shift()(response({
    ok: true,
    result: [
      callbackUpdate({ updateId: 20, from: 99 }),
      callbackUpdate({ updateId: 21, chat: 999 }),
      textUpdate({ updateId: 22, from: 99 }),
    ],
  }));
  await settle();

  assert.deepEqual(received, []);
  assert.match(logs.join("\n"), /чужой апдейт/);
  await transport.stop();
});

test("дедуп: повторный update_id не даёт второго ответа, offset растёт", async () => {
  const { transport, polls, offsets } = setup();
  const received = [];
  transport.onAnswer((answer) => received.push(answer));
  await transport.sendQuestion(question());
  await transport.start();

  polls.shift()(response({ ok: true, result: [callbackUpdate({ updateId: 10 })] }));
  await settle(4);
  polls.shift()(response({ ok: true, result: [callbackUpdate({ updateId: 10 })] }));
  await settle(4);

  assert.equal(received.length, 1, "второй раз тот же апдейт проигнорирован");
  assert.equal(transport.lastUpdateId, 10);
  assert.equal(transport.offset, 11);
  assert.deepEqual(offsets, [11], "offset сохранён для рестарта");
  await transport.stop();
});

test("offset из хранилища продолжает нумерацию после рестарта", async () => {
  const { transport, calls, polls } = setup({ options: { loadOffset: () => 50 } });
  await transport.sendQuestion(question());
  await transport.start();
  await settle();

  const firstPoll = calls.find((call) => call.method === "getUpdates");
  assert.equal(firstPoll.payload.offset, 50, "продолжаем с сохранённого offset");
  assert.deepEqual(firstPoll.payload.allowed_updates, ["message", "callback_query"]);
  assert.ok(firstPoll.payload.timeout >= 25 && firstPoll.payload.timeout <= 50);

  polls.shift()(response({ ok: true, result: [] }));
  await settle();
  await transport.stop();
});

test("429: ждём retry_after и повторяем запрос", async () => {
  let attempts = 0;
  const { transport, sleeps, polls } = setup({
    routes: {
      getUpdates: () => {
        attempts += 1;
        if (attempts === 1) {
          return response({ ok: false, description: "Too Many Requests", parameters: { retry_after: 2 } }, 429);
        }
        return new Promise((resolve) => polls.push(resolve));
      },
    },
  });
  const received = [];
  transport.onAnswer((answer) => received.push(answer));
  await transport.sendQuestion(question());
  await transport.start();
  await settle();

  assert.deepEqual(sleeps, [2000], "ждём ровно retry_after (+джиттер 0)");
  assert.equal(attempts, 2, "запрос повторён");

  polls.shift()(response({ ok: true, result: [callbackUpdate({ updateId: 30 })] }));
  await settle();
  assert.equal(received.length, 1);
  await transport.stop();
});

test("сетевая ошибка: backoff, затем успешный опрос", async () => {
  let attempts = 0;
  const { transport, sleeps, polls } = setup({
    routes: {
      getUpdates: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("fetch failed");
        return new Promise((resolve) => polls.push(resolve));
      },
    },
  });
  await transport.start();
  await settle();

  assert.equal(attempts, 2, "сеть повторили");
  assert.deepEqual(sleeps, [500], "первый backoff — 500 мс");

  polls.shift()(response({ ok: true, result: [] }));
  await settle();
  await transport.stop();
});

test("409 Conflict: внятная ошибка «второй поллер» и остановка цикла", async () => {
  const { transport, logs } = setup({
    routes: {
      getUpdates: () => response(
        { ok: false, description: "Conflict: terminated by other getUpdates request" },
        409,
      ),
    },
  });
  await transport.start();
  await settle();

  assert.ok(transport.lastError instanceof TelegramError);
  assert.equal(transport.lastError.code, 409);
  assert.match(transport.lastError.message, /второй поллер/i);
  assert.equal(transport.polling, false, "цикл остановлен, повторять бессмысленно");
  assert.match(logs.join("\n"), /409/);

  await transport.stop();
});

test("stop() останавливает цикл, даже если опрос висит", async () => {
  const { transport, api } = setup();
  await transport.start();
  await settle();
  const before = api.calls.length;

  await transport.stop();
  await settle();

  assert.equal(transport.polling, false);
  assert.equal(api.calls.length, before, "после stop новых запросов нет");
});

test("closeQuestion: правка текста, кнопки сняты", async () => {
  const { transport, calls } = setup();
  const sent = await transport.sendQuestion(question());

  await transport.closeQuestion(question(), "Да");

  const edit = calls.find((call) => call.method === "editMessageText");
  assert.equal(edit.payload.chat_id, 42);
  assert.equal(edit.payload.message_id, sent.messageId);
  assert.match(edit.payload.text, /✅ <b>Отвечено<\/b>: Да/);
  assert.deepEqual(edit.payload.reply_markup, { inline_keyboard: [] });
});

test("closeQuestion без текста — editMessageReplyMarkup", async () => {
  const { transport, calls } = setup();
  await transport.sendQuestion(question());
  await transport.closeQuestion(question(), "   ");

  assert.ok(calls.some((call) => call.method === "editMessageReplyMarkup"));
  assert.equal(calls.some((call) => call.method === "editMessageText"), false);
});

test("служебная причина закрытия не выдаётся за ответ человека", async () => {
  const { transport, calls } = setup();
  await transport.sendQuestion(question());

  await transport.closeQuestion(question(), "aborted");

  assert.ok(calls.some((call) => call.method === "editMessageReplyMarkup"), "кнопки сняты");
  assert.equal(calls.some((call) => call.method === "editMessageText"), false, "текст не врёт про ответ");
});

test("ошибка правки не ломает ответ", async () => {
  const { transport, logs } = setup({
    routes: {
      editMessageText: () => response({ ok: false, description: "message can't be edited" }, 400),
    },
  });
  await transport.sendQuestion(question());

  await assert.doesNotReject(() => transport.closeQuestion(question(), "Да"));
  assert.match(logs.join("\n"), /правку сообщения/);
});

test("healthCheck: getMe и состояние цикла", async () => {
  const { transport, polls } = setup();
  await transport.start();
  polls.shift()(response({ ok: true, result: [callbackUpdate({ updateId: 77 })] }));
  await settle();

  const health = await transport.healthCheck();
  assert.equal(health.ok, true);
  assert.match(health.detail, /@test_bot/);
  assert.equal(health.polling, true);
  assert.equal(health.lastUpdateId, 77);
  assert.equal(health.chatId, "42");

  await transport.stop();
});

test("healthCheck не пропускает токен в текст ошибки", async () => {
  const { transport } = setup({
    routes: {
      getMe: () => new TypeError(`connect ECONNREFUSED for ${TOKEN}`),
    },
  });

  const health = await transport.healthCheck();
  assert.equal(health.ok, false);
  assert.equal(health.detail.includes(TOKEN), false, "токен вырезан");
  assert.match(health.detail, /<token>/);
});

test("чужой или битый callback_data игнорируется", async () => {
  const { transport, logs, polls } = setup();
  const received = [];
  transport.onAnswer((answer) => received.push(answer));
  await transport.sendQuestion(question());
  await transport.start();

  polls.shift()(response({ ok: true, result: [callbackUpdate({ updateId: 40, data: "чужое:1:2" })] }));
  await settle();

  assert.deepEqual(received, []);
  assert.match(logs.join("\n"), /callback_data не разобрал/);
  await transport.stop();
});

test("повторный start не поднимает второй цикл", async () => {
  const { transport, calls } = setup();
  await transport.start();
  await transport.start();
  await settle();

  assert.equal(calls.filter((call) => call.method === "getUpdates").length, 1);
  await transport.stop();
});

test("отписка onAnswer прекращает доставку", async () => {
  const { transport, polls } = setup();
  const received = [];
  const off = transport.onAnswer((answer) => received.push(answer));
  await transport.sendQuestion(question());
  await transport.start();

  off();
  polls.shift()(response({ ok: true, result: [callbackUpdate({ updateId: 60 })] }));
  await settle();

  assert.deepEqual(received, []);
  await transport.stop();
});

// --- фича: старт/стоп по состоянию -----------------------------------------

/** `deps` каркаса (задача 001): логгер, `get`, `onDispose`. */
function fakeDeps({ services = {} } = {}) {
  const logs = [];
  const disposers = [];
  return {
    logs,
    disposers,
    deps: {
      logger: {
        debug: (message) => logs.push(`debug: ${message}`),
        info: (message) => logs.push(`info: ${message}`),
        warn: (message) => logs.push(`warn: ${message}`),
        error: (message) => logs.push(`error: ${message}`),
      },
      get: (name) => (Object.hasOwn(services, name) ? services[name] : null),
      onDispose: (disposer) => disposers.push(disposer),
    },
  };
}

test("фича telegram заявляет имя и не требует сервисов", () => {
  assert.equal(telegramFeature.name, "telegram");
  assert.deepEqual(telegramFeature.needs, []);
  assert.equal(typeof telegramFeature.apply, "function");
});

test("фича telegram без привязки спит: ни транспорта, ни сети, ни сервиса", () => {
  const ctx = {
    provide: () => assert.fail("без привязки сервис не регистрируется"),
  };
  const { deps, logs, disposers } = fakeDeps();

  assert.doesNotThrow(() => telegramFeature.apply(ctx, {}, deps));

  assert.match(logs.join("\n"), /привязки нет/);
  assert.equal(disposers.length, 0, "снимать нечего");
});

test("фича telegram без токена в credentials спит с предупреждением", () => {
  const ctx = {
    provide: () => assert.fail("без токена сервис не регистрируется"),
  };
  const { deps, logs, disposers } = fakeDeps({
    services: { credentials: { get: () => null } },
  });

  assert.doesNotThrow(() => telegramFeature.apply(ctx, { telegram: { tokenRef: "tg", chatId: 42 } }, deps));

  assert.match(logs.join("\n"), /токена нет в ctx.credentials/);
  assert.equal(disposers.length, 0);
});

test("фича telegram без chatId спит с предупреждением", () => {
  const ctx = {
    provide: () => assert.fail("без chatId сервис не регистрируется"),
  };
  const { deps, logs } = fakeDeps({
    services: { credentials: { get: () => "123456:TEST-TOKEN" } },
  });

  assert.doesNotThrow(() => telegramFeature.apply(ctx, { telegram: { tokenRef: "tg" } }, deps));

  assert.match(logs.join("\n"), /нет chatId/);
});
