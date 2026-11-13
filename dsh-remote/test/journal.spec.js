/**
 * Рабочий журнал (051): формат, маскировка, ротация, выключение и ошибки.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createJournal, journalPath, redactJournalText } from "../lib/journal.js";
import { createAnswerer } from "../lib/answerer.js";
import { createRemoteCommands } from "../lib/commands.js";
import { createRegistry } from "../lib/domain/registry.js";
import { runHealthChecks } from "../lib/doctor.js";
import { createStore } from "../lib/store.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("051: журнал пишет JSON-строки с полями и 600", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const journal = createJournal({ file, now: () => 1_700_000_000_000 });

  assert.equal(journal.record("question.send", { transport: "max", shortId: "abcd1234", detail: { chatId: 42, options: 2 } }), true);
  assert.equal(journal.record("question.sent", { transport: "max", shortId: "abcd1234", detail: { messageId: "m1", keyboard: true } }), true);

  const entries = lines(file);
  assert.equal(entries.length, 2);
  assert.deepEqual(Object.keys(entries[0]).sort(), ["detail", "event", "level", "shortId", "transport", "ts"]);
  assert.equal(entries[0].ts, "2023-11-14T22:13:20.000Z");
  assert.equal(entries[0].event, "question.send");
  assert.equal(entries[0].transport, "max");
  assert.equal(entries[0].shortId, "abcd1234");
  assert.match(entries[0].detail, /chatId/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("051: секреты маскируются, текста ответа нет", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const journal = createJournal({ file });

  journal.record("question.error", {
    transport: "max",
    detail: { message: "Authorization: Bearer super-secret-token", token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
  });
  journal.record("answer.received", { transport: "max", shortId: "a1", detail: { optionIds: ["o1"], customLength: 12 } });

  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes("super-secret-token"), false);
  assert.equal(text.includes("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false, "токен не попал в журнал");
  assert.equal(text.includes('"custom"'), false, "текст ответа не пишется");
  assert.match(text, /customLength/);
  assert.equal(redactJournalText("token=abc").includes("abc"), false);
});

test("051: ротация по размеру и keep", (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const journal = createJournal({ file, maxBytes: 300, keep: 2 });
  for (let index = 0; index < 30; index += 1) {
    journal.record("question.send", { shortId: `s-${index}`, detail: { index } });
  }
  assert.equal(fs.existsSync(`${file}.1`), true);
  assert.equal(fs.existsSync(`${file}.3`), false, "keep=2");
  const all = [...lines(`${file}.1`), ...lines(file)];
  assert.equal(all.some((entry) => entry.shortId === "s-29"), true, "последняя запись не потеряна");
});

test("051: logFile: false и ошибка записи не ломают плагин", (t) => {
  const dir = tempDir(t);
  const disabled = createJournal({ file: path.join(dir, "log.jsonl"), enabled: false });
  assert.equal(disabled.record("question.send"), false);
  assert.equal(fs.existsSync(path.join(dir, "log.jsonl")), false);

  const blocker = path.join(dir, "blocker");
  fs.writeFileSync(blocker, "x");
  const messages = [];
  const journal = createJournal({ file: path.join(blocker, "log.jsonl"), logger: (message) => messages.push(message) });
  assert.equal(journal.record("question.send"), false);
  assert.equal(messages.length, 1, "одна строка в логгер");
  assert.equal(journal.record("question.sent"), false);
  assert.equal(messages.length, 1, "повторно не шумит");
});

test("051: путь журнала из config/env/statePaths", () => {
  assert.equal(journalPath({ config: { logFile: "/tmp/custom.log" } }), "/tmp/custom.log");
  assert.equal(journalPath({ config: {}, env: { DSH_REMOTE_LOG_FILE: "/tmp/env.log" } }), "/tmp/env.log");
  assert.match(journalPath({ config: {}, env: {} }), /remote-control[\\/]log\.jsonl$/);
});

function fakeJournal() {
  const events = [];
  return {
    events,
    record(event, fields = {}) {
      events.push({ event, ...fields });
      return true;
    },
  };
}

addressAnswererTests();

function addressAnswererTests() {
  function fakeTransport() {
    const handlers = new Set();
    return {
      id: "max",
      sent: [],
      closed: [],
      async sendQuestion(question) {
        this.sent.push(question);
        return { messageId: "m-1" };
      },
      async closeQuestion() {},
      onAnswer(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      answer(event) {
        for (const handler of [...handlers]) handler(event);
      },
    };
  }

  test("051: путь вопроса виден в журнале; ответ — без текста", async () => {
    const journal = fakeJournal();
    const transport = fakeTransport();
    const answerer = createAnswerer({
      transport,
      registry: createRegistry({ readState: () => ({ global: true }) }),
      journal,
      now: () => 1_000,
      log: () => {},
    });
    answerer.attach({ on: () => () => {}, get: () => null, effect: (fn) => { const d = fn(); return () => d?.(); } });

    const pending = answerer.handler({
      questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }],
      agent: { id: "s1" },
    }, () => assert.fail("next()"));
    await new Promise((resolve) => setImmediate(resolve));
    transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1", text: "секретный текст" });
    await pending;

    const names = journal.events.map((entry) => entry.event);
    assert.deepEqual(names, ["question.send", "question.sent", "answer.received"]);
    assert.equal(journal.events[0].transport, "max");
    assert.equal(journal.events[1].detail.messageId, "m-1");
    assert.equal(journal.events[1].detail.keyboard, true);
    assert.equal(journal.events[2].detail.customLength, "секретный текст".length);
    assert.equal(JSON.stringify(journal.events).includes("секретный текст"), false, "текст ответа не пишется");
  });

  test("051: ошибка транспорта пишется как question.error", async () => {
    const journal = fakeJournal();
    const error = Object.assign(new Error("MAX 500"), { status: 500, code: "internal" });
    const transport = {
      id: "max",
      async sendQuestion() { throw error; },
      async closeQuestion() {},
      onAnswer() { return () => {}; },
    };
    const answerer = createAnswerer({
      transport,
      registry: createRegistry({ readState: () => ({ global: true }) }),
      journal,
      log: () => {},
    });
    answerer.attach({ on: () => () => {}, get: () => null, effect: (fn) => { const d = fn(); return () => d?.(); } });

    const next = await answerer.handler({
      questions: [{ id: "q1", question: "Продолжать?", options: [] }],
      agent: { id: "s1" },
    }, () => "gui");

    assert.equal(next, "gui");
    const failure = journal.events.find((entry) => entry.event === "question.error");
    assert.ok(failure);
    assert.equal(failure.detail.status, 500);
    assert.equal(failure.detail.code, "internal");
  });

  test("051: неизвестный shortId/optionId — answer.unmatched", async () => {
    const journal = fakeJournal();
    const transport = fakeTransport();
    const answerer = createAnswerer({
      transport,
      registry: createRegistry({ readState: () => ({ global: true }) }),
      journal,
      log: () => {},
    });
    answerer.attach({ on: () => () => {}, get: () => null, effect: (fn) => { const d = fn(); return () => d?.(); } });

    const pending = answerer.handler({
      questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }],
      agent: { id: "s1" },
    }, () => assert.fail("next()"));
    await new Promise((resolve) => setImmediate(resolve));

    transport.answer({ shortId: "deadbeef", optionId: "o1" });
    transport.answer({ shortId: transport.sent[0].shortId, optionId: "o9" });
    const unmatched = journal.events.filter((entry) => entry.event === "answer.unmatched");
    assert.equal(unmatched.length, 2);
    assert.equal(unmatched[0].detail.reason, "shortId");
    assert.equal(unmatched[1].detail.reason, "optionId");

    transport.answer({ shortId: transport.sent[0].shortId, optionId: "o1" });
    await pending;
  });
}

test("051: фича journal публикует сервис, logFile:false выключает", async () => {
  const { journalFeature } = await import("../lib/features/journal.js");
  const provided = new Map();
  const ctx = { provide: (name, service) => provided.set(name, service) };
  const deps = { logger: { debug: () => {}, warn: () => {} }, get: () => null };

  const exposed = new Map();
  const exposingDeps = { ...deps, expose: (name, service) => exposed.set(name, service) };
  journalFeature.apply(ctx, { logFile: false }, exposingDeps);
  assert.equal(exposed.get("remoteJournal"), provided.get("remoteJournal"), "056: сервис в общем реестре");
  const disabled = provided.get("remoteJournal");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.record("question.send"), false);

  const dir = tempDir({ after: () => {} });
  journalFeature.apply({ provide: (name, service) => provided.set(name, service) }, { logFile: path.join(dir, "custom.jsonl") }, exposingDeps);
  const enabled = provided.get("remoteJournal");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.record("question.sent", { transport: "max" }), true);
  assert.equal(fs.existsSync(path.join(dir, "custom.jsonl")), true);
});


/** 056: мини-каркас фич: общий реестр (`expose/get`) + ctx (`provide/get`). */
function featureStand(t, file, { hideJournalFromDeps = false } = {}) {
  const shared = new Map();
  const provided = new Map();
  const handlers = new Set();
  const services = {
    sessions: { get: () => null },
    remoteTransports: new Map(),
  };
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const ctx = {
    logger,
    get(name) {
      return provided.get(name) ?? services[name] ?? null;
    },
    provide(name, value) {
      provided.set(name, value);
    },
    on(event, handler) {
      if (event === "user-questions/request") handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  const sent = [];
  const transport = {
    id: "max",
    caps: { inlineButtons: true, maxText: 4000, maxOptions: 8 },
    async sendQuestion(question) {
      sent.push(question);
      return { messageId: "m-1" };
    },
    async closeQuestion() {},
    onAnswer() {
      return () => {};
    },
  };
  services.remoteTransport = transport;
  services.remoteStore = {
    read: () => ({ enabled: { global: true }, bindings: null }),
    paths: { dir: path.dirname(file) },
  };
  const deps = {
    logger,
    expose: (name, value) => shared.set(name, value),
    get: (name) => (hideJournalFromDeps && name === "remoteJournal"
      ? null
      : shared.get(name) ?? ctx.get(name)),
    onDispose: () => {},
  };
  return { ctx, deps, handlers, sent, shared, provided, transport };
}

async function runFeatureQuestion(stand) {
  const { journalFeature } = await import("../lib/features/journal.js");
  const { answererFeature } = await import("../lib/features/answerer.js");
  journalFeature.apply(stand.ctx, { logFile: stand.file }, stand.deps);
  answererFeature.apply(stand.ctx, {}, stand.deps);
  const handler = [...stand.handlers][0];
  assert.equal(typeof handler, "function", "ответчик подписан каркасом");
  const controller = new AbortController();
  const pending = handler({
    questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }],
    agent: { id: "s1" },
    signal: controller.signal,
  }, () => assert.fail("next() не должен вызываться"));
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await pending.catch(() => {});
  return stand;
}

