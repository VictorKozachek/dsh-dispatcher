/**
 * Тесты команд `/remote` на фейковом контексте.
 *
 * Проверяем обещания карточки: привязка без подтверждённого pairing-кода не
 * завершается, токен нигде не печатается и не пишется, режим переключается для
 * сессии/воркспейса/глобально, ошибки приходят текстом. Сети нет: `fetch`,
 * `userQuestions.ask` и часы подменены, состояние — во временном каталоге.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore } from "../lib/store.js";
import { createAudit } from "../lib/audit.js";
import { commandsFeature } from "../lib/features/commands.js";
import { telegramFeature } from "../lib/features/telegram.js";
import { answererFeature } from "../lib/features/answerer.js";
import { RELAY_TOKEN_REF } from "../lib/transport/relay.js";
import {
  PAIRING_TTL_MS,
  TELEGRAM_TOKEN_REF,
  createRemoteCommands,
  pairingCode,
  parseRemoteArgs,
} from "../lib/commands.js";

const TOKEN = "123456:TEST-TOKEN";
const CODE_RANDOM = 0.123456; // pairingCode(() => 0.123456) === "123456"
const CODE = pairingCode(() => CODE_RANDOM);
const START_MS = 1_000_000;
const WORKSPACE = "/p";
const SESSION_ID = "s1";

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Фейковый Bot API: `getMe` и `getUpdates` по сценарию. */
function telegramFetch({ updates } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = url.split("/").pop();
    const payload = init.body === undefined ? {} : JSON.parse(init.body);
    calls.push({ method, payload });
    if (method === "getMe") return jsonResponse({ ok: true, result: { username: "test_bot", id: 1 } });
    if (method === "getUpdates") {
      const count = calls.filter((call) => call.method === "getUpdates").length;
      const result = updates === undefined
        ? [{ update_id: 5, message: { text: CODE, chat: { id: 42 }, from: { id: 7 } } }]
        : updates(count);
      if (result instanceof Error) return jsonResponse({ ok: false, description: result.message }, result.status ?? 500);
      return jsonResponse({ ok: true, result });
    }
    return jsonResponse({ ok: true, result: true });
  };
  return { fetch: fetchImpl, calls };
}

/** Фейковый `ctx.credentials`. */
function fakeCredentials({ value = null, source = "file", writable = true } = {}) {
  // Форма CredentialProvider: всё асинхронное, describe -> {configured, source, writable}.
  const values = new Map();
  if (value !== null) values.set(TELEGRAM_TOKEN_REF, value);
  const calls = [];
  return {
    values,
    calls,
    resolve: async (ref) => (values.has(ref)
      ? { value: values.get(ref), source }
      : undefined),
    describe: async (ref) => (values.has(ref)
      ? { configured: true, source, writable }
      : { configured: false, writable: false }),
    set: async (ref, secret) => {
      calls.push(["set", ref, secret]);
      values.set(ref, secret);
    },
    unset: async (ref) => {
      calls.push(["unset", ref]);
      values.delete(ref);
    },
  };
}

/** Сценарий ответов человека: по id локального вопроса. */
function scriptedAsk(answers) {
  const asked = [];
  const ask = async (request) => {
    const item = request.questions[0];
    asked.push(item);
    const answer = answers[item.id];
    if (answer === undefined) throw new Error(`нет сценария для ${item.id}`);
    if (answer instanceof Error) throw answer;
    return {
      answers: [{
        id: item.id,
        selected: answer.selected ?? [],
        ...(answer.custom === undefined ? {} : { custom: answer.custom }),
      }],
    };
  };
  return { ask, asked };
}

/** Контекст плагина в объёме, который нужен командам. */
function fakeContext({ ask, sessions, credentials, transport, withCommands = true }) {
  const registered = [];
  const ctx = {
    ...(withCommands ? { commands: { register: (definition) => { registered.push(definition); return () => {}; } } } : {}),
    userQuestions: { ask },
    get(name) {
      if (name === "sessions") return sessions;
      if (name === "credentials") return credentials;
      if (name === "remoteTransport") return transport;
      return null;
    },
  };
  return { ctx, registered };
}

/**
 * Полный стенд: временное состояние, команды, фейковые часы и сон.
 *
 * `sleep` двигает часы — поэтому TTL pairing истекает детерминированно и без
 * реального ожидания, а успешный ответ находится на первом же опросе.
 */
