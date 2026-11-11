/**
 * MAX через `/remote connect` (039): подключение, pairing-код, переключение с
 * Telegram (038), ошибки токена и статус/doctor. Всё на фейковом `fetch` — без
 * сети, реальных задержек и профиля MAX.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MAX_TOKEN_REF,
  TELEGRAM_TOKEN_REF,
  createRemoteCommands,
  runDoctorChecks,
} from "../lib/commands.js";
import { RELAY_TOKEN_REF } from "../lib/transport/relay.js";
import { MAX_API_BASE, createMaxTransport } from "../lib/transport/max.js";
import { callbackData } from "../lib/transport/base.js";
import { createStore } from "../lib/store.js";
import { createAnswerer } from "../lib/answerer.js";
import { createRegistry } from "../lib/domain/registry.js";

const TOKEN = "max-test-token";
const TELEGRAM_TOKEN = "111:TELEGRAM-TEST";
const WORKSPACE = "/p";
const SESSION_ID = "s1";
const CODE_RANDOM = 0.123456;
const CODE = "123456";
const CHAT_ID = 90210;
const USER_ID = 777;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Маршруты MAX API: `fetch(url, init)` с записью вызовов. */
function maxFetch({ me = { name: "max_bot" }, meStatus = 200, updates = null, onUpdates = null } = {}) {
  const calls = [];
  let batch = updates;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ key: `${method} ${parsed.pathname}`, url: parsed, init });
    if (parsed.pathname === "/me") {
      return meStatus === 200 ? jsonResponse(me) : jsonResponse({ message: "unauthorized" }, meStatus);
    }
    if (parsed.pathname === "/updates") {
      const next = typeof onUpdates === "function" ? onUpdates(parsed, calls) : batch;
      const result = next ?? [];
      batch = null;
      return jsonResponse({ updates: result, marker: 42 });
    }
    return jsonResponse({ ok: true, message: { body: { mid: "mid.1" } } });
  };
  return { fetch: fetchImpl, calls };
}

function fakeCredentials({ values = {} } = {}) {
  const map = new Map(Object.entries(values));
  const calls = [];
  return {
    calls,
    values: map,
    resolve: async (ref) => (map.has(ref) ? { value: map.get(ref), source: "file" } : undefined),
    describe: async (ref) => ({
      present: map.has(ref),
      configured: map.has(ref),
      source: map.has(ref) ? "file" : null,
      writable: true,
    }),
    set: async (ref, secret) => {
      calls.push(["set", ref]);
      map.set(ref, secret);
      return true;
    },
    unset: async (ref) => {
      calls.push(["unset", ref]);
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

function harness(t, { bindings = null, credentials = fakeCredentials(), answers = {}, fetchImpl, ensureTransport } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-max-connect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ file: path.join(dir, "state.json") });
  if (bindings !== null) {
    const state = store.read();
    state.bindings = bindings;
    store.write(state);
  }

  let clock = 1_000_000;
  const { ask, asked } = scriptedAsk(answers);
  const ensured = [];
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
    log: () => {},
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    random: () => CODE_RANDOM,
    fetch: fetchImpl,
    ensureTransport: ensureTransport === undefined
      ? async () => {
        ensured.push(true);
        return { id: "max", async start() { return true; } };
      }
      : ensureTransport,
  });
  return { store, remote, credentials, asked, ensured };
}