test("056: каркас journalFeature → deps → answerer пишет question.send в файл", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const stand = featureStand(t, file);
  stand.file = file;

  await runFeatureQuestion(stand);

  const entries = lines(file);
  const names = entries.map((entry) => entry.event);
  assert.deepEqual(names, ["question.send", "question.sent"], "обе записи через общий реестр");
  assert.equal(entries[0].transport, "max");
  assert.equal(JSON.parse(entries[1].detail).messageId, "m-1");
});

test("056: answerer берёт журнал через ctx.get, если deps.get вернул null", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const stand = featureStand(t, file, { hideJournalFromDeps: true });
  stand.file = file;

  await runFeatureQuestion(stand);

  const names = lines(file).map((entry) => entry.event);
  assert.deepEqual(names, ["question.send", "question.sent"], "страховочный путь ctx.get");
});

test("056: сервис, видимый обоими путями, не даёт двойной записи", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const stand = featureStand(t, file);
  stand.file = file;

  await runFeatureQuestion(stand);

  const names = lines(file).map((entry) => entry.event);
  assert.equal(names.filter((name) => name === "question.send").length, 1, "question.send один раз");
  assert.equal(names.filter((name) => name === "question.sent").length, 1, "question.sent один раз");
});

function createStoreForStatus(dir) {
  return createStore({ file: path.join(dir, "state.json") });
}

