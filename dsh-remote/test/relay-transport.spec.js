/**
 * Транспорт `relay` (задача 018): протокол 016/023 поверх HTTP/WS.
 *
 * Ни одного реального запроса: `fetch`, WebSocket, таймеры и `sleep` инжектируются.
 * Проверяем отправку вопроса, идемпотентный повтор, ответ через long-poll и WS,
 * переподключение, внятную ошибку на неверном токене и отсутствие секретов в логах.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { checkTransport } from "../lib/transport/base.js";
import { RELAY_TOKEN_REF, RelayError, createRelayTransport, redact } from "../lib/transport/relay.js";

const URL_BASE = "https://relay.test";
const TOKEN = "agent-token-SECRET-123456";
const QUESTION_ID = "11111111-1111-4111-8111-111111111111";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body === undefined ? "" : JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

/** Фейковый HTTP: маршруты по `${method} ${pathname}`. */
function fakeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const key = `${init.method ?? "GET"} ${parsed.pathname}`;
    calls.push({ key, url: parsed, init, body: init.body === undefined ? null : JSON.parse(init.body) });
    const route = routes[key];
    if (route === undefined) return response(404, { error: { code: "not-found", message: "нет маршрута" } });
    return typeof route === "function" ? route(parsed, init) : response(...route);
  };
}

function question(overrides = {}) {
  return {
    id: QUESTION_ID,
    shortId: "a1b2c3d4",
    questionId: "q-1",
    title: "Заголовок",
    body: "Продолжать?",
    options: [{ id: "o1", label: "Да" }, { id: "o2", label: "Нет" }],
    workspace: "/p/alpha",
    taskId: "018",
    role: "worker",
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_001_800_000,
    ...overrides,
  };
}

const tick = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("транспорт проходит checkTransport и имеет caps релея", () => {
  const transport = createRelayTransport({ url: URL_BASE, agentToken: TOKEN, fetch: fakeFetch({}) });
  const result = checkTransport(transport);
  assert.equal(result.ok, true, `не хватает: ${result.missing.join(", ")}`);
  assert.equal(transport.id, "relay");
  assert.equal(transport.caps.inlineButtons, false, "кнопки рисует клиент релея");
  assert.equal(transport.caps.editAfterAnswer, false, "правки сообщения в протоколе нет");
  assert.equal(transport.caps.maxText, 4000);
});

test("sendQuestion: POST /v1/questions с версией и Bearer; повтор не дублирует", async () => {
  const stored = new Map();
  const calls = [];
  const fetchImpl = fakeFetch({
    "POST /v1/questions": (parsed, init) => {
      const questionId = JSON.parse(init.body).question.id;
      stored.set(questionId, JSON.parse(init.body).question);
      return response(201, stored.get(questionId));
    },
  }, calls);
  const transport = createRelayTransport({ url: URL_BASE, agentToken: TOKEN, fetch: fetchImpl });

  const first = await transport.sendQuestion(question());
  const second = await transport.sendQuestion(question());

  assert.equal(first.messageId, QUESTION_ID);
  assert.equal(second.messageId, QUESTION_ID);
  assert.equal(stored.size, 1, "повтор с тем же id не создал второй вопрос");
  assert.equal(calls.length, 2, "сеть была дважды — идемпотентность на сервере");
  const [{ init, body }] = calls;
  assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers["x-relay-version"], "1");
  assert.equal(body.version, 1);
  assert.equal(body.question.id, QUESTION_ID);
  assert.deepEqual(body.question.options, [{ id: "o1", label: "Да" }, { id: "o2", label: "Нет" }]);
  assert.equal(body.question.workspace, "/p/alpha");
});

test("closeQuestion снимает вопрос локально: протокол закрытия не имеет", async () => {
  const calls = [];
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({ "POST /v1/questions": () => response(201, { id: QUESTION_ID }) }, calls),
  });
  await transport.sendQuestion(question());
  assert.equal(transport.pending, 1);

  await transport.closeQuestion({ id: QUESTION_ID });

  assert.equal(transport.pending, 0, "вопрос больше не ждёт ответа");
  assert.equal(calls.length, 1, "никакого сетевого PATCH не было");
});

test("healthCheck: ok и внятная ошибка на неверном токене без утечки секрета", async () => {
  const good = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({ "GET /healthz": () => response(200, { ok: true, version: "0.1.0" }) }),
  });
  assert.deepEqual(await good.healthCheck(), { ok: true, detail: "relay 0.1.0" });

  const bad = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({ "GET /healthz": () => response(401, { error: { code: "unauthorized", message: "нужен Bearer-токен" } }) }),
  });
  const health = await bad.healthCheck();
  assert.equal(health.ok, false);
  assert.match(health.detail, /unauthorized/);
  assert.equal(health.detail.includes(TOKEN), false, "токен не попал в detail");

  const down = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const downHealth = await down.healthCheck();
  assert.equal(downHealth.ok, false);
  assert.match(downHealth.detail, /сеть недоступна/);
});

test("ответ приходит long-poll'ом, когда WebSocket недоступен", async () => {
  let answered = false;
  const fetchImpl = fakeFetch({
    "POST /v1/questions": () => response(201, { id: QUESTION_ID }),
    "GET /v1/answers": () => {
      if (!answered) {
        answered = true;
        return response(200, { selected: ["o1"], answeredAt: "2026-11-03T18:00:00Z" });
      }
      return response(404, { error: { code: "not-found", message: "ответа пока нет" } });
    },
  });
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fetchImpl,
    sleep: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const answers = [];
  transport.onAnswer((answer) => answers.push(answer));

  await transport.start(); // wsFactory нет -> long-poll
  await transport.sendQuestion(question());
  await tick(10);

  assert.equal(answers.length, 1, "ответ доставлен один раз");
  assert.deepEqual(answers[0], { shortId: "a1b2c3d4", optionIds: ["o1"] });
  await transport.stop();
});