function harness(t, {
  answers = {},
  credentials = fakeCredentials(),
  sessions = { get: () => ({ header: { cwd: WORKSPACE } }) },
  transport = null,
  withCommands = true,
  fetchImpl,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-cmd-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");

  let clock = START_MS;
  const store = createStore({ file, now: () => clock });
  const { ask, asked } = scriptedAsk(answers);
  const { ctx, registered } = fakeContext({ ask, sessions, credentials, transport, withCommands });
  const sleeps = [];

  const remote = createRemoteCommands({
    ctx,
    store,
    log: () => {},
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => CODE_RANDOM,
    fetch: fetchImpl ?? (async () => jsonResponse({ ok: true, result: {} })),
  });

  return {
    dir,
    file,
    store,
    ctx,
    remote,
    registered,
    asked,
    sleeps,
    credentials,
    get clock() {
      return clock;
    },
  };
}

/** Вызов команды: `rawInput` — то, что идёт после `/remote`. */
function invoke(rawInput, { signal } = {}) {
  return {
    commandId: "c1",
    agent: { id: "agent-1", session: { id: SESSION_ID } },
    rawInput,
    signal: signal ?? new AbortController().signal,
  };
}

/** Ответы человека для удачного connect. */
const CONNECT_ANSWERS = {
  "remote-connect-transport": { selected: ["Telegram"] },
  "remote-connect-token": { custom: TOKEN },
  "remote-connect-send-code": { selected: ["Отправил"] },
  "remote-connect-scope": { selected: ["Только этот проект"] },
};

test("парсер аргументов: подкоманда и флаги", () => {
  assert.equal(parseRemoteArgs("").subcommand, "status");
  const on = parseRemoteArgs("  ON  --all ");
  assert.equal(on.subcommand, "on");
  assert.deepEqual([...on.flags], ["all"]);
  assert.deepEqual(parseRemoteArgs("off --session").rest, []);
});

test("регистрация: ctx.commands получает /remote, без сервиса — тихий отказ", (t) => {
  const withService = harness(t);
  const dispose = withService.remote.register();
  assert.equal(withService.registered.length, 1);
  assert.equal(withService.registered[0].name, "remote");
  assert.equal(typeof withService.registered[0].handler, "function");
  assert.equal(typeof dispose, "function");

  const withoutService = harness(t, { withCommands: false });
  assert.equal(typeof withoutService.remote.register(), "function");
});

test("/remote без аргументов — status; неизвестная подкоманда — справка", async (t) => {
  const { remote } = harness(t);

  const status = await remote.handler(invoke(""));
  assert.equal(status.kind, "success");
  assert.match(status.text, /бот не привязан/);

  const unknown = await remote.handler(invoke("wat"));
  assert.equal(unknown.kind, "success");
  assert.match(unknown.text, /неизвестная подкоманда/);
  assert.match(unknown.text, /\/remote connect/);
});

test("connect: шаги, привязка, режим, токен не утекает, lock снят", async (t) => {
  const telegram = telegramFetch();
  const stand = harness(t, { answers: CONNECT_ANSWERS, fetchImpl: telegram.fetch });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  const state = stand.store.read();
  assert.equal(state.bindings.transport, "telegram");
  assert.equal(state.bindings.chatId, 42);
  assert.equal(state.bindings.userId, 7);
  assert.equal(state.bindings.botUsername, "test_bot");
  assert.equal(state.enabled.workspaces[WORKSPACE], true, "режим включён для текущего проекта");

  assert.deepEqual(stand.credentials.calls[0].slice(0, 2), ["set", TELEGRAM_TOKEN_REF]);
  assert.equal(fs.readFileSync(stand.file, "utf8").includes(TOKEN), false, "токен не попал на диск");
  assert.equal(result.text.includes(TOKEN), false, "токен не попал в ответ");
  assert.equal(fs.existsSync(stand.store.paths.lock), false, "lock снят");

  const poll = telegram.calls.find((call) => call.method === "getUpdates");
  assert.deepEqual(poll.payload.allowed_updates, ["message"]);
  assert.equal(stand.asked.length, 4, "четыре шага: транспорт, токен, код, режим");
});

test("connect: после привязки просит транспорт начать поллинг", async (t) => {
  const telegram = telegramFetch();
  const started = [];
  const transport = { id: "telegram", start: async () => started.push("start"), stop: async () => {} };
  const stand = harness(t, { answers: CONNECT_ANSWERS, fetchImpl: telegram.fetch, transport });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.deepEqual(started, ["start"], "транспорт запущен");
});

test("connect: код не пришёл за 10 минут — привязки нет", async (t) => {
  const telegram = telegramFetch({ updates: () => [] });
  const stand = harness(t, { answers: CONNECT_ANSWERS, fetchImpl: telegram.fetch });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /не пришёл боту за 10 минут/);
  assert.equal(stand.store.read().bindings, null);
  assert.equal(stand.credentials.calls.length, 0, "токен не сохранён");
  assert.ok(stand.clock >= START_MS + PAIRING_TTL_MS - 1000, "ждали весь TTL");
  assert.ok(telegram.calls.filter((call) => call.method === "getUpdates").length >= 5);
});

