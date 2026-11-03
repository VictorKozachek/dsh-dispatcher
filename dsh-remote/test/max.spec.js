/**
 * Тесты MAX-транспорта: только фейковый `fetch`, без сети и реальных задержек.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { checkTransport } from "../lib/transport/base.js";
import { MAX_CAPS, createMaxTransport } from "../lib/transport/max.js";

const TOKEN = "max-test-token";

/** Ответ MAX API. */
function response(body, status = 200) {
  return {
    ok: status < 400,
    status,
    async json() {
      return body;
    },
  };
}

/**
 * Фейковый fetch по маршрутам `"METHOD /path"`.
 *
 * `getUpdates` по умолчанию после первой пачки «висит», пока не отменят через
 * signal: так поллинг не крутится вхолостую и тест успевает проверить эффекты.
 */
function fakeFetch(routes = {}) {
  const calls = [];
  let firstUpdates = true;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    const key = `${method} ${parsed.pathname}`;
    calls.push({ key, url: parsed, init, body: init.body === undefined ? null : JSON.parse(init.body) });
    if (parsed.pathname === "/updates") {
      if (firstUpdates && Array.isArray(routes.updates)) {
        firstUpdates = false;
        const batch = routes.updates;
        routes.updates = null;
        return response({ updates: batch, marker: 101 });
      }
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener?.("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    const handler = routes[key] ?? routes[parsed.pathname];
    if (typeof handler === "function") return handler(parsed, init);
    return response({ ok: true, message: { body: { mid: "mid.1" } } });
  };
  return { fetch: fetchImpl, calls };
}

/** Дать транспорту обработать пачку обновлений. */
const settle = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

function question(overrides = {}) {
  return {
    shortId: "a1b2c3d4",
    title: "Деплой",
    body: "Продолжать деплой?",
    options: [
      { id: "o1", label: "Да" },
      { id: "o2", label: "Нет" },
    ],
    ...overrides,
  };
}

function setup(t, overrides = {}) {
  const clock = { value: 0 };
  const sleeps = [];
  const { fetch, calls } = fakeFetch(overrides.routes);
  const transport = createMaxTransport({
    token: TOKEN,
    chatId: 42,
    allowedUserIds: [7],
    fetch,
    now: () => clock.value,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.value += ms;
    },
    jitter: (ms) => ms,
    log: () => {},
    ...overrides.options,
  });
  t.after(() => {
    void transport.stop?.();
  });
  return { transport, calls, clock, sleeps };
}

test("checkTransport проходит; caps соответствуют MAX", () => {
  const { transport } = setup(test, { options: { caps: undefined } });
  assert.deepEqual(checkTransport(transport), { ok: true, missing: [] });
  assert.equal(transport.id, "max");
  assert.equal(transport.caps.maxText, 4000);
  assert.equal(transport.caps.maxOptions, MAX_CAPS.maxOptions);
  assert.equal(transport.caps.inlineButtons, true);
});

test("sendQuestion: POST /messages с кнопками по одной в ряд и payload q:<short>:<option>", async (t) => {
  const { transport, calls } = setup(t);

  const sent = await transport.sendQuestion(question());

  const call = calls.find((item) => item.key === "POST /messages");
  assert.ok(call, "запрос ушёл");
  assert.equal(call.init.headers.authorization, TOKEN, "токен в заголовке, не в query");
  assert.equal(call.url.searchParams.get("chat_id"), "42");
  assert.equal(call.body.format, "html");
  assert.match(call.body.text, /Деплой/);
  assert.deepEqual(call.body.attachments[0].payload.buttons.map((row) => row[0].payload), [
    "q:a1b2c3d4:o1",
    "q:a1b2c3d4:o2",
    "q:a1b2c3d4:free",
  ]);
  assert.equal(sent.messageId, "mid.1");
});

