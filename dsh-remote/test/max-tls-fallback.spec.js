/**
 * 048: TLS-фолбэк MAX с `platform-api2.max.ru` на `platform-api.max.ru`.
 *
 * Сертификат api2 выписан Russian Trusted Sub CA (Минцифры), корня нет в
 * trust store macOS/Node, поэтому первый `GET /me` падает. Здесь проверяем на
 * **фейковом fetch** (сеть не нужна) четыре сценария карточки: фолбэк, явное
 * переопределение хоста, обе базы недоступны и показ активного хоста в `doctor`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_API_BASE,
  MAX_API_FALLBACK_BASE,
  createMaxTransport,
  maxApiRequest,
  maxMe,
} from "../lib/transport/max.js";
import { MAX_TOKEN_REF, createRemoteCommands, runDoctorChecks } from "../lib/commands.js";
import { createStore } from "../lib/store.js";

const TOKEN = "max-fake-token-048";
const CHAT_ID = 90210;
const USER_ID = 777;
const CODE = "123456";
const CODE_RANDOM = 0.123456;
const WORKSPACE = "/w";
const SESSION_ID = "s1";

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Ровно то, что бросает Node/undici, когда корня CA нет в trust store. */
function tlsError() {
  const error = new TypeError("fetch failed");
  error.cause = Object.assign(
    new Error("unable to get local issuer certificate"),
    { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" },
  );
  return error;
}

/**
 * MAX API по хостам: `hosts` задаёт поведение (`tls` — бросать TLS-ошибку),
 * остальные хосты отвечают нормально. Все вызовы пишутся в `calls`.
 */
function fakeMaxApi({ me = { name: "max_bot" }, meStatus = 200, updates = [], hosts = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const mode = hosts[parsed.host];
    calls.push({
      host: parsed.host,
      path: parsed.pathname,
      method: init.method ?? "GET",
      url: parsed,
      init,
    });
    if (mode === "tls") throw tlsError();
    if (parsed.pathname === "/me") {
      return meStatus === 200 ? jsonResponse(me) : jsonResponse({ message: "unauthorized" }, meStatus);
    }
    if (parsed.pathname === "/updates") return jsonResponse({ updates: [...updates], marker: 42 });
    return jsonResponse({ ok: true, message: { body: { mid: "mid.1" } } });
  };
  return { fetch: fetchImpl, calls };
}

function question() {
  return { shortId: "q1", question: "Продолжать?", options: [{ id: "yes", label: "Да" }] };
}

// ---------------------------------------------------------------------------
// Транспорт: фолбэк, override, обе базы недоступны
// ---------------------------------------------------------------------------

test("api2 падает по TLS — запрос повторяется на platform-api.max.ru, хост запоминается", async () => {
  const api = fakeMaxApi({ hosts: { "platform-api2.max.ru": "tls" } });
  const transport = createMaxTransport({
    token: TOKEN,
    chatId: 42,
    fetch: api.fetch,
    sleep: async () => {},
    jitter: (ms) => ms,
    log: () => {},
  });

  const health = await transport.healthCheck();

  assert.deepEqual(health, { ok: true, detail: "бот MAX max_bot на связи" });
  assert.deepEqual(api.calls.map((call) => call.host), ["platform-api2.max.ru", "platform-api.max.ru"]);
  assert.equal(api.calls[1].path, "/me", "повторяется тот же запрос");

  assert.equal(transport.apiBase, MAX_API_FALLBACK_BASE, "активный хост — api");
  assert.deepEqual(transport.endpoint, {
    primary: MAX_API_BASE,
    fallback: MAX_API_FALLBACK_BASE,
    active: MAX_API_FALLBACK_BASE,
    fallbackUsed: true,
    overridden: false,
  });
  assert.equal(transport.lastError, null, "ошибка api2 не оседает как последняя");

  // Следующие запросы идут сразу на рабочий хост, без новой попытки api2.
  api.calls.length = 0;
  await transport.sendQuestion(question());
  assert.deepEqual(api.calls.map((call) => call.host), ["platform-api.max.ru"]);
});

test("maxApiBase полностью переопределяет хост и отключает фолбэк", async () => {
  const base = "https://max-proxy.example.test";
  const api = fakeMaxApi({ hosts: { "max-proxy.example.test": "tls" } });
  const transport = createMaxTransport({
    token: TOKEN,
    chatId: 42,
    apiBase: base,
    fetch: api.fetch,
    sleep: async () => {},
    jitter: (ms) => ms,
    log: () => {},
  });

  const health = await transport.healthCheck();

  assert.equal(health.ok, false);
  assert.match(health.detail, /TLS к MAX не проходит/);
  assert.match(health.detail, /Russian Trusted/);
  assert.match(health.detail, /NODE_EXTRA_CA_CERTS=/);
  assert.match(health.detail, /maxApiBase\/MAX_API_BASE/, "подсказка про снятие переопределения");
  assert.doesNotMatch(health.detail, /fetch failed/i);
  assert.deepEqual(api.calls.map((call) => call.host), ["max-proxy.example.test"], "на api не ходили");
  assert.deepEqual(transport.endpoint, {
    primary: base,
    fallback: null,
    active: base,
    fallbackUsed: false,
    overridden: true,
  });
});

test("обе базы недоступны по TLS — текст про Russian Trusted CA и два варианта", async () => {
  const api = fakeMaxApi({
    hosts: { "platform-api2.max.ru": "tls", "platform-api.max.ru": "tls" },
  });
  const transport = createMaxTransport({
    token: TOKEN,
    chatId: 42,
    fetch: api.fetch,
    sleep: async () => {},
    jitter: (ms) => ms,
    log: () => {},
  });

  const health = await transport.healthCheck();

  assert.equal(health.ok, false);
  assert.match(health.detail, /TLS к MAX не проходит/);
  assert.match(health.detail, /Russian Trusted Sub CA/);
  assert.match(health.detail, /platform-api2\.max\.ru и platform-api\.max\.ru/, "сказано, что пробовали обе");
  assert.match(health.detail, /Варианты: \(а\)/);
  assert.match(health.detail, /\(б\) добавить корень Минцифры/);
  assert.match(health.detail, /NODE_EXTRA_CA_CERTS=\/путь\/к\/russian_trusted_root_ca\.pem/);
  assert.doesNotMatch(health.detail, /fetch failed/i, "вместо «fetch failed» — объяснение");
  assert.equal(transport.endpoint.fallbackUsed, true);
  assert.deepEqual(api.calls.map((call) => call.host), ["platform-api2.max.ru", "platform-api.max.ru"]);
});

test("401 не подменяет хост: фолбэк только на TLS/сеть", async () => {
  const api = fakeMaxApi({ meStatus: 401 });
  await assert.rejects(
    () => maxApiRequest({ token: TOKEN, path: "/me", fetch: api.fetch }),
    (error) => {
      assert.equal(error.status, 401);
      assert.match(error.message, /401/);
      return true;
    },
  );
  assert.deepEqual(api.calls.map((call) => call.host), ["platform-api2.max.ru"], "одна попытка, без api");
});

test("MAX_API_BASE из окружения переопределяет хост и отключает фолбэк", async (t) => {
  const previous = process.env.MAX_API_BASE;
  process.env.MAX_API_BASE = "https://max-env.example.test";
  t.after(() => {
    if (previous === undefined) delete process.env.MAX_API_BASE;
    else process.env.MAX_API_BASE = previous;
  });
  const api = fakeMaxApi({ hosts: { "max-env.example.test": "tls" } });

  await assert.rejects(() => maxMe({ token: TOKEN, fetch: api.fetch }), (error) => {
    assert.equal(error.code, "MAX_TLS");
    assert.match(error.message, /Russian Trusted/);
    return true;
  });
  assert.deepEqual(api.calls.map((call) => call.host), ["max-env.example.test"]);
});

test("maxMe возвращает рабочую базу, если api2 не прошёл TLS", async () => {
  const api = fakeMaxApi({ hosts: { "platform-api2.max.ru": "tls" } });
  const me = await maxMe({ token: TOKEN, fetch: api.fetch });

  assert.equal(me.name, "max_bot");
  assert.equal(me.apiBase, MAX_API_FALLBACK_BASE);
  assert.equal(me.fallbackUsed, true);
  assert.equal(me.primaryBase, MAX_API_BASE);
});

// ---------------------------------------------------------------------------
// `/remote connect` → MAX: фолбэк на живой ветке подключения
// ---------------------------------------------------------------------------

function fakeCredentials({ values = {} } = {}) {
  const map = new Map(Object.entries(values));
  return {
    values: map,
    resolve: async (ref) => (map.has(ref) ? { value: map.get(ref), source: "file" } : undefined),
    describe: async (ref) => ({
      present: map.has(ref),
      configured: map.has(ref),
      source: map.has(ref) ? "file" : null,
      writable: true,
    }),
    set: async (ref, secret) => {
      map.set(ref, secret);
      return true;
    },
    unset: async (ref) => {
      map.delete(ref);
      return true;
    },
  };
}

function scriptedAsk(answers) {
  const asked = [];
  return {
    asked,
    ask: async (request) => {
      const item = request.questions[0];
      asked.push(item);
      const answer = answers[item.id];
      if (answer === undefined) throw new Error(`нет сценария для ${item.id}`);
      return {
        answers: [{
          id: item.id,
          selected: answer.selected ?? [],
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        }],
      };
    },
  };
}

const CONNECT_ANSWERS = {
  "remote-connect-transport": { selected: ["MAX"] },
  "remote-connect-max-token": { custom: TOKEN },
  "remote-connect-max-send-code": { selected: ["Отправил"] },
  "remote-connect-scope": { selected: ["Пока не включать"] },
};

const pairingUpdates = [{
  type: "message_created",
  message: {
    body: { text: CODE },
    chat: { chat_id: CHAT_ID },
    sender: { user_id: USER_ID },
  },
}];

const invoke = (rawInput) => ({
  commandId: "c1",
  agent: { id: "agent-1", session: { id: SESSION_ID } },
  rawInput,
  signal: new AbortController().signal,
});

function connectHarness(t, { fetchImpl, answers = CONNECT_ANSWERS, options = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-max-tls-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ file: path.join(dir, "state.json") });
  const credentials = fakeCredentials();
  const { ask } = scriptedAsk(answers);
  const logs = [];
  let clock = 1_000_000;
  const remote = createRemoteCommands({
    ctx: {
      get(name) {
        if (name === "sessions") return { get: () => ({ header: { cwd: WORKSPACE } }) };
        if (name === "credentials") return credentials;
        if (name === "userQuestions") return { ask };
        return null;
      },
      userQuestions: { ask },
    },
    store,
    log: (message) => logs.push(message),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    random: () => CODE_RANDOM,
    fetch: fetchImpl,
    ensureTransport: async () => ({ id: "max", async start() { return true; } }),
    ...options,
  });
  return { store, remote, credentials, logs };
}

