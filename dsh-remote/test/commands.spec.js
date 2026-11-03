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
function invoke(rawInput) {
  return {
    commandId: "c1",
    agent: { id: "agent-1", session: { id: SESSION_ID } },
    rawInput,
    signal: new AbortController().signal,
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

  const onWorkspace = await stand.remote.handler(invoke("on"));
  assert.equal(onWorkspace.kind, "success");
  assert.match(onWorkspace.text, /\/p/);
  assert.equal(stand.store.read().enabled.workspaces[WORKSPACE], true);

  await stand.remote.handler(invoke("on --all"));
  assert.equal(stand.store.read().enabled.global, true);

  await stand.remote.handler(invoke("on --session"));
  assert.equal(stand.store.read().enabled.sessions[SESSION_ID], true);

  const off = await stand.remote.handler(invoke("off --all"));
  assert.equal(off.kind, "success");
  assert.equal(stand.store.read().enabled.global, false);
});

test("on без cwd: подсказка про --all и --session", async (t) => {
  const stand = harness(t, { sessions: { get: () => ({ header: {} }) } });

  const result = await stand.remote.handler(invoke("on"));

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
  assert.match(noTransport.text, /транспорт не поднят/);
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
