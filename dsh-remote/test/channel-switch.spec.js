/**
 * Один активный канал (038): подключение нового транспорта отключает прежний.
 *
 * Проверяем обещания карточки: прежний канал останавливается ДО записи новой
 * привязки, его токен чистится, в состоянии остаётся одна привязка + имя прежнего,
 * connect/status говорят, что отключено, disconnect чистит токен активного канала,
 * а ответчик в обычном режиме публикует ровно в один канал (веер — только явным
 * `transports: [...]`).
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
  switchNoteFor,
  tokenRefFor,
  transportLabel,
} from "../lib/commands.js";
import { RELAY_TOKEN_REF } from "../lib/transport/relay.js";
import { answererFeature } from "../lib/features/answerer.js";
import { createFakeTransport } from "../lib/transport/fake.js";
import { createStore } from "../lib/store.js";
import { createRegistry } from "../lib/domain/registry.js";

const TOKEN = "111:TELEGRAM-TEST-TOKEN";
const RELAY_TOKEN = "relay-agent-token";
const WORKSPACE = "/p";
const SESSION_ID = "s1";

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Фейковые секреты: значения по ссылкам, запись/удаление, «только чтение». */
function fakeCredentials({ values = {}, readonly = false } = {}) {
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
      writable: readonly ? false : true,
    }),
    set: async (ref, secret) => {
      calls.push(["set", ref]);
      map.set(ref, secret);
    },
    unset: async (ref) => {
      calls.push(["unset", ref]);
      map.delete(ref);
      return true;
    },
  };
}