test("connect MAX: api2 падает по TLS — pairing идёт через platform-api.max.ru", async (t) => {
  const api = fakeMaxApi({ hosts: { "platform-api2.max.ru": "tls" }, updates: pairingUpdates });
  const stand = connectHarness(t, { fetchImpl: api.fetch });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /бот MAX «max_bot» привязан/);
  assert.equal(stand.store.read().bindings.transport, "max");
  assert.equal(stand.store.read().bindings.chatId, CHAT_ID);
  assert.equal(stand.credentials.values.get(MAX_TOKEN_REF), TOKEN, "токен сохранён после проверки через api");

  const meCalls = api.calls.filter((call) => call.path === "/me");
  assert.deepEqual(meCalls.map((call) => call.host), ["platform-api2.max.ru", "platform-api.max.ru"]);
  const updatesCalls = api.calls.filter((call) => call.path === "/updates");
  assert.ok(updatesCalls.length > 0, "pairing опрашивал /updates");
  for (const call of updatesCalls) {
    assert.equal(call.host, "platform-api.max.ru", "pairing идёт по рабочему хосту, без повторного падения на api2");
  }
  assert.ok(
    stand.logs.some((line) => /platform-api2\.max\.ru недоступен по TLS — работаю через platform-api\.max\.ru/.test(line)),
    "в лог записан факт фолбэка",
  );
});