test("sendQuestion: текст усечён под 4000 и экранирован", async (t) => {
  const { transport, calls } = setup(t);

  await transport.sendQuestion(question({ body: "a & b < c ".repeat(600) }));

  const call = calls.find((item) => item.key === "POST /messages");
  assert.ok(call.body.text.length <= 4000, `длина ${call.body.text.length}`);
  assert.match(call.body.text, /…$/, "текст обрезан маркером");
  assert.match(call.body.text, /&amp;/);
  assert.equal(call.body.text.includes("a & b < c"), false, "спецсимволы экранированы");
  assert.equal(/&[a-z]*$/.test(call.body.text), false, "сущность не разорвана");
});

test("нажатие кнопки: message_callback -> /answers и один ответ подписчику", async (t) => {
  const updates = [{
    type: "message_callback",
    timestamp: 1000,
    callback: { callback_id: "cb1", payload: "q:a1b2c3d4:o2", user: { user_id: 7 }, chat: { chat_id: 42 } },
  }];
  const { transport, calls } = setup(t, { routes: { updates } });

  await transport.sendQuestion(question());
  const answers = [];
  transport.onAnswer((answer) => answers.push(answer));
  await transport.start();
  await settle();
  await transport.stop();

  assert.deepEqual(answers, [{ shortId: "a1b2c3d4", optionIds: ["o2"], answeredBy: "7" }]);
  const call = calls.find((item) => item.key === "POST /answers");
  assert.ok(call, "нажатие подтверждено одним запросом");
  assert.equal(call.url.searchParams.get("callback_id"), "cb1");
  assert.match(call.body.text, /Нет/);
});

test("дедуп: одно и то же обновление не обрабатывается дважды", async (t) => {
  const update = {
    type: "message_callback",
    timestamp: 1000,
    callback: { callback_id: "cb1", payload: "q:a1b2c3d4:o1", user: { user_id: 7 }, chat: { chat_id: 42 } },
  };
  const { transport, calls } = setup(t, { routes: { updates: [update, update] } });

  await transport.sendQuestion(question());
  const answers = [];
  transport.onAnswer((answer) => answers.push(answer));
  await transport.start();
  await settle();
  await transport.stop();

  assert.equal(answers.length, 1, "дубль отброшен");
  assert.equal(calls.filter((item) => item.key === "POST /answers").length, 1);
});

test("свободный текст: message_created с reply на сообщение вопроса", async (t) => {
  const updates = [{
    type: "message_created",
    timestamp: 2000,
    message: {
      sender: { user_id: 7 },
      chat: { chat_id: 42 },
      body: { mid: "mid.2", text: "  своим текстом  " },
      link: { type: "reply", mid: "mid.1" },
    },
  }];
  const { transport, calls } = setup(t, { routes: { updates } });

  await transport.sendQuestion(question());
  const answers = [];
  transport.onAnswer((answer) => answers.push(answer));
  await transport.start();
  await settle();
  await transport.stop();

  assert.deepEqual(answers, [{ shortId: "a1b2c3d4", optionIds: [], text: "своим текстом", answeredBy: "7" }]);
  assert.equal(calls.filter((item) => item.key === "POST /answers").length, 0, "текст не требует /answers");
});

test("allowlist: чужой отправитель не доходит до ответчика", async (t) => {
  const updates = [{
    type: "message_callback",
    timestamp: 3000,
    callback: { callback_id: "cb9", payload: "q:a1b2c3d4:o1", user: { user_id: 99 }, chat: { chat_id: 42 } },
  }];
  const { transport, calls } = setup(t, { routes: { updates } });

  await transport.sendQuestion(question());
  const answers = [];
  transport.onAnswer((answer) => answers.push(answer));
  await transport.start();
  await settle();
  await transport.stop();

  assert.deepEqual(answers, []);
  assert.equal(calls.filter((item) => item.key === "POST /answers").length, 0);
});

test("троттлинг: два сообщения подряд ждут 500 мс на фейковых часах", async (t) => {
  const { transport, sleeps } = setup(t);

  await transport.sendQuestion(question({ shortId: "aaaaaaaa" }));
  await transport.sendQuestion(question({ shortId: "bbbbbbbb" }));

  assert.ok(sleeps.includes(500), `пауза между отправками: ${JSON.stringify(sleeps)}`);
});