test("connect: неверный токен — текст, а не stacktrace", async (t) => {
  const stand = harness(t, {
    answers: { ...CONNECT_ANSWERS, "remote-connect-token": { custom: "не-токен" } },
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /не похоже на токен/);
  assert.equal(result.text.includes("    at "), false, "без stacktrace");
  assert.equal(stand.store.read().bindings, null);
});

test("connect: Telegram отверг токен (401) — привязки нет", async (t) => {
  const stand = harness(t, {
    answers: CONNECT_ANSWERS,
    fetchImpl: async () => jsonResponse({ ok: false, description: "Unauthorized" }, 401),
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /401 Unauthorized/);
  assert.equal(stand.store.read().bindings, null);
});

test("connect: чужой код игнорируется, верный подтверждает привязку", async (t) => {
  const telegram = telegramFetch({
    updates: (count) => (count === 1
      ? [{ update_id: 1, message: { text: "000000", chat: { id: 9 }, from: { id: 9 } } }]
      : [{ update_id: 2, message: { text: CODE, chat: { id: 42 }, from: { id: 7 } } }]),
  });
  const stand = harness(t, { answers: CONNECT_ANSWERS, fetchImpl: telegram.fetch });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.equal(stand.store.read().bindings.userId, 7, "привязка по верному коду");
  assert.equal(telegram.calls.filter((call) => call.method === "getUpdates").length, 2);
});

test("connect: 409 во время привязки — понятный отказ", async (t) => {
  const stand = harness(t, {
    answers: CONNECT_ANSWERS,
    fetchImpl: async (url) => {
      const method = url.split("/").pop();
      if (method === "getMe") return jsonResponse({ ok: true, result: { username: "test_bot" } });
      return jsonResponse({ ok: false, description: "Conflict: terminated by other getUpdates" }, 409);
    },
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /другой поллер/);
  assert.equal(stand.store.read().bindings, null);
});

test("connect: без ctx.credentials — отказ", async (t) => {
  const stand = harness(t, { answers: CONNECT_ANSWERS, credentials: null });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /ctx\.credentials/);
});

test("connect: занятый lock — отказ с pid", async (t) => {
  const stand = harness(t, { answers: CONNECT_ANSWERS });
  assert.equal(stand.store.acquireLock().ok, true);
  t.after(() => stand.store.releaseLock());

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /другой процесс/);
  assert.match(result.text, new RegExp(String(process.pid)));
});

test("connect: человек закрыл вопрос — ошибка текстом, без привязки", async (t) => {
  const stand = harness(t, {
    answers: { "remote-connect-transport": new Error("вопрос закрыт") },
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /подключение не удалось: вопрос закрыт/);
  assert.equal(stand.store.read().bindings, null);
});

test("on/off: воркспейс по умолчанию, --all и --session", async (t) => {
  const stand = harness(t);
  stand.store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const channel = { id: "telegram", start: async () => {}, stop: async () => {}, sendQuestion: async () => ({}) };
  const remote = createRemoteCommands({
    ctx: stand.ctx,
    store: stand.store,
    log: () => {},
    now: () => stand.clock,
    currentChannel: () => channel,
  });

  const onWorkspace = await remote.handler(invoke("on"));
  assert.equal(onWorkspace.kind, "success");
  assert.match(onWorkspace.text, /\/p/);
  assert.equal(stand.store.read().enabled.workspaces[WORKSPACE], true);

  await remote.handler(invoke("on --all"));
  assert.equal(stand.store.read().enabled.global, true);

  await remote.handler(invoke("on --session"));
  assert.equal(stand.store.read().enabled.sessions[SESSION_ID], true);

  const off = await remote.handler(invoke("off --all"));
  assert.equal(off.kind, "success");
  assert.equal(stand.store.read().enabled.global, false);
});

test("on без cwd: подсказка про --all и --session", async (t) => {
  const stand = harness(t, { sessions: { get: () => ({ header: {} }) } });
  stand.store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const remote = createRemoteCommands({
    ctx: stand.ctx,
    store: stand.store,
    log: () => {},
    now: () => stand.clock,
    currentChannel: () => ({ id: "telegram", start: async () => {}, stop: async () => {} }),
  });

  const result = await remote.handler(invoke("on"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /--all/);
  assert.match(result.text, /--session/);
});

test("status: привязка, источник секрета (env — только чтение), без токена", async (t) => {
  const credentials = fakeCredentials({ value: TOKEN, source: "env", writable: false });
  const stand = harness(t, { credentials });
  stand.store.setBinding({
    transport: "telegram",
    chatId: 42,
    userId: 7,
    botUsername: "test_bot",
    createdAt: START_MS,
  });

  const result = await stand.remote.handler(invoke("status"));

  assert.equal(result.kind, "success");
  assert.match(result.text, /@test_bot/);
  assert.match(result.text, /чат 42/);
  assert.match(result.text, /источник env \(только чтение\)/);
  assert.equal(result.text.includes(TOKEN), false, "значение токена не показывается");
  assert.match(result.text, /эффективно: выключен/);
});

test("test: отправляет вопрос через живой транспорт", async (t) => {
  const sent = [];
  const transport = { id: "fake", sendQuestion: async (question) => sent.push(question), stop: async () => {} };
  const stand = harness(t, { transport });
  stand.store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });

  const result = await stand.remote.handler(invoke("test"));

  assert.equal(result.kind, "success", result.text);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Проверка канала");
});

test("test без транспорта и без привязки — текстом", async (t) => {
  const unbound = harness(t);
  const noBinding = await unbound.remote.handler(invoke("test"));
  assert.equal(noBinding.kind, "error");
  assert.match(noBinding.text, /бот не привязан/);

  const bound = harness(t);
  bound.store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const noTransport = await bound.remote.handler(invoke("test"));
  assert.equal(noTransport.kind, "error");
  assert.match(noTransport.text, /канал не поднят/);
});

test("disconnect: подтверждение снимает привязку, режим и секрет", async (t) => {
  const credentials = fakeCredentials({ value: TOKEN, source: "file", writable: true });
  const stand = harness(t, {
    credentials,
    answers: { "remote-disconnect-confirm": { selected: ["Да, отвязать"] } },
  });
  stand.store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  stand.store.setEnabled({ kind: "global" }, true);
  stand.store.setEnabled({ kind: "workspace", id: WORKSPACE }, true);

  const result = await stand.remote.handler(invoke("disconnect"));

  assert.equal(result.kind, "success", result.text);
  assert.equal(stand.store.read().bindings, null);
  assert.equal(stand.store.read().enabled.global, false);
  assert.deepEqual(stand.store.read().enabled.workspaces, {});
  assert.deepEqual(credentials.calls.at(-1), ["unset", TELEGRAM_TOKEN_REF]);
  assert.match(result.text, /секрет .* удалён/);
});

test("disconnect: отказ человека ничего не меняет", async (t) => {
  const stand = harness(t, { answers: { "remote-disconnect-confirm": { selected: ["Нет"] } } });
  stand.store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });

  const result = await stand.remote.handler(invoke("disconnect"));

  assert.equal(result.kind, "success");
  assert.match(result.text, /отменено/);
  assert.notEqual(stand.store.read().bindings, null);
});

test("who: сессия, воркспейс и эффективный режим", async (t) => {
  const stand = harness(t);
  stand.store.setEnabled({ kind: "workspace", id: WORKSPACE }, true);

  const result = await stand.remote.handler(invoke("who"));

  assert.equal(result.kind, "success");
  assert.match(result.text, /сессия: s1/);
  assert.match(result.text, /воркспейс: \/p/);
  assert.match(result.text, /эффективно: включён \(воркспейс\)/);
});

test("ошибка хранилища превращается в текст, а не в исключение", async (t) => {
  const stand = harness(t);
  const broken = {
    ...stand.store,
    read() {
      throw new Error("диск кончился");
    },
  };
  const remote = createRemoteCommands({ ctx: stand.ctx, store: broken, log: () => {} });

  const status = await remote.handler(invoke("status"));
  assert.equal(status.kind, "error");
  assert.match(status.text, /диск кончился/);
  assert.equal(status.text.includes("    at "), false);
});

// --- фича commands: канал из сохранённой привязки ---------------------------

/** `deps` каркаса (задача 001) в объёме, который нужен фиче. */
function fakeDeps() {
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
      get: (name) => (name === "credentials" ? { resolve: async () => ({ value: TOKEN, source: "file" }) } : null),
      onDispose: (disposer) => disposers.push(disposer),
    },
  };
}