function createRemoteCommandsForStatus({ journal, store }) {
  return createRemoteCommands({
    ctx: { get: (name) => (name === "remoteJournal" ? journal : null) },
    store,
    log: () => {},
    now: () => 1_000,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: true }) }),
  });
}

test("056: /remote status показывает путь журнала без падения", async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, "log.jsonl");
  const { createJournal } = await import("../lib/journal.js");
  const journal = createJournal({ file });
  const store = createStoreForStatus(dir);
  const remote = createRemoteCommandsForStatus({ journal, store });
  const result = await remote.handler({
    commandId: "status-1",
    agent: { id: "s1", session: { id: "s1" } },
    rawInput: "status",
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, "success");
  assert.match(result.text, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});


test("056: doctor показывает журнал и предупреждает о выключенном", async () => {
  const enabled = await runHealthChecks({ journal: { file: "/tmp/log.jsonl", enabled: true } });
  const journalCheck = enabled.find((check) => check.id === "journal");
  assert.ok(journalCheck, "проверка журнала есть");
  assert.equal(journalCheck.status, "ok");
  assert.match(journalCheck.detail, /log\.jsonl/);

  const disabled = await runHealthChecks({ journal: { file: "/tmp/log.jsonl", enabled: false } });
  assert.equal(disabled.find((check) => check.id === "journal").status, "warn");
});