test("429: ретраит с backoff, потом отправляет", async (t) => {
  let attempts = 0;
  const { transport, sleeps } = setup(t, {
    routes: {
      "POST /messages": () => {
        attempts += 1;
        return response({ code: 429, message: "too many" }, attempts === 1 ? 429 : 200);
      },
    },
  });

  await transport.sendQuestion(question());

  assert.equal(attempts, 2, "первая попытка 429, вторая успешна");
  assert.ok(sleeps.length >= 1, "была пауза backoff");
});

test("сеть: падение fetch ретраится, затем ошибка с понятным текстом", async (t) => {
  const transport = createMaxTransport({
    token: TOKEN,
    chatId: 42,
    fetch: async () => {
      throw new Error("network down");
    },
    now: () => 0,
    sleep: async () => {},
    jitter: (ms) => ms,
    maxAttempts: 2,
    log: () => {},
  });

  await assert.rejects(() => transport.sendQuestion(question()), /network down/);
});

test("marker переживает перезапуск: сохранён и передан в следующем GET /updates", async (t) => {
  const saved = [];
  const { transport, calls } = setup(t, {
    routes: { updates: [] },
    options: { persistMarker: (marker) => saved.push(marker), pollTimeoutSec: 1 },
  });

  await transport.start();
  await settle();
  await transport.stop();
  assert.deepEqual(saved, [101], "marker из ответа сохранён");

  const second = setup(t, { options: { marker: 101, persistMarker: () => {} } });
  await second.transport.start();
  await settle();
  await second.transport.stop();
  const updateCall = second.calls.find((item) => item.key === "GET /updates");
  assert.equal(updateCall.url.searchParams.get("marker"), "101");
  assert.equal(calls.length > 0, true);
});

test("webhook без туннеля: внятная ошибка, а не молчание", async () => {
  const transport = createMaxTransport({
    token: TOKEN,
    chatId: 42,
    webhookUrl: "https://example.com/hook",
    fetch: async () => response({}),
    log: () => {},
  });

  await assert.rejects(() => transport.start(), /HTTPS:443/);
});

test("healthCheck: GET /me и текст ошибки без токена", async (t) => {
  const okSetup = setup(t, { routes: { "GET /me": () => response({ name: "MAX bot" }) } });
  assert.deepEqual(await okSetup.transport.healthCheck(), { ok: true, detail: "бот MAX MAX bot на связи" });

  const bad = createMaxTransport({
    token: TOKEN,
    chatId: 42,
    fetch: async () => response({ message: `unauthorized ${TOKEN}` }, 401),
    log: () => {},
    sleep: async () => {},
    now: () => 0,
  });
  const health = await bad.healthCheck();
  assert.equal(health.ok, false);
  assert.equal(health.detail.includes(TOKEN), false, "токен не печатается");
});

test("closeQuestion правит сообщение без кнопок, editQuestion сохраняет кнопки", async (t) => {
  const { transport, calls } = setup(t);
  await transport.sendQuestion(question());

  assert.equal(await transport.editQuestion(question(), "⏳ осталось 5 минут"), true);
  await transport.closeQuestion(question(), "Да");

  const puts = calls.filter((item) => item.key === "PUT /messages");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].body.attachments[0].type, "inline_keyboard", "напоминание сохраняет кнопки");
  assert.deepEqual(puts[1].body.attachments, [], "закрытие снимает кнопки");
  assert.match(puts[1].body.text, /✅ Отвечено: Да/);
});

test("фича max: webhook в конфиге даёт ошибку в лог, транспорт не поднимается", async () => {
  const { maxFeature } = await import("../lib/features/max.js");
  const errors = [];
  const deps = {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message) => errors.push(message),
    },
    get: () => null,
    onDispose: () => {},
  };
  const ctx = { get: () => null, provide: () => {} };

  await maxFeature.apply(ctx, { max: { webhookUrl: "https://example.com/hook" } }, deps);

  assert.equal(errors.length, 1);
  assert.match(errors[0], /webhook недоступен/);
});
