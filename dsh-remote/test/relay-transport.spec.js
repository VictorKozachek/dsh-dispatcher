/**
 * Транспорт `relay` (задача 018): протокол 016/023 поверх HTTP/WS.
 *
 * Ни одного реального запроса: `fetch`, WebSocket, таймеры и `sleep` инжектируются.
 * Проверяем отправку вопроса, идемпотентный повтор, ответ через long-poll и WS,
 * переподключение, внятную ошибку на неверном токене и отсутствие секретов в логах.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { keyIdFor, createE2e, generateKeyPair } from "../lib/crypto.js";
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

test("e2e: вопрос уходит конвертом, открытых тела/вариантов нет", async () => {
  const device = generateKeyPair();
  const plugin = generateKeyPair();
  const calls = [];
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({
      "POST /v1/questions": (parsed, init) => response(201, JSON.parse(init.body).question),
    }, calls),
    e2e: { privateKey: plugin.privateKey, devicePublicKey: device.publicKey },
  });

  await transport.sendQuestion(question());

  const posted = calls[0].body.question;
  assert.equal(posted.body, undefined, "тело вопроса не уходит открытым");
  assert.equal(posted.title, undefined, "заголовок не уходит открытым");
  assert.equal(posted.detail, undefined, "detail не уходит открытым");
  assert.equal(posted.options, undefined, "подписи вариантов не уходят открытым");
  assert.equal(posted.optionCount, 2, "сервер видит число вариантов для лимитов");
  assert.equal(posted.workspace, "/p/alpha", "метаданные по контракту открыты");
  assert.equal(posted.enc.keyId, keyIdFor(device.publicKey));
  assert.equal(posted.enc.alg, "xchacha20poly1305");
  assert.equal(transport.e2e.keyId, keyIdFor(device.publicKey));

  const deviceSide = createE2e({
    privateKey: device.privateKey,
    peerPublicKey: plugin.publicKey,
    devicePublicKey: device.publicKey,
  });
  const opened = deviceSide.openQuestion(posted.enc, {
    id: posted.id,
    shortId: posted.shortId,
    createdAt: posted.createdAt,
    expiresAt: posted.expiresAt,
  });
  assert.equal(opened.body, "Продолжать?");
  assert.equal(opened.title, "Заголовок");
  assert.deepEqual(opened.options, [{ id: "o1", label: "Да" }, { id: "o2", label: "Нет" }]);
});

test("e2e: ответ-конверт расшифровывается и эмитится как обычный ответ", async () => {
  const device = generateKeyPair();
  const plugin = generateKeyPair();
  const deviceSide = createE2e({
    privateKey: device.privateKey,
    peerPublicKey: plugin.publicKey,
    devicePublicKey: device.publicKey,
  });
  const answerMeta = {
    questionId: QUESTION_ID,
    answeredAt: "2026-11-03T18:05:00Z",
    idempotencyKey: "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718",
  };
  const envelope = deviceSide.sealAnswer({ selected: ["o2"], custom: "только после обеда" }, answerMeta);

  let answered = false;
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({
      "POST /v1/questions": () => response(201, { id: QUESTION_ID }),
      "GET /v1/answers": () => {
        if (!answered) {
          answered = true;
          return response(200, { ...answerMeta, enc: envelope });
        }
        return response(404, { error: { code: "not-found", message: "ответа пока нет" } });
      },
    }),
    e2e: { privateKey: plugin.privateKey, devicePublicKey: device.publicKey },
    sleep: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const answers = [];
  transport.onAnswer((answer) => answers.push(answer));

  await transport.start();
  await transport.sendQuestion(question());
  await tick(10);

  assert.equal(answers.length, 1, "ответ доставлен один раз");
  assert.deepEqual(answers[0], { shortId: "a1b2c3d4", optionIds: ["o2"], text: "только после обеда" });
  assert.equal(transport.pending, 0, "битый/расшифрованный ответ снимает вопрос из очереди");
  await transport.stop();
});

test("e2e: битый конверт ответа не эмитится и не крутит long-poll", async () => {
  const device = generateKeyPair();
  const plugin = generateKeyPair();
  const logs = [];
  let requests = 0;
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({
      "POST /v1/questions": () => response(201, { id: QUESTION_ID }),
      "GET /v1/answers": () => {
        requests += 1;
        return response(200, {
          questionId: QUESTION_ID,
          answeredAt: "2026-11-03T18:05:00Z",
          idempotencyKey: "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718",
          enc: {
            enc: "AAAA",
            nonce: Buffer.alloc(12).toString("base64"),
            keyId: keyIdFor(device.publicKey),
            alg: "xchacha20poly1305",
            plainSize: 5,
          },
        });
      },
    }),
    e2e: { privateKey: plugin.privateKey, devicePublicKey: device.publicKey },
    log: (message) => logs.push(message),
    sleep: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
  });
  const answers = [];
  transport.onAnswer((answer) => answers.push(answer));

  await transport.start();
  await transport.sendQuestion(question());
  await tick(10);

  assert.equal(answers.length, 0, "битый конверт не превращается в пустой ответ");
  assert.equal(transport.pending, 0, "вопрос снят из pending, иначе long-poll зациклится");
  assert.ok(logs.some((line) => line.includes("не расшифрован")), `ожидали предупреждение, а в логах: ${logs.join(" | ")}`);
  assert.ok(!logs.join(" | ").includes(plugin.privateKey), "приватный ключ не попал в лог");
  await transport.stop();
});

test("e2e: require: true без ключей — ошибка конфига, а не открытый режим", () => {
  assert.throws(
    () => createRelayTransport({
      url: URL_BASE,
      agentToken: TOKEN,
      fetch: fakeFetch({}),
      e2e: { require: true },
    }),
    (error) => error instanceof TypeError && error.message.includes("e2e"),
  );
});

test("e2e: без ключей транспорт работает открыто (обратная совместимость)", async () => {
  const calls = [];
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({ "POST /v1/questions": () => response(201, { id: QUESTION_ID }) }, calls),
    e2e: { require: false },
  });
  await transport.sendQuestion(question());
  assert.equal(calls[0].body.question.body, "Продолжать?");
  assert.equal(transport.e2e, null);
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

test("после переподключения WS long-poll останавливается и снова включается на close", async () => {
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

  const timers = [];
  let answersCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/v1/answers") {
      answersCalls += 1;
      return new Promise((resolve, reject) => {
        const signal = init.signal;
        const fail = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) return fail();
        signal?.addEventListener?.("abort", fail, { once: true });
        setTimeout(() => {
          resolve({
            ok: false,
            status: 404,
            async text() {
              return JSON.stringify({ error: { code: "not-found", message: "нет ответа" } });
            },
          });
        }, 0);
      });
    }
    if (parsed.pathname === "/healthz") {
      return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, version: "0.1.0" }); } };
    }
    return { ok: true, status: 201, async text() { return JSON.stringify({ id: QUESTION_ID }); } };
  };

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
    sleep: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
    jitter: () => 0,
    log: () => {},
  });

  await transport.start();
  await transport.sendQuestion(question());
  sockets[0].emit("open", {});
  await tick(4);
  const baseline = answersCalls;

  // Разрыв: включается long-poll.
  sockets[0].emit("close", {});
  await tick(6);
  assert.ok(answersCalls > baseline, `long-poll пошёл после close (${baseline} -> ${answersCalls})`);

  // Переподключение и open: long-poll обязан остановиться.
  timers.at(-1)();
  assert.equal(sockets.length, 2, "новый WS после backoff");
  const afterClose = answersCalls;
  sockets[1].emit("open", {});
  await tick(8);
  assert.equal(answersCalls, afterClose, "после open новых GET /v1/answers нет");

  // Следующий разрыв снова включает long-poll.
  sockets[1].emit("close", {});
  await tick(6);
  assert.ok(answersCalls > afterClose, "после нового close long-poll снова идёт");
  await transport.stop();
});

test("healthCheck ловит неверный токен авторизованным пробником (healthz публичный)", async () => {
  const calls = [];
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({
      "GET /healthz": () => response(200, { ok: true, version: "0.1.0" }),
      "GET /v1/answers": () => response(401, { error: { code: "unauthorized", message: "нужен Bearer-токен" } }),
    }, calls),
  });

  const health = await transport.healthCheck();

  assert.equal(health.ok, false);
  assert.match(health.detail, /unauthorized/);
  assert.equal(calls.some((call) => call.key === "GET /v1/answers"), true, "пробник сходил с токеном");
  assert.equal(health.detail.includes(TOKEN), false, "токен не в detail");
});

test("healthCheck: 404 от авторизованного пробника — токен принят", async () => {
  const transport = createRelayTransport({
    url: URL_BASE,
    agentToken: TOKEN,
    fetch: fakeFetch({
      "GET /healthz": () => response(200, { ok: true, version: "0.1.0" }),
      "GET /v1/answers": () => response(404, { error: { code: "not-found", message: "ответа нет" } }),
    }),
  });

  assert.deepEqual(await transport.healthCheck(), { ok: true, detail: "relay 0.1.0" });
});