/** Фейковый cordis-контекст: provide делает сервис видимым для get. */
function pluginContext() {
  const provided = [];
  const services = new Map();
  const effects = [];
  const ctx = {
    provide: (name, service) => {
      services.set(name, service);
      provided.push({ name, service });
    },
    get: (name) => {
      if (name === "credentials") return { resolve: async () => ({ value: TOKEN, source: "file" }) };
      return services.get(name) ?? null;
    },
    commands: { register: () => () => {} },
    userQuestions: { ask: async () => ({ answers: [] }) },
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      effects.push(disposable);
      return () => disposable?.();
    },
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  };
  return { ctx, provided, effects };
}

/** Транспорт висит на getUpdates, пока не отменят: удобно для проверки start/stop. */
async function hangingTelegramFetch(url, init = {}) {
  if (url.endsWith("/getUpdates")) {
    return new Promise((_, reject) => {
      init.signal?.addEventListener?.("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  }
  return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 1, username: "test_bot" } }; } };
}

test("фича commands: сохранённая привязка поднимает транспорт и сервис remoteTransport", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-feature-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  createStore({ file }).setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });

  const previousState = process.env.DSH_REMOTE_STATE;
  process.env.DSH_REMOTE_STATE = file;
  t.after(() => {
    if (previousState === undefined) delete process.env.DSH_REMOTE_STATE;
    else process.env.DSH_REMOTE_STATE = previousState;
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangingTelegramFetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { ctx, provided } = pluginContext();
  const { deps, logs } = fakeDeps();

  await commandsFeature.apply(ctx, {}, deps);

  const names = provided.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["remoteStore", "remoteTransport", "remoteTransports"], "состояние, фасад и реестр каналов");
  const transportEntry = provided.find((entry) => entry.name === "remoteTransport");
  assert.equal(transportEntry.service.current.polling, true, "поллинг запущен");
  assert.match(logs.join("\n"), /канал поднят из сохранённой привязки/);

  await transportEntry.service.stop();
});

test("фича commands: без привязки транспорт не поднимается", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-feature-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  createStore({ file }).write(createStore({ file }).read());

  const previousState = process.env.DSH_REMOTE_STATE;
  process.env.DSH_REMOTE_STATE = file;
  t.after(() => {
    if (previousState === undefined) delete process.env.DSH_REMOTE_STATE;
    else process.env.DSH_REMOTE_STATE = previousState;
  });

  const { ctx, provided } = pluginContext();
  const { deps } = fakeDeps();

  await commandsFeature.apply(ctx, {}, deps);

  // Сервисы регистрируются всегда (состояние и стабильный фасад), но канала нет:
  // фасад пуст, вопрос уходит в GUI.
  const transportEntry = provided.find((entry) => entry.name === "remoteTransport");
  assert.ok(transportEntry, "фасад транспорта зарегистрирован");
  assert.equal(transportEntry.service.current, null, "транспорт не поднят");
});

test("connect: ensureTransport поднимает канал в той же сессии", async (t) => {
  const telegram = telegramFetch();
  const stand = harness(t, { answers: CONNECT_ANSWERS, fetchImpl: telegram.fetch });
  let ensured = 0;
  const started = [];
  const remote = createRemoteCommands({
    ctx: stand.ctx,
    store: stand.store,
    log: () => {},
    now: () => stand.clock,
    sleep: async () => {},
    random: () => CODE_RANDOM,
    fetch: telegram.fetch,
    ensureTransport: async () => {
      ensured += 1;
      return { id: "telegram", start: async () => started.push("start"), stop: async () => {} };
    },
  });

  const result = await remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.equal(ensured, 1, "фичу попросили поднять канал");
  assert.deepEqual(started, ["start"], "транспорт запущен");
  assert.match(result.text, /канал поднят/);
});

// --- правки по ревью 005 ---------------------------------------------------

/** Дать отработать микрозадачам. */
const tick = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("ответчик видит режим из remoteStore: включённый state забирает вопрос", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore({ file: path.join(dir, "state.json") });
  store.setEnabled({ kind: "workspace", id: "/p" }, true);

  const sent = [];
  const transport = {
    id: "telegram",
    caps: { inlineText: true, inlineButtons: true, editAfterAnswer: true, maxText: 4096, maxOptions: 8 },
    sendQuestion: async (question) => sent.push(question),
    closeQuestion: async () => {},
    onAnswer: () => () => {},
    stop: async () => {},
  };
  const hooks = new Map();
  const ctx = {
    get: (name) => (name === "remoteTransport" ? transport : name === "remoteStore" ? store : name === "sessions" ? { get: () => ({ header: { cwd: "/p" } }) } : null),
    on: (event, handler, options) => {
      hooks.set(event, (hooks.get(event) ?? []).concat([{ handler, options }]));
      return () => {};
    },
  };
  const { deps, disposers } = fakeDeps();
  deps.get = (name) => ctx.get(name);

  answererFeature.apply(ctx, {}, deps);
  const [entry] = hooks.get("user-questions/request");
  assert.equal(entry?.options?.prepend, true, "ответчик подписан с prepend");

  const controller = new AbortController();
  const pending = entry.handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: SESSION_ID }, signal: controller.signal },
    () => assert.fail("режим включён — next() звать нельзя"),
  );
  await tick();
  assert.equal(sent.length, 1, "вопрос ушёл в транспорт, а не в GUI");

  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  disposeAll(disposers);
});

/** Аккуратно вызвать все disposer'ы (фича могла зарегистрировать несколько). */
function disposeAll(disposers) {
  for (const dispose of [...disposers].reverse()) {
    try {
      dispose();
    } catch {
      /* не мешает тесту */
    }
  }
}

test("connect при включённом режиме: просим сначала выключить", async (t) => {
  const stand = harness(t, { answers: CONNECT_ANSWERS });
  stand.store.setEnabled({ kind: "workspace", id: WORKSPACE }, true);

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /выключите удалённый режим/);
  assert.equal(stand.store.read().bindings, null);
});

test("connect: без ctx.credentials, но с токеном в окружении — привязка проходит", async (t) => {
  const previous = process.env[TELEGRAM_TOKEN_REF];
  process.env[TELEGRAM_TOKEN_REF] = TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env[TELEGRAM_TOKEN_REF];
    else process.env[TELEGRAM_TOKEN_REF] = previous;
  });
  const telegram = telegramFetch();
  const stand = harness(t, { answers: CONNECT_ANSWERS, credentials: null, fetchImpl: telegram.fetch });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /из окружения/);
  assert.equal(stand.store.read().bindings.botUsername, "test_bot");
  assert.equal(stand.store.read().enabled.workspaces[WORKSPACE], true);
});