const MAX_ANSWERS = {
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

test("connect MAX: токен проверен, pairing-код, привязка и переключение с Telegram", async (t) => {
  const credentials = fakeCredentials({ values: { [TELEGRAM_TOKEN_REF]: TELEGRAM_TOKEN } });
  const api = maxFetch({ updates: pairingUpdates });
  const stand = harness(t, {
    bindings: { transport: "telegram", chatId: 42, userId: 7, botUsername: "old_bot", createdAt: 1 },
    credentials,
    answers: MAX_ANSWERS,
    fetchImpl: api.fetch,
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /Telegram отключён, MAX подключён/);
  assert.match(result.text, /бот MAX «max_bot» привязан/);
  assert.match(result.text, /канал поднят: вопросы уходят в MAX/);

  const state = stand.store.read();
  assert.equal(state.bindings.transport, "max");
  assert.equal(state.bindings.chatId, CHAT_ID);
  assert.equal(state.bindings.userId, USER_ID);
  assert.equal(state.bindings.botUsername, "max_bot");
  assert.equal(state.bindings.marker, 42, "marker из pairing-опроса сохранён");
  assert.equal(state.bindings.previousTransport, "telegram");
  assert.equal(credentials.values.get(MAX_TOKEN_REF), TOKEN, "токен MAX сохранён в секретах");
  assert.equal(credentials.values.has(TELEGRAM_TOKEN_REF), false, "токен Telegram удалён (038)");
  assert.equal(stand.ensured.length, 1, "ensureTransport поднял MAX без перезапуска");

  const tokenCall = api.calls.find((call) => call.key === "GET /me");
  assert.equal(tokenCall.init.headers.authorization, TOKEN, "токен MAX ушёл заголовком Authorization");
});

test("connect MAX: невалидный токен — понятная ошибка и никакой привязки", async (t) => {
  const credentials = fakeCredentials({ values: { [TELEGRAM_TOKEN_REF]: TELEGRAM_TOKEN } });
  const api = maxFetch({ meStatus: 401 });
  const stand = harness(t, {
    bindings: { transport: "telegram", chatId: 42, userId: 7, botUsername: "old_bot", createdAt: 1 },
    credentials,
    answers: MAX_ANSWERS,
    fetchImpl: api.fetch,
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error", result.text);
  assert.match(result.text, /MAX не принял токен/);
  assert.equal(stand.store.read().bindings.transport, "telegram", "старая привязка не тронута");
  assert.equal(credentials.values.has(MAX_TOKEN_REF), false, "токен MAX не сохранён");
});

test("connect MAX: пустой токен — отказ до сети", async (t) => {
  const api = maxFetch({ updates: pairingUpdates });
  const stand = harness(t, {
    answers: { ...MAX_ANSWERS, "remote-connect-max-token": { custom: "" } },
    fetchImpl: api.fetch,
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error", result.text);
  assert.match(result.text, /токен MAX не получен/);
  assert.equal(api.calls.length, 0, "в сеть не ходили");
});

test("connect MAX: код не пришёл — привязки нет", async (t) => {
  const api = maxFetch({ onUpdates: () => [] });
  const stand = harness(t, {
    answers: MAX_ANSWERS,
    fetchImpl: api.fetch,
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error", result.text);
  assert.match(result.text, /не пришёл боту MAX за 10 минут/);
  assert.equal(stand.store.read().bindings, null, "привязки нет");
});

test("status MAX: токен, marker, polling и предупреждение про webhook", async (t) => {
  const credentials = fakeCredentials({ values: { [MAX_TOKEN_REF]: TOKEN } });
  const live = {
    id: "max",
    marker: 42,
    polling: true,
    lastError: null,
    healthCheck: async () => ({ ok: true, detail: "бот MAX max_bot на связи" }),
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-max-status-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ file: path.join(dir, "state.json") });
  const state = store.read();
  state.bindings = {
    transport: "max",
    chatId: CHAT_ID,
    userId: USER_ID,
    botUsername: "max_bot",
    marker: 42,
    previousTransport: "telegram",
    createdAt: 1,
  };
  store.write(state);
  const { ask } = scriptedAsk({});
  const remote = createRemoteCommands({
    ctx: {
      get(name) {
        if (name === "sessions") return { get: () => ({ header: { cwd: WORKSPACE } }) };
        if (name === "credentials") return credentials;
        if (name === "userQuestions") return { ask };
        if (name === "remoteTransport") return live;
        return null;
      },
    },
    store,
    log: () => {},
    fetch: maxFetch().fetch,
  });

  const result = await remote.handler(invoke("status"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /бот MAX: «max_bot», чат 90210, человек 777/);
  assert.match(result.text, /marker 42/);
  assert.match(result.text, /webhook недоступен без публичного HTTPS:443/);
  assert.match(result.text, new RegExp(`секрет: ${MAX_TOKEN_REF}`), "показан секрет активного канала");
  assert.match(result.text, /прежний канал: Telegram \(отключён\)/);
});

test("doctor MAX: проверяет токен MAX, marker и живость канала", async () => {
  const credentials = {
    availableFor: () => true,
    resolve: async () => TOKEN,
    describe: async () => ({ present: true, source: "file", writable: true }),
  };
  const store = { read: () => ({ bindings: { transport: "max", chatId: CHAT_ID, userId: USER_ID } }) };

  const healthy = await runDoctorChecks({
    store,
    credentials,
    transport: { id: "max", marker: 42, polling: true, healthCheck: async () => ({ ok: true, detail: "бот MAX max_bot на связи" }) },
  });
  const tokenCheck = healthy.find((check) => check.title === "токен");
  assert.match(tokenCheck.detail, new RegExp(MAX_TOKEN_REF));
  assert.equal(tokenCheck.level, "ok");
  const channel = healthy.find((check) => check.title === "канал");
  assert.equal(channel.level, "ok");
  assert.match(channel.detail, /MAX: бот MAX max_bot на связи; marker 42; polling да/);

  const unhealthy = await runDoctorChecks({
    store,
    credentials,
    transport: { id: "max", marker: null, polling: false, healthCheck: async () => ({ ok: false, detail: "401 unauthorized" }) },
  });
  const failed = unhealthy.find((check) => check.title === "канал");
  assert.equal(failed.level, "fail");
  assert.match(failed.hint, /long polling|HTTPS:443/);
});

// ---------------------------------------------------------------------------
// Доставка вопроса и ответ через реальный MAX-транспорт на фейковом fetch
// ---------------------------------------------------------------------------

/** MAX API для транспорта: /updates висит, пока тест не подтолкнёт апдейт. */
function interactiveMaxFetch() {
  const calls = [];
  const queued = [];
  const waiters = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = init.method ?? "GET";
    calls.push({ key: `${method} ${parsed.pathname}`, url: parsed, init });
    if (parsed.pathname === "/me") return jsonResponse({ name: "max_bot" });
    if (parsed.pathname === "/updates") {
      const batch = queued.length > 0
        ? queued.splice(0)
        : await new Promise((resolve) => {
          const finish = (value) => resolve(value);
          waiters.push(finish);
          init.signal?.addEventListener?.("abort", () => finish([]), { once: true });
        });
      return jsonResponse({ updates: batch, marker: 1 });
    }
    return jsonResponse({ ok: true, message: { body: { mid: "mid.1" } } });
  };
  return {
    calls,
    fetch: fetchImpl,
    push(update) {
      if (waiters.length > 0) waiters.shift()([update]);
      else queued.push(update);
    },
  };
}

test("MAX-транспорт доставляет вопрос и возвращает ответ в сессию", async () => {
  const api = interactiveMaxFetch();
  const transport = createMaxTransport({
    token: TOKEN,
    chatId: CHAT_ID,
    allowedUserIds: [USER_ID],
    apiBase: MAX_API_BASE,
    fetch: api.fetch,
    now: () => 0,
    sleep: async () => {},
    log: () => {},
  });
  const answerer = createAnswerer({
    transport,
    registry: createRegistry({ readState: () => ({ global: true }) }),
    now: () => 0,
    log: () => {},
  });
  await transport.start();
  answerer.attach({ on: () => () => {}, get: () => null, provide: () => {} });

  const pending = answerer.handler(
    { agent: { id: "s1" }, questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] }] },
    async () => "gui",
  );
  pending.catch(() => {});
  for (let tick = 0; tick < 20 && transport.messages.size === 0; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const [shortId] = [...transport.messages.keys()];
  assert.ok(shortId, "вопрос отправлен в MAX");

  api.push({
    type: "message_callback",
    callback: {
      callback_id: "cb1",
      payload: callbackData(shortId, "o1"),
      user: { user_id: USER_ID },
      chat: { chat_id: CHAT_ID },
    },
  });
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    if (transport.messages.size === 0) break;
  }

  const result = await pending;
  assert.equal(result.answers.length, 1, "ответ из MAX вернулся в сессию");
  assert.deepEqual(result.answers[0].selected, ["Да"]);
  await transport.stop();
});
