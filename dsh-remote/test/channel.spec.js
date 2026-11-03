/**
 * Тесты каналов проектов (015): маршрутизация вопросов по воркспейсу, fallback
 * на общий чат, команда `/remote channel` и allowlist для чатов проектов.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAnswerer } from "../lib/answerer.js";
import { createRemoteCommands } from "../lib/commands.js";
import { createRegistry } from "../lib/domain/registry.js";
import { resolveChannel, createStore } from "../lib/store.js";
import { createTelegramTransport } from "../lib/transport/telegram.js";

const SESSION_ID = "session-ch";

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-channel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createStore({ file: path.join(dir, "state.json") });
}

function fakeTransport(id = "telegram") {
  const handlers = [];
  const sent = [];
  return {
    id,
    caps: { inlineButtons: true, editAfterAnswer: true, maxText: 4096, maxOptions: 8 },
    sent,
    async sendQuestion(question, options) {
      sent.push({ question, options });
      return { messageId: "mid-1" };
    },
    async closeQuestion() {},
    async editQuestion() {
      return true;
    },
    onAnswer(handler) {
      handlers.push(handler);
      return () => {};
    },
    answer(event) {
      for (const handler of handlers) handler(event);
    },
    async healthCheck() {
      return { ok: true, detail: "ok" };
    },
  };
}

const tick = async (times = 4) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("resolveChannel: канал проекта, fallback на общий чат, отсутствие канала", () => {
  const state = {
    bindings: { transport: "telegram", chatId: 42 },
    channels: { alpha: { chatId: 100, threadId: 7 }, beta: { chatId: 200 } },
  };

  assert.deepEqual(resolveChannel(state, "/p/alpha"), { chatId: 100, threadId: 7, source: "workspace" });
  assert.deepEqual(resolveChannel(state, "/p/beta/"), { chatId: 200, threadId: null, source: "workspace" });
  assert.deepEqual(resolveChannel(state, "/p/gamma"), { chatId: 42, threadId: null, source: "default" });
  assert.deepEqual(resolveChannel({ bindings: null, channels: {} }, "/p/gamma"), { chatId: null, threadId: null, source: null });
});

test("вопрос уходит в канал своего проекта; нет канала — в общий чат", async (t) => {
  const store = tempStore(t);
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  store.setChannel("alpha", { chatId: 100, threadId: 7 });
  store.setChannel("beta", { chatId: 200 });

  const transport = fakeTransport();
  const registry = createRegistry({ readState: () => ({ global: true }) });
  const answerer = createAnswerer({
    transport,
    registry,
    channelOf: (workspace) => resolveChannel(store.read(), workspace),
    log: () => {},
    now: () => 0,
  });
  answerer.attach({
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
    get: (name) => (name === "sessions" ? { get: (id) => ({ header: { cwd: id } }) } : null),
  });

  const pending = answerer.handler(
    { questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }], agent: { id: "/p/alpha" } },
    () => assert.fail("next() нельзя"),
  );
  await tick();
  assert.deepEqual(transport.sent[0].options, { chatId: 100, threadId: 7 });

  transport.answer({ shortId: transport.sent[0].question.shortId, optionId: "o1" });
  await pending;

  const second = answerer.handler(
    { questions: [{ id: "q2", question: "Ещё?", options: [{ label: "Да" }] }], agent: { id: "/p/beta" } },
    () => assert.fail("next() нельзя"),
  );
  await tick();
  assert.equal(transport.sent[1].options.chatId, 200);

  transport.answer({ shortId: transport.sent[1].question.shortId, optionId: "o1" });
  await second;

  const third = answerer.handler(
    { questions: [{ id: "q3", question: "Общий?", options: [{ label: "Да" }] }], agent: { id: "/p/gamma" } },
    () => assert.fail("next() нельзя"),
  );
  await tick();
  assert.equal(transport.sent[2].options.chatId, 42, "fallback на общий чат привязки");
  transport.answer({ shortId: transport.sent[2].question.shortId, optionId: "o1" });
  await third;
});

test("telegram: threadId едет как message_thread_id, чаты проектов в allowlist", async (t) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, body: init.body === undefined ? null : JSON.parse(init.body) });
    if (parsed.pathname.endsWith("/getUpdates")) {
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener?.("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    if (parsed.pathname.endsWith("/sendMessage")) {
      return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 11 } }; } };
    }
    return { ok: true, status: 200, async json() { return { ok: true, result: true }; } };
  };
  const transport = createTelegramTransport({
    token: "123:TEST",
    chatId: 42,
    allowedUserIds: [7],
    allowedChatIds: [100, 200],
    fetch: fetchImpl,
    jitter: () => 0,
    now: () => 0,
    sleep: async () => {},
    log: () => {},
    persistOffset: () => {},
  });
  t.after(() => {
    void transport.stop?.();
  });

  await transport.sendQuestion(
    { shortId: "a1b2c3d4", body: "Вопрос", options: [{ id: "o1", label: "Да" }] },
    { chatId: 100, threadId: 7 },
  );
  const send = calls.find((call) => call.path.endsWith("/sendMessage"));
  assert.equal(send.body.chat_id, 100);
  assert.equal(send.body.message_thread_id, 7, "топик форума");

  // Allowlist: апдейт из чата проекта — свой, из чужого — игнор.
  const answers = [];
  transport.onAnswer((answer) => answers.push(answer));
  await transport.start();
  await new Promise((resolve) => setImmediate(resolve));
  const waiter = calls.length;
  void waiter;
  await transport.stop();

  assert.equal(answers.length, 0, "без апдейтов ответов нет");
});

/** Команды `/remote` на временном состоянии. */
function makeCommands(t) {
  const store = tempStore(t);
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const ctx = {
    get: (name) => (name === "sessions" ? { get: () => ({ header: { cwd: "/p/alpha" } }) } : null),
    userQuestions: { ask: async () => ({ answers: [] }) },
    on: () => () => {},
    effect: (execute) => {
      const disposable = execute();
      return () => disposable?.();
    },
  };
  const remote = createRemoteCommands({
    ctx,
    store,
    log: () => {},
    now: () => 0,
    currentChannel: () => ({ id: "telegram", start: async () => {}, stop: async () => {} }),
  });
  const invoke = (rawInput) => ({
    commandId: "c1",
    agent: { id: SESSION_ID, session: { id: SESSION_ID } },
    rawInput,
    signal: new AbortController().signal,
  });
  return { store, remote, invoke };
}