test("status без ctx.credentials: секрет из окружения и только для чтения", async (t) => {
  const previous = process.env[TELEGRAM_TOKEN_REF];
  process.env[TELEGRAM_TOKEN_REF] = TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env[TELEGRAM_TOKEN_REF];
    else process.env[TELEGRAM_TOKEN_REF] = previous;
  });
  const stand = harness(t, { credentials: null });

  const result = await stand.remote.handler(invoke("status"));

  assert.equal(result.kind, "success");
  assert.match(result.text, /источник env \(только чтение\)/);
  assert.equal(result.text.includes(TOKEN), false);
});

test("connect отменяется по signal, lock освобождается", async (t) => {
  const controller = new AbortController();
  const stand = harness(t, {
    answers: CONNECT_ANSWERS,
    fetchImpl: async (url, init = {}) => {
      const method = url.split("/").pop();
      if (method === "getMe") return { ok: true, status: 200, async json() { return { ok: true, result: { username: "test_bot" } }; } };
      return new Promise((_, reject) => {
        init.signal?.addEventListener?.("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  });

  const pending = stand.remote.handler(invoke("connect", { signal: controller.signal }));
  await tick(2);
  controller.abort();
  const result = await pending;

  assert.equal(result.kind, "error");
  assert.equal(stand.store.read().bindings, null, "привязки нет");
  assert.equal(fs.existsSync(stand.store.paths.lock), false, "lock снят после отмены");
});

test("/remote test: клик по кнопке закрывает тестовое сообщение", async (t) => {
  const sent = [];
  const closed = [];
  let emit = null;
  const transport = {
    id: "telegram",
    sendQuestion: async (question) => {
      sent.push(question);
      return { messageId: 1 };
    },
    closeQuestion: async (question, summary) => closed.push({ question, summary }),
    onAnswer: (handler) => {
      emit = handler;
      return () => {
        emit = null;
      };
    },
    stop: async () => {},
  };
  const stand = harness(t, { transport });
  stand.store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });

  const result = await stand.remote.handler(invoke("test"));
  assert.equal(result.kind, "success", result.text);
  assert.equal(sent.length, 1);

  emit({ shortId: sent[0].shortId, optionIds: ["o1"], answeredBy: "7" });
  await tick(2);

  assert.equal(closed.length, 1, "ответ закрывает тестовое сообщение");
  assert.equal(emit, null, "подписка снята");
});

test("connect: ошибка хранилища на записи — привязки нет, текст без стека", async (t) => {
  const stand = harness(t, { answers: CONNECT_ANSWERS });
  const broken = {
    ...stand.store,
    update() {
      throw new Error("диск кончился");
    },
  };
  const telegram = telegramFetch();
  const remote = createRemoteCommands({
    ctx: stand.ctx,
    store: broken,
    log: () => {},
    now: () => stand.clock,
    sleep: async () => {},
    random: () => CODE_RANDOM,
    fetch: telegram.fetch,
  });

  const result = await remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /привязка не сохранена: диск кончился/);
  assert.equal(result.text.includes("    at "), false);
  assert.equal(stand.store.read().bindings, null, "частичной записи нет");
});

test("фича commands: смена привязки и токена пересоздаёт транспорт", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-reconnect-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const store = createStore({ file });
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });

  const previousState = process.env.DSH_REMOTE_STATE;
  process.env.DSH_REMOTE_STATE = file;
  t.after(() => {
    if (previousState === undefined) delete process.env.DSH_REMOTE_STATE;
    else process.env.DSH_REMOTE_STATE = previousState;
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangingTelegramFetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let token = "111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const services = new Map();
  const ctx = {
    provide: (name, service) => services.set(name, service),
    get: (name) => (name === "credentials" ? { resolve: async () => ({ value: token, source: "file" }) } : services.get(name) ?? null),
    commands: { register: () => () => {} },
    userQuestions: { ask: async () => ({ answers: [] }) },
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  };
  const { deps } = fakeDeps();
  deps.get = (name) => ctx.get(name);

  const api = await commandsFeature.apply(ctx, {}, deps);
  const first = api.facade.current;
  assert.ok(first !== null, "канал поднят");
  assert.equal(first.polling, true);

  // Новая привязка и новый токен — старый поллер не должен остаться.
  createStore({ file }).setBinding({ transport: "telegram", chatId: 43, userId: 8, botUsername: "test_bot" });
  token = "222:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  const second = await api.ensureTransport();

  assert.notEqual(second, first, "транспорт пересоздан");
  assert.equal(first.polling, false, "старый поллинг остановлен");
  assert.equal(api.facade.current, second);
  await api.facade.stop();
});

test("фича commands: выгрузка во время credentials.resolve не поднимает канал", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-dispose-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  createStore({ file }).setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });

  const previousState = process.env.DSH_REMOTE_STATE;
  process.env.DSH_REMOTE_STATE = file;
  t.after(() => {
    if (previousState === undefined) delete process.env.DSH_REMOTE_STATE;
    else process.env.DSH_REMOTE_STATE = previousState;
  });

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    return originalFetch(...args);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let releaseResolve;
  const services = new Map();
  const ctx = {
    provide: (name, service) => services.set(name, service),
    get: (name) => (name === "credentials"
      ? { resolve: () => new Promise((resolve) => { releaseResolve = resolve; }) }
      : services.get(name) ?? null),
    commands: { register: () => () => {} },
    userQuestions: { ask: async () => ({ answers: [] }) },
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  };
  const { deps, disposers } = fakeDeps();
  deps.get = (name) => ctx.get(name);

  const pending = commandsFeature.apply(ctx, {}, deps);
  await tick(2);
  // Плагин выгружают, пока резолв токена висит.
  disposeAll(disposers);
  releaseResolve({ value: "123456:TEST-TOKEN", source: "file" });
  await pending;

  const facade = services.get("remoteTransport");
  assert.ok(facade, "сервис зарегистрирован");
  assert.equal(facade.current, null, "канал не поднят после выгрузки");
  assert.equal(fetchCalls, 0, "сеть не тронули");
});