test("WS: событие question.answered забирает ответ, close переподключает с backoff", async () => {
  const sockets = [];
  class FakeSocket {
    constructor(url, headers) {
      this.url = url;
      this.headers = headers;
      this.listeners = new Map();
      this.closed = false;
      sockets.push(this);
    }

    addEventListener(name, handler) {
      const list = this.listeners.get(name) ?? [];
      list.push(handler);
      this.listeners.set(name, list);
    }

    emit(name, event) {
      for (const handler of this.listeners.get(name) ?? []) handler(event);
    }

    close() {
      this.closed = true;
      this.emit("close", {});
    }
  }

  const timers = [];
  const fetchImpl = fakeFetch({
    "GET /healthz": () => response(200, { ok: true, version: "0.1.0" }),
    "POST /v1/questions": () => response(201, { id: QUESTION_ID }),
    "GET /v1/answers": () => response(200, { selected: ["o2"], custom: "свободный текст" }),
  });
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fetchImpl,
    wsFactory: (url, headers) => new FakeSocket(url, headers),
    setTimeout: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => {},
    jitter: () => 0,
    log: () => {},
  });
  const answers = [];
  transport.onAnswer((answer) => answers.push(answer));

  await transport.start();
  assert.equal(sockets.length, 1, "WS открыт");
  assert.equal(sockets[0].headers.authorization, `Bearer ${TOKEN}`, "WS с заголовком авторизации");
  assert.equal(sockets[0].url, `${URL_BASE}/v1/events`);

  await transport.sendQuestion(question());
  sockets[0].emit("open", {});
  sockets[0].emit("message", { data: JSON.stringify({ type: "question.answered", questionId: QUESTION_ID }) });
  await tick();

  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], { shortId: "a1b2c3d4", optionIds: ["o2"], text: "свободный текст" });

  sockets[0].close();
  assert.equal(timers.length >= 1, true, "переподключение запланировано с backoff");
  timers.at(-1)(); // срабатывает таймер backoff
  assert.equal(sockets.length, 2, "после разрыва открыт новый WS");
  await transport.stop();
});

test("секреты не попадают в логи, pairing-кода в транспорте нет", async () => {
  const logs = [];
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({ "GET /healthz": () => response(401, { error: { code: "unauthorized", message: TOKEN } }) }),
    log: (message) => logs.push(message),
  });
  await transport.healthCheck();
  await transport.closeQuestion({ id: QUESTION_ID });

  assert.equal(logs.some((message) => message.includes(TOKEN)), false, "токен вырезан из логов");
  assert.equal(redact(`error ${TOKEN}`, TOKEN), "error ***");
});

test("RelayError: код протокола и retryable сохраняются", async () => {
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({ "POST /v1/questions": () => response(500, { error: { code: "internal", message: "сбой", retryable: true } }) }),
  });
  await assert.rejects(transport.sendQuestion(question()), (error) => {
    assert.ok(error instanceof RelayError);
    assert.equal(error.status, 500);
    assert.equal(error.code, "internal");
    assert.equal(error.retryable, true);
    return true;
  });
});

// --- регрессии по ревью 018 -------------------------------------------------

test("keyId не уходит в открытый Question, allowFreeText: true отправляется", async () => {
  const calls = [];
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    keyId: "key-2026-11",
    fetch: fakeFetch({ "POST /v1/questions": () => response(201, { id: QUESTION_ID }) }, calls),
  });

  await transport.sendQuestion(question({ allowFreeText: true }));

  const body = calls[0].body.question;
  assert.equal("keyId" in body, false, "016/023 не знает поля keyId — релей 017 отверг бы его");
  assert.equal(body.allowFreeText, true, "булево поле передаётся и как true");
});

test("question.expired снимает вопрос с ожидания (WS)", async () => {
  const sockets = [];
  class FakeSocket {
    constructor(url, headers) {
      this.url = url;
      this.headers = headers;
      this.listeners = new Map();
      sockets.push(this);
    }

    addEventListener(name, handler) {
      const list = this.listeners.get(name) ?? [];
      list.push(handler);
      this.listeners.set(name, list);
    }

    emit(name, event) {
      for (const handler of this.listeners.get(name) ?? []) handler(event);
    }

    close() {
      this.emit("close", {});
    }
  }

  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({
      "GET /healthz": () => response(200, { ok: true, version: "0.1.0" }),
      "POST /v1/questions": () => response(201, { id: QUESTION_ID }),
    }),
    wsFactory: (url, headers) => new FakeSocket(url, headers),
    setTimeout: () => 1,
    clearTimeout: () => {},
    log: () => {},
  });

  await transport.start();
  await transport.sendQuestion(question());
  assert.equal(transport.pending, 1);

  sockets[0].emit("open", {});
  sockets[0].emit("message", { data: JSON.stringify({ type: "question.expired", questionId: QUESTION_ID }) });
  await tick();

  assert.equal(transport.pending, 0, "истёкший вопрос больше не ждёт ответа");
  await transport.stop();
});

test("onAnswer: подписка и отписка, повтор ответа не дублируется", async () => {
  const transport = createRelayTransport({ url: URL_BASE, agentToken: TOKEN, fetch: fakeFetch({}) });
  const answers = [];
  const off = transport.onAnswer((answer) => answers.push(answer));
  assert.equal(typeof off, "function");
  off();
  assert.throws(() => transport.onAnswer("не функция"), TypeError);
});