/** Последовательные ответы человека по id локального вопроса. */
function scriptedAsk(answers) {
  return {
    ask: async (request) => {
      const item = request.questions[0];
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

/** Транспорт-заглушка с записью stop(): фасад и реестр каналов. */
function fakeChannel(id, order) {
  return {
    id,
    caps: {},
    polling: true,
    async start() {
      return true;
    },
    async stop() {
      order.push(`stop:${id}`);
      this.polling = false;
    },
    async sendQuestion(question) {
      order.push(`send:${id}`);
      return { messageId: `${id}-1` };
    },
    async closeQuestion() {},
    onAnswer() {
      return () => {};
    },
  };
}

function harness(t, { bindings = null, credentials = fakeCredentials(), answers = {}, fetchImpl, channels = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-switch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const store = createStore({ file });
  if (bindings !== null) {
    // setBinding принимает только telegram-поля, а нам нужны relay/previousTransport.
    const initial = store.read();
    initial.bindings = bindings;
    store.write(initial);
  }

  const order = [];
  const registry = new Map(channels.map((channel) => [channel.id, channel]));
  const facade = {
    __isTransportFacade: true,
    current: channels[0] ?? null,
    async stop() {
      order.push("stop:facade");
      this.current = null;
    },
    clear() {
      this.current = null;
    },
  };
  const trackingStore = {
    ...store,
    read: () => store.read(),
    update: (mutator) => {
      order.push("save");
      return store.update(mutator);
    },
  };
  const { ask } = scriptedAsk(answers);
  // Часы двигаются «сном»: иначе pollForCode ждал бы pairing-код вечно.
  let clock = 1_000_000;
  const remote = createRemoteCommands({
    ctx: {
      get(name) {
        if (name === "sessions") return { get: () => ({ header: { cwd: WORKSPACE } }) };
        if (name === "credentials") return credentials;
        if (name === "userQuestions") return { ask };
        if (name === "remoteTransport") return facade;
        if (name === "remoteTransports") return registry;
        return null;
      },
      userQuestions: { ask },
    },
    store: trackingStore,
    log: () => {},
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    random: () => 0.5,
    fetch: fetchImpl ?? (async () => jsonResponse({ ok: true, result: {} })),
    ensureTransport: async () => {
      order.push("ensure");
      return { async start() { return true; } };
    },
  });
  return { store, remote, order, facade, registry, credentials };
}

/** Ответы для connect relay. */
const RELAY_CONNECT_ANSWERS = {
  "remote-connect-transport": { selected: ["Relay (свой сервер)"] },
  "remote-connect-relay-url": { custom: "https://relay.example" },
  "remote-connect-relay-token": { custom: RELAY_TOKEN },
  "remote-connect-scope": { selected: ["Пока не включать"] },
};

/** Ответы для connect Telegram (второй шаг — токен и pairing). */
const TELEGRAM_CONNECT_ANSWERS = {
  "remote-connect-transport": { selected: ["Telegram"] },
  "remote-connect-token": { custom: "222:NEW-TELEGRAM-TOKEN" },
  "remote-connect-send-code": { selected: ["Отправил"] },
  "remote-connect-scope": { selected: ["Пока не включать"] },
};

function telegramFetch() {
  return async (url) => {
    const method = url.split("/").pop();
    if (method === "getMe") return jsonResponse({ ok: true, result: { username: "new_bot" } });
    if (method === "getUpdates") {
      return jsonResponse({ ok: true, result: [{ update_id: 5, message: { text: "500000", chat: { id: 77 }, from: { id: 88 } } }] });
    }
    return jsonResponse({ ok: true, result: true });
  };
}

/** `/healthz` + авторизованный пробник релея. */
function relayFetch() {
  return async (url) => {
    if (url.endsWith("/healthz")) return jsonResponse({ ok: true, version: "0.1.0" });
    if (url.includes("/v1/answers")) return jsonResponse({}, 404);
    return jsonResponse({}, 404);
  };
}

const invoke = (rawInput) => ({
  commandId: "c1",
  agent: { id: "agent-1", session: { id: SESSION_ID } },
  rawInput,
  signal: new AbortController().signal,
});

test("connect: Telegram → релей отключает прежний канал до записи привязки и чистит токен", async (t) => {
  const credentials = fakeCredentials({ values: { [TELEGRAM_TOKEN_REF]: TOKEN } });
  const telegram = fakeChannel("telegram", []);
  const stand = harness(t, {
    bindings: { transport: "telegram", chatId: 42, userId: 7, botUsername: "old_bot", createdAt: 1 },
    credentials,
    answers: RELAY_CONNECT_ANSWERS,
    fetchImpl: relayFetch(),
    channels: [telegram],
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /Telegram отключён, релей подключён/);
  // Остановка прежнего канала — до сохранения новой привязки.
  assert.ok(stand.order.includes("stop:telegram") || stand.order.includes("stop:facade"), `stop был: ${stand.order}`);
  assert.ok(stand.order.indexOf("stop:facade") < stand.order.indexOf("save"), `порядок: ${stand.order}`);

  const state = stand.store.read();
  assert.equal(state.bindings.transport, "relay");
  assert.equal(state.bindings.url, "https://relay.example");
  assert.equal(state.bindings.previousTransport, "telegram", "имя прежнего канала сохранено");
  assert.equal(credentials.values.has(TELEGRAM_TOKEN_REF), false, "токен Telegram удалён");
  assert.deepEqual(stand.registry.size, 0, "канал прежнего транспорта снят с реестра");
});

test("connect: релей → Telegram переключает обратно и чистит токен релея", async (t) => {
  const credentials = fakeCredentials({ values: { [RELAY_TOKEN_REF]: RELAY_TOKEN } });
  const relay = fakeChannel("relay", []);
  const stand = harness(t, {
    bindings: { transport: "relay", url: "https://relay.example", botUsername: "relay", createdAt: 1 },
    credentials,
    answers: TELEGRAM_CONNECT_ANSWERS,
    fetchImpl: telegramFetch(),
    channels: [relay],
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /релей отключён, Telegram подключён/i);
  const state = stand.store.read();
  assert.equal(state.bindings.transport, "telegram");
  assert.equal(state.bindings.previousTransport, "relay");
  assert.equal(credentials.values.has(RELAY_TOKEN_REF), false, "токен релея удалён");
  assert.equal(stand.order.indexOf("stop:facade") < stand.order.indexOf("save"), true, `порядок: ${stand.order}`);
});

test("connect: секрет прежнего канала только для чтения — честная пометка, а не тишина", async (t) => {
  const credentials = fakeCredentials({ values: { [TELEGRAM_TOKEN_REF]: TOKEN }, readonly: true });
  const stand = harness(t, {
    bindings: { transport: "telegram", chatId: 42, userId: 7, botUsername: "old_bot", createdAt: 1 },
    credentials,
    answers: RELAY_CONNECT_ANSWERS,
    fetchImpl: relayFetch(),
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /остался в окружении/i);
  assert.match(result.text, new RegExp(TELEGRAM_TOKEN_REF));
  assert.equal(stand.store.read().bindings.transport, "relay");
});

test("disconnect: чистит токен активного канала (релей), а не всегда Telegram", async (t) => {
  const credentials = fakeCredentials({
    values: { [TELEGRAM_TOKEN_REF]: TOKEN, [RELAY_TOKEN_REF]: RELAY_TOKEN },
  });
  const relay = fakeChannel("relay", []);
  const stand = harness(t, {
    bindings: { transport: "relay", url: "https://relay.example", botUsername: "relay", createdAt: 1 },
    credentials,
    answers: { "remote-disconnect-confirm": { selected: ["Да, отвязать"] } },
    channels: [relay],
  });

  const result = await stand.remote.handler(invoke("disconnect"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /привязка \(релей\) удалена/i);
  assert.equal(stand.store.read().bindings, null);
  assert.equal(credentials.values.has(RELAY_TOKEN_REF), false, "токен релея удалён");
  assert.equal(credentials.values.has(TELEGRAM_TOKEN_REF), true, "чужой токен не трогаем");
  assert.equal(stand.order.includes("stop:relay") || stand.order.includes("stop:facade"), true);
});

test("status: показывает активный канал и прежний (отключён)", async (t) => {
  const stand = harness(t, {
    bindings: {
      transport: "telegram",
      chatId: 42,
      userId: 7,
      botUsername: "new_bot",
      createdAt: 1,
      previousTransport: "max",
    },
    credentials: fakeCredentials({ values: { [TELEGRAM_TOKEN_REF]: TOKEN } }),
  });

  const result = await stand.remote.handler(invoke("status"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /бот: @new_bot \(telegram\)/);
  assert.match(result.text, /прежний канал: MAX \(отключён\)/);
});

test("имена и ссылки транспортов: MAX — свой секрет, релей — свой", () => {
  assert.equal(tokenRefFor("telegram"), TELEGRAM_TOKEN_REF);
  assert.equal(tokenRefFor("max"), MAX_TOKEN_REF);
  assert.equal(tokenRefFor("relay"), RELAY_TOKEN_REF);
  assert.equal(transportLabel("telegram"), "Telegram");
  assert.equal(transportLabel("max"), "MAX");
  assert.equal(transportLabel("relay"), "релей");
  assert.equal(switchNoteFor(null, "max"), null);
  assert.equal(switchNoteFor("telegram", "telegram"), null);
  assert.equal(switchNoteFor("telegram", "max"), "Telegram отключён, MAX подключён");
});

// ---------------------------------------------------------------------------
// Ответчик: один канал по умолчанию, веер — только явным конфигом
// ---------------------------------------------------------------------------

function answererStand({ config = {}, binding = null, facadeCurrent = null } = {}) {
  const telegram = createFakeTransport({ now: () => 0 });
  const relay = createFakeTransport({ now: () => 0 });
  const facade = {
    __isTransportFacade: true,
    current: facadeCurrent === "relay" ? relay : facadeCurrent === "telegram" ? telegram : null,
    async stop() {
      this.current = null;
    },
    sendQuestion(question, options) {
      if (this.current === null) throw new Error("канал не поднят");
      return this.current.sendQuestion(question, options);
    },
    closeQuestion(question, summary) {
      return this.current?.closeQuestion?.(question, summary);
    },
    onAnswer(handler) {
      return this.current?.onAnswer?.(handler) ?? (() => {});
    },
    healthCheck: () => ({ ok: true }),
  };
  const services = new Map([
    ["remoteTransport", facade],
    ["remoteTransports", new Map([["telegram", telegram], ["relay", relay]])],
    ["remoteStore", {
      read: () => ({
        enabled: { global: true },
        hybrid: { enabled: false },
        bindings: binding === null ? null : { transport: binding },
      }),
    }],
  ]);
  const hooks = new Map();
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services.get(name) ?? null,
    onDispose: () => {},
  };
  const ctx = {
    get: (name) => services.get(name) ?? null,
    on: (event, handler) => {
      hooks.set(event, { handler });
      return () => {};
    },
    effect: (execute) => execute(),
  };
  answererFeature.apply(ctx, config, deps);
  return { telegram, relay, facade, handler: hooks.get("user-questions/request")?.handler };
}

const questionRequest = {
  agent: { id: "session-1" },
  questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }, { label: "Нет" }] }],
};

/** Задать вопрос и дождаться отправки. */
async function publish(handler) {
  const pending = handler(questionRequest, async () => "gui");
  pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  // Не `return pending`: async-функция «усыновит» промис, и await publish()
  // будет ждать ответа человека, а не отправки вопроса.
  return { pending };
}

test("ответчик: привязка telegram — публикует в telegram, даже если фасад указывает на relay", async () => {
  // Репро блокера: relay смонтирован позже и перетёр фасад, но активна привязка telegram.
  const stand = answererStand({ binding: "telegram", facadeCurrent: "relay" });
  const { pending } = await publish(stand.handler);

  assert.equal(stand.telegram.messages.length, 1, "вопрос ушёл в активный канал telegram");
  assert.equal(stand.relay.messages.length, 0, "relay вопрос не получает");
  stand.telegram.answer(stand.telegram.messages[0].shortId, "o1");
  assert.equal((await pending).answers.length, 1, "ответ из активного канала доставлен");
});

test("ответчик: привязка relay — публикует в relay, даже если фасад указывает на telegram", async () => {
  const stand = answererStand({ binding: "relay", facadeCurrent: "telegram" });
  const { pending } = await publish(stand.handler);

  assert.equal(stand.relay.messages.length, 1, "вопрос ушёл в активный relay");
  assert.equal(stand.telegram.messages.length, 0);
  stand.relay.answer(stand.relay.messages[0].shortId, "o1");
  assert.equal((await pending).answers.length, 1);
});

test("ответчик: без привязки работает канал из фасада (config-путь)", async () => {
  const stand = answererStand({ binding: null, facadeCurrent: "relay" });
  await publish(stand.handler);

  assert.equal(stand.relay.messages.length, 1, "config-канал из фасада получил вопрос");
  assert.equal(stand.telegram.messages.length, 0);
});

test("ответчик: веер включается только явным config.transports с двумя каналами", async () => {
  const stand = answererStand({ binding: "telegram", facadeCurrent: "relay", config: { transports: ["telegram", "relay"] } });
  const { pending } = await publish(stand.handler);

  assert.equal(stand.telegram.messages.length, 1, "первый канал явного веера получил вопрос");
  assert.equal(stand.relay.messages.length, 1, "второй канал явного веера тоже");
  stand.telegram.answer(stand.telegram.messages[0].shortId, "o1");
  await pending.catch(() => {});
});