// --- регрессии по второму ревью 005 ----------------------------------------

/** Фейковый контекст с подменяемыми сервисами и учётом эффектов. */
function makePluginCtx({ token = "111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", services = new Map() } = {}) {
  const provided = new Map();
  const disposers = [];
  const hooks = new Map();
  const ctx = {
    provide: (name, service) => {
      if (services.has(name)) services.set(name, service);
      provided.set(name, service);
      return service;
    },
    get: (name) => {
      if (name === "credentials") return { resolve: async () => ({ value: token, source: "file" }) };
      if (name === "sessionController") return null;
      return provided.get(name) ?? services.get(name) ?? null;
    },
    on: (event, handler, options) => {
      hooks.set(event, (hooks.get(event) ?? []).concat([{ handler, options }]));
      return () => {};
    },
    effect: (execute) => {
      const disposable = execute();
      disposers.push(disposable);
      return () => disposable?.();
    },
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  };
  return { ctx, provided, hooks, disposers, services };
}

function withTempState(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-facade-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const previous = process.env.DSH_REMOTE_STATE;
  process.env.DSH_REMOTE_STATE = file;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_REMOTE_STATE;
    else process.env.DSH_REMOTE_STATE = previous;
  });
  return { dir, file, store: createStore({ file }) };
}

test("фасад: dispose гасит запущенный канал и снимает подписки", async (t) => {
  const { store } = withTempState(t);
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangingTelegramFetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { ctx, provided } = makePluginCtx();
  const { deps, disposers } = fakeDeps();
  const api = await commandsFeature.apply(ctx, {}, deps);
  const facade = provided.get("remoteTransport");
  const live = facade.current;
  assert.equal(live?.polling, true, "канал запущен");

  let offCalls = 0;
  const off = live.onAnswer(() => {});
  assert.equal(typeof off, "function");
  facade.onAnswer((answer) => void answer);
  // Выгрузка плагина: фасадный dispose должен погасить поллинг и снять подписки.
  for (const dispose of [...disposers].reverse()) await dispose?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(facade.current, null, "живого канала после dispose нет");
  assert.equal(live.polling, false, "старый поллер остановлен");
  off();
  void api;
});

test("фасад без канала: отправка — ошибка, /remote test и on честно отказывают", async (t) => {
  const stand = harness(t);
  const { ctx, provided } = makePluginCtx();
  const { deps, disposers } = fakeDeps();
  await commandsFeature.apply(ctx, {}, deps);
  const facade = provided.get("remoteTransport");
  assert.equal(facade.current, null, "привязки нет — канала нет");

  assert.throws(() => facade.sendQuestion({ shortId: "a1" }), /канал не поднят/);
  assert.equal(facade.start(), false, "start без канала — false, а не undefined");

  const noBinding = await stand.remote.handler(invoke("on"));
  assert.equal(noBinding.kind, "error");
  assert.match(noBinding.text, /сначала привяжите бота/);

  const testCommand = await stand.remote.handler(invoke("test"));
  assert.equal(testCommand.kind, "error");

  for (const dispose of [...disposers].reverse()) dispose?.();
});

test("config-путь: транспорт из config кладётся в фасад и заменяется при connect", async (t) => {
  const { store } = withTempState(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangingTelegramFetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Имитируем фичу telegram (004): транспорт из config уже в контексте.
  const configTransport = {
    id: "telegram",
    polling: true,
    stalled: [],
    async start() {
      this.polling = true;
    },
    async stop() {
      this.polling = false;
    },
    async sendQuestion() {
      return { messageId: 1 };
    },
    onAnswer: () => () => {},
    caps: {},
  };
  const services = new Map([["remoteTransport", configTransport]]);
  const { ctx, provided } = makePluginCtx({ services });
  const { deps } = fakeDeps();
  const api = await commandsFeature.apply(ctx, {}, deps);

  const facade = provided.get("remoteTransport");
  assert.equal(facade.__isTransportFacade, true, "config-транспорт обёрнут фасадом");
  assert.equal(facade.current, configTransport, "живой канал — из config");

  // Новая привязка и новый токен: config-транспорт должен быть остановлен.
  store.setBinding({ transport: "telegram", chatId: 43, userId: 8, botUsername: "test_bot" });
  const replaced = await api.ensureTransport();
  assert.notEqual(replaced, configTransport, "канал пересоздан из состояния");
  assert.equal(configTransport.polling, false, "config-транспорт остановлен");
  assert.equal(facade.current, replaced);
  await facade.stop();
});

test("connect: при пустом канале не пишет «канал поднят»", async (t) => {
  const telegram = telegramFetch();
  const stand = harness(t, { answers: CONNECT_ANSWERS, fetchImpl: telegram.fetch });
  const remote = createRemoteCommands({
    ctx: stand.ctx,
    store: stand.store,
    log: () => {},
    now: () => stand.clock,
    fetch: telegram.fetch,
    random: () => CODE_RANDOM,
    sleep: async () => {},
    ensureTransport: async () => null,
    currentChannel: () => null,
  });

  const result = await remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /канал не поднят|канал поднимется/);
  assert.doesNotMatch(result.text, /канал поднят:/);
});

test("/remote test: подписка снимается по таймауту, если никто не нажал", async (t) => {
  let offCalls = 0;
  const transport = {
    id: "telegram",
    sendQuestion: async () => ({ messageId: 1 }),
    closeQuestion: async () => {},
    onAnswer: (handler) => {
      void handler;
      return () => {
        offCalls += 1;
      };
    },
    stop: async () => {},
  };
  const stand = harness(t, { transport });
  stand.store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const remote = createRemoteCommands({
    ctx: stand.ctx,
    store: stand.store,
    log: () => {},
    now: () => stand.clock,
    currentChannel: () => transport,
    testAnswerTimeoutMs: 1000,
    setTimeout: (callback) => {
      callback();
      return { unref: () => {} };
    },
  });

  const result = await remote.handler(invoke("test"));

  assert.equal(result.kind, "success", result.text);
  assert.equal(offCalls, 1, "подписка снята таймаутом, listener не утёк");
});