test("connect MAX: TLS к обеим базам — объяснение и варианты вместо «не принял токен»", async (t) => {
  const api = fakeMaxApi({
    hosts: { "platform-api2.max.ru": "tls", "platform-api.max.ru": "tls" },
  });
  const stand = connectHarness(t, { fetchImpl: api.fetch });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /TLS к MAX не проходит/);
  assert.match(result.text, /Russian Trusted/);
  assert.match(result.text, /NODE_EXTRA_CA_CERTS/);
  assert.match(result.text, /platform-api\.max\.ru/);
  assert.doesNotMatch(result.text, /MAX не принял токен/);
  assert.doesNotMatch(result.text, /fetch failed/i);
  assert.equal(stand.store.read().bindings, null, "привязки нет");
  assert.equal(stand.credentials.values.has(MAX_TOKEN_REF), false, "токен не сохранён");
});

test("connect MAX: явный maxApiBase (config) отключает фолбэк", async (t) => {
  const base = "https://max-proxy.example.test";
  const api = fakeMaxApi({ hosts: { "max-proxy.example.test": "tls" }, updates: pairingUpdates });
  const stand = connectHarness(t, { fetchImpl: api.fetch, options: { maxApiBase: base } });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /TLS к MAX не проходит/);
  assert.match(result.text, /maxApiBase\/MAX_API_BASE/);
  assert.deepEqual(api.calls.map((call) => call.host), ["max-proxy.example.test"], "на platform-api не ходили");
});