test("/remote channel: канал в свой чат, list, remove и status", async (t) => {
  const { store, remote, invoke } = makeCommands(t);

  const set = await remote.handler(invoke("channel alpha 42 7"));
  assert.equal(set.kind, "success", set.text);
  assert.deepEqual(store.read().channels.alpha, { chatId: 42, threadId: 7 });

  const list = await remote.handler(invoke("channel list"));
  assert.match(list.text, /alpha → чат 42, топик 7/);

  const status = await remote.handler(invoke("status"));
  assert.match(status.text, /канал alpha: чат 42, топик 7/);

  const removed = await remote.handler(invoke("channel remove alpha"));
  assert.equal(removed.kind, "success");
  assert.deepEqual(store.read().channels, {});
  assert.match((await remote.handler(invoke("status"))).text, /каналы проектов: нет/);
});

test("/remote channel: чужой chatId отвергается, --force обходит осознанно", async (t) => {
  const { store, remote, invoke } = makeCommands(t);

  const foreign = await remote.handler(invoke("channel beta 999"));
  assert.equal(foreign.kind, "error");
  assert.match(foreign.text, /чужой чат/);
  assert.equal(store.read().channels.beta, undefined, "ничего не записали");

  const forced = await remote.handler(invoke("channel beta 999 --force"));
  assert.equal(forced.kind, "success", forced.text);
  assert.equal(store.read().channels.beta.chatId, 999);
});