test("state+config на старте: один канал, старый поллер остановлен", async (t) => {
  const { store } = withTempState(t);
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangingTelegramFetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const configTransport = {
    id: "telegram",
    polling: false,
    async start() { this.polling = true; },
    async stop() { this.polling = false; },
    async sendQuestion() { return { messageId: 1 }; },
    onAnswer: () => () => {},
    caps: {},
  };
  const services = new Map([["remoteTransport", configTransport]]);
  const { ctx, provided } = makePluginCtx({ services });
  const { deps } = fakeDeps();

  await commandsFeature.apply(ctx, {}, deps);
  const facade = provided.get("remoteTransport");
  const stateTransport = facade.current;
  assert.notEqual(stateTransport, configTransport, "сначала поднят канал из состояния");
  assert.equal(stateTransport.polling, true);

  await telegramFeature.apply(ctx, { telegram: { tokenRef: TELEGRAM_TOKEN_REF, chatId: 42, allowedUserIds: [7] } }, deps);
  await new Promise((resolve) => setImmediate(resolve));

  assert.notEqual(facade.current, stateTransport, "config-канал стал текущим");
  assert.equal(facade.current.polling, true, "config-канал запущен");
  assert.equal(stateTransport.polling, false, "старый state-поллер остановлен");
  await facade.stop();
});

test("config-only: статус, on и test работают без привязки в состоянии", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangingTelegramFetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const sent = [];
  const configTransport = {
    id: "telegram",
    polling: true,
    async start() { this.polling = true; },
    async stop() { this.polling = false; },
    async sendQuestion(question) { sent.push(question); return { messageId: 1 }; },
    async closeQuestion() {},
    onAnswer: () => () => {},
    caps: {},
  };
  const services = new Map([["remoteTransport", configTransport]]);
  const { ctx, provided } = makePluginCtx({ services });
  const { deps, disposers } = fakeDeps();

  await commandsFeature.apply(ctx, {}, deps);
  await telegramFeature.apply(ctx, { telegram: { tokenRef: TELEGRAM_TOKEN_REF, chatId: 42, allowedUserIds: [7] } }, deps);
  const facade = provided.get("remoteTransport");
  assert.notEqual(facade.current, null, "config-канал внутри фасада");
  const stand = harness(t);
  const remote = createRemoteCommands({
    ctx: stand.ctx,
    store: stand.store,
    log: () => {},
    now: () => stand.clock,
    currentChannel: () => facade.current,
  });

  const status = await remote.handler(invoke("status"));
  assert.equal(status.kind, "success");
  assert.match(status.text, /канал/);

  const on = await remote.handler(invoke("on --all"));
  assert.equal(on.kind, "success", on.text);

  const test = await remote.handler(invoke("test"));
  assert.equal(test.kind, "success", test.text);

  for (const dispose of [...disposers].reverse()) await dispose?.();
  void provided;
});

test("токен пропал: живой канал останавливается", async (t) => {
  const { store } = withTempState(t);
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = hangingTelegramFetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let token = "111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const provided = new Map();
  const services = new Map();
  const ctx = {
    provide: (name, service) => provided.set(name, service),
    get: (name) => (name === "credentials"
      ? { resolve: async () => (token === null ? undefined : { value: token, source: "file" }) }
      : services.get(name) ?? provided.get(name) ?? null),
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
    logger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  };
  const { deps } = fakeDeps();
  const api = await commandsFeature.apply(ctx, {}, deps);
  const facade = provided.get("remoteTransport");
  const live = facade.current;
  assert.equal(live.polling, true);

  token = null;
  const second = await api.ensureTransport();

  assert.equal(second, null, "без секрета канал не поднимается");
  assert.equal(facade.current, null, "и старый канал остановлен");
  assert.equal(live.polling, false);
});

test("connect: start() -> false не выдаётся за поднятый канал", async (t) => {
  const telegram = telegramFetch();
  const stand = harness(t, { answers: CONNECT_ANSWERS, fetchImpl: telegram.fetch });
  const started = [];
  const transport = { id: "telegram", start: async () => { started.push("start"); return false; }, stop: async () => {} };
  const remote = createRemoteCommands({
    ctx: stand.ctx,
    store: stand.store,
    log: () => {},
    now: () => stand.clock,
    fetch: telegram.fetch,
    random: () => CODE_RANDOM,
    sleep: async () => {},
    ensureTransport: async () => transport,
    currentChannel: () => (started.length > 0 ? transport : null),
  });

  const result = await remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /канал не поднят/);
  assert.doesNotMatch(result.text, /канал поднят:/);
});

test("connect relay работает без Telegram-токена и не пишет секрет в состояние", async (t) => {
  const RELAY_URL = "https://relay.test";
  const RELAY_TOKEN = "relay-agent-secret";
  const creds = fakeCredentials({ value: null });
  const stand = harness(t, {
    credentials: creds,
    answers: {
      "remote-connect-transport": { selected: ["Relay (свой сервер)"] },
      "remote-connect-relay-url": { custom: RELAY_URL },
      "remote-connect-relay-token": { custom: RELAY_TOKEN },
      "remote-connect-scope": { selected: ["Пока не включать"] },
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/healthz")) return jsonResponse({ ok: true, version: "0.1.0" });
      // Авторизованный пробник: 404 значит «ответа ещё нет», токен принят.
      return jsonResponse({ error: { code: "not-found", message: "ответа пока нет" } }, 404);
    },
  });
  // Telegram-секрета нет вовсе: провайдер секретов «пуст», как в сценарии ревью.
  stand.ctx.get = ((original) => (name) => (name === "credentials" ? null : original(name)))(stand.ctx.get);

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "success", result.text);
  assert.match(result.text, /релей привязан: https:\/\/relay\.test/);
  assert.match(result.text, /relay 0\.1\.0/);
  const state = stand.store.read();
  assert.equal(state.bindings.transport, "relay");
  assert.equal(state.bindings.url, RELAY_URL);
  assert.equal(JSON.stringify(state).includes(RELAY_TOKEN), false, "токен не попал в состояние");
  assert.equal(result.text.includes(RELAY_TOKEN), false, "токен не напечатан");
  assert.equal(RELAY_TOKEN_REF, "DSH_REMOTE_RELAY_TOKEN");
});