// ---------------------------------------------------------------------------
// doctor: активный хост
// ---------------------------------------------------------------------------

test("doctor показывает активный хост MAX и причину фолбэка", async () => {
  const api = fakeMaxApi({ hosts: { "platform-api2.max.ru": "tls" } });
  const transport = createMaxTransport({
    token: TOKEN,
    chatId: 42,
    fetch: api.fetch,
    sleep: async () => {},
    jitter: (ms) => ms,
    log: () => {},
  });
  await transport.healthCheck();

  const checks = await runDoctorChecks({
    store: { read: () => ({ bindings: { transport: "max", chatId: CHAT_ID, userId: USER_ID } }) },
    credentials: {
      availableFor: () => true,
      resolve: async () => TOKEN,
      describe: async () => ({ present: true, source: "file", writable: true }),
    },
    transport,
  });

  const channel = checks.find((check) => check.title === "канал");
  assert.equal(channel.level, "ok", channel.detail);
  assert.match(channel.detail, /marker \?; polling нет/);
  assert.match(channel.detail, /хост platform-api\.max\.ru \(фолбэк, platform-api2\.max\.ru — TLS\)/);
});

test("doctor: при явном maxApiBase видно, что хост задан, а не подобран фолбэком", async () => {
  const base = "https://max-proxy.example.test";
  const api = fakeMaxApi({});
  const transport = createMaxTransport({
    token: TOKEN,
    chatId: 42,
    apiBase: base,
    fetch: api.fetch,
    sleep: async () => {},
    log: () => {},
  });
  await transport.healthCheck();

  const checks = await runDoctorChecks({
    store: { read: () => ({ bindings: { transport: "max", chatId: CHAT_ID, userId: USER_ID } }) },
    credentials: {
      availableFor: () => true,
      resolve: async () => TOKEN,
      describe: async () => ({ present: true, source: "file", writable: true }),
    },
    transport,
  });

  const channel = checks.find((check) => check.title === "канал");
  assert.equal(channel.level, "ok", channel.detail);
  assert.match(channel.detail, /хост max-proxy\.example\.test \(задан maxApiBase\/MAX_API_BASE\)/);
});