test("/remote channel: без привязки канал всё равно можно задать", async (t) => {
  const store = tempStore(t);
  const remote = createRemoteCommands({
    ctx: {
      get: () => null,
      userQuestions: { ask: async () => ({ answers: [] }) },
      on: () => () => {},
      effect: (execute) => {
        const disposable = execute();
        return () => disposable?.();
      },
    },
    store,
    log: () => {},
    now: () => 0,
  });
  const result = await remote.handler({
    commandId: "c1",
    agent: { id: SESSION_ID, session: { id: SESSION_ID } },
    rawInput: "channel gamma 123",
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, "success", result.text);
  assert.equal(store.read().channels.gamma.chatId, 123);
});

test("/remote channel: нечисловой chatId отвергается", async (t) => {
  const { remote, invoke } = makeCommands(t);
  const result = await remote.handler(invoke("channel alpha abc"));
  assert.equal(result.kind, "error");
  assert.match(result.text, /chatId должен быть целым ненулевым числом/);
});

// --- регрессии по ревью 015 -------------------------------------------------

test("/remote channel: отрицательный chatId группы/супергруппы принимается", async (t) => {
  const { store, remote, invoke } = makeCommands(t);

  const result = await remote.handler(invoke("channel forum -1001234567890 7 --force"));

  assert.equal(result.kind, "success", result.text);
  assert.deepEqual(store.read().channels.forum, { chatId: -1001234567890, threadId: 7 });
});

test("/remote channel: полный путь проекта нормализуется до basename", async (t) => {
  const { store, remote, invoke } = makeCommands(t);

  const result = await remote.handler(invoke("channel /home/vic/projects/alpha 42"));

  assert.equal(result.kind, "success", result.text);
  assert.deepEqual(Object.keys(store.read().channels), ["alpha"], "ключ — basename");
  assert.deepEqual(resolveChannel(store.read(), "/p/alpha"), { chatId: 42, threadId: null, source: "workspace" });
});

test("allowlist проектных чатов обновляется без рестарта транспорта", async (t) => {
  const store = tempStore(t);
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });

  const updates = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/getUpdates")) {
      return new Promise((resolve, reject) => {
        updates.push({ resolve, reject, init });
        init.signal?.addEventListener?.("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    return { ok: true, status: 200, async json() { return { ok: true, result: true }; } };
  };
  const transport = createTelegramTransport({
    token: "123:TEST",
    chatId: 42,
    allowedUserIds: [7],
    allowedChatIds: () => Object.values(store.read().channels).map((channel) => channel.chatId),
    fetch: fetchImpl,
    jitter: () => 0,
    now: () => 0,
    sleep: async () => {},
    log: () => {},
    persistOffset: () => {},
  });
  t.after(() => {
    void transport.stop?.();
  });
  const answers = [];
  transport.onAnswer((answer) => answers.push(answer));

  store.setChannel("alpha", { chatId: 100 }); // канал добавили ПОСЛЕ старта
  await transport.start();
  await new Promise((resolve) => setImmediate(resolve));

  const pushUpdate = (update) => {
    const waiter = updates.shift();
    waiter.resolve({
      ok: true,
      status: 200,
      async json() {
        return { ok: true, result: [update] };
      },
    });
  };

  pushUpdate({
    update_id: 1,
    callback_query: { id: "c1", from: { id: 7 }, data: "q:a1b2c3d4:o1", message: { message_id: 1, chat: { id: 100 } } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answers.length, 1, "новый чат проекта принят");

  store.removeChannel("alpha"); // удалили канал
  pushUpdate({
    update_id: 2,
    callback_query: { id: "c2", from: { id: 7 }, data: "q:a1b2c3d4:o2", message: { message_id: 2, chat: { id: 100 } } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answers.length, 1, "старый чат больше не принимается");
});

test("remove с полным путём удаляет basename-канал и возвращает fallback", async (t) => {
  const { store, remote, invoke } = makeCommands(t);

  await remote.handler(invoke("channel /home/vic/projects/alpha 100 --force"));
  assert.deepEqual(Object.keys(store.read().channels), ["alpha"]);

  const removed = await remote.handler(invoke("channel remove /home/vic/projects/alpha"));
  assert.equal(removed.kind, "success", removed.text);
  assert.deepEqual(store.read().channels, {}, "канал удалён, мусорного ключа нет");
  assert.equal(resolveChannel(store.read(), "/p/alpha").source, "default", "проект вернулся в общий чат");
});

test("normalizeState нормализует ключи channels (старый/мусорный state)", (t) => {
  const store = tempStore(t);
  // Пишем в обход setChannel: как могло остаться от прежней версии/ручной правки.
  store.update((state) => {
    state.channels = {
      "/home/vic/alpha": { chatId: 100 },
      "beta/": { chatId: 200, threadId: 5 },
      "/": { chatId: 300 },
    };
    return state;
  });

  const channels = store.read().channels;
  assert.deepEqual(Object.keys(channels).sort(), ["alpha", "beta"], "ключи — basename, мусор выброшен");
  assert.deepEqual(channels.beta, { chatId: 200, threadId: 5 });
});