test("connect relay: неверный токен отвергается авторизованным пробником, ничего не сохраняется", async (t) => {
  const RELAY_TOKEN = "definitely-wrong-token-XXX";
  const stand = harness(t, {
    credentials: fakeCredentials({ value: null }),
    answers: {
      "remote-connect-transport": { selected: ["Relay (свой сервер)"] },
      "remote-connect-relay-url": { custom: "https://relay.test" },
      "remote-connect-relay-token": { custom: RELAY_TOKEN },
      "remote-connect-scope": { selected: ["Только этот проект"] },
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith("/healthz")) return jsonResponse({ ok: true, version: "0.1.0" });
      return jsonResponse({ error: { code: "unauthorized", message: "нужен Bearer-токен" } }, 401);
    },
  });

  const result = await stand.remote.handler(invoke("connect"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /не принял токен агента/);
  assert.match(result.text, /unauthorized/);
  assert.equal(stand.store.read().bindings, null, "binding не сохранён");
  assert.equal(stand.credentials.calls.some(([method, ref]) => method === "set" && ref === RELAY_TOKEN_REF), false, "неверный токен не записан");
  assert.equal(result.text.includes(RELAY_TOKEN), false, "токен не напечатан");
});

/** Записать решения в журнал стенда (тот же каталог, что state.json). */
function writeAudit(stand, entries) {
  const audit = createAudit({ file: path.join(stand.dir, "audit.jsonl"), now: () => START_MS });
  for (const entry of entries) audit.append(entry);
}

const AUDIT_REMOTE = {
  kind: "approval",
  questionId: "a-1",
  toolName: "Bash",
  callId: "call-1",
  outcome: "allowed-once",
  channel: "telegram",
  answeredBy: "user-7",
  waitedMs: 4_000,
  decision: "remote",
};
const AUDIT_GUI = { ...AUDIT_REMOTE, questionId: "a-2", toolName: "Write", outcome: "unavailable", decision: "gui" };
const AUDIT_TIMEOUT = { ...AUDIT_REMOTE, questionId: "a-3", toolName: "Edit", outcome: "cancelled", decision: "timeout" };

test("/remote audit на пустом журнале отвечает справкой, а не падает", async (t) => {
  const stand = harness(t);

  const result = await stand.remote.handler(invoke("audit"));

  assert.equal(result.kind, "success");
  assert.match(result.text, /журнал подтверждений пуст/);
});

test("/remote audit N показывает последние решения без секретов", async (t) => {
  const stand = harness(t);
  writeAudit(stand, [AUDIT_REMOTE, AUDIT_GUI, AUDIT_TIMEOUT]);

  const result = await stand.remote.handler(invoke("audit 2"));

  assert.equal(result.kind, "success");
  assert.match(result.text, /Последние 2 из 3 решений/);
  assert.match(result.text, /Write/);
  assert.match(result.text, /GUI/);
  assert.match(result.text, /Edit/);
  assert.match(result.text, /таймаут/);
  assert.equal(/Bash/.test(result.text), false, "самое старое решение не попало в хвост из двух");
});

test("/remote audit: некорректный N — ошибка без стека", async (t) => {
  const stand = harness(t);
  writeAudit(stand, [AUDIT_REMOTE]);

  const result = await stand.remote.handler(invoke("audit ноль"));

  assert.equal(result.kind, "error");
  assert.match(result.text, /usage: \/remote audit/);
});

test("status: сводка по подтверждениям — удалённо/GUI/без ответа", async (t) => {
  const stand = harness(t);
  writeAudit(stand, [AUDIT_REMOTE, AUDIT_GUI, AUDIT_TIMEOUT]);

  const result = await stand.remote.handler(invoke("status"));

  assert.equal(result.kind, "success");
  assert.match(result.text, /подтверждения: удалённо 1, в GUI 1, без ответа 1 \(всего 3\)/);
});

test("/remote status: показывает действующую политику подтверждений", async (t) => {
  const { createApprovalPolicy } = await import("../lib/approvals/policy.js");
  const policy = createApprovalPolicy({ tools: ["read_file"], denyRemote: ["bash"], onTimeout: "unavailable", ttlMs: 300_000 });
  const stand = harness(t);
  const originalGet = stand.ctx.get;
  stand.ctx.get = (name) => (name === "remoteApprovalPolicy" ? policy : originalGet(name));

  const result = await stand.remote.handler(invoke("status"));

  assert.equal(result.kind, "success");
  assert.match(result.text, /approvals: tools=\[read_file\]/);
  assert.match(result.text, /approvals: denyRemote=\[bash\]/);
  assert.match(result.text, /approvals: onTimeout=unavailable \(отказ\), ttl=5 мин/);
});

test("/remote status: без сервиса политики честно говорит «только в GUI»", async (t) => {
  const stand = harness(t);
  const originalGet = stand.ctx.get;
  stand.ctx.get = (name) => (name === "remoteApprovalPolicy" ? null : originalGet(name));

  const result = await stand.remote.handler(invoke("status"));

  assert.match(result.text, /approvals: политика не загружена — удалённые подтверждения только в GUI/);
});

test("/remote audit: поздний ответ помечается «поздний», сводка статуса не меняется", async (t) => {
  const stand = harness(t);
  writeAudit(stand, [
    AUDIT_REMOTE,
    AUDIT_GUI,
    AUDIT_TIMEOUT,
    { ...AUDIT_REMOTE, questionId: "a-4", decision: "late", outcome: "rejected" },
  ]);

  const auditResult = await stand.remote.handler(invoke("audit 1"));
  assert.equal(auditResult.kind, "success");
  assert.match(auditResult.text, /поздний/);
  assert.match(auditResult.text, /rejected/);

  const status = await stand.remote.handler(invoke("status"));
  assert.match(status.text, /подтверждения: удалённо 1, в GUI 1, без ответа 1 \(всего 4\)/);
});
