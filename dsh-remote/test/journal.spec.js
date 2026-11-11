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
import { createRegistry } from "../lib/domain/registry.js";

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

  journalFeature.apply(ctx, { logFile: false }, deps);
  const disabled = provided.get("remoteJournal");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.record("question.send"), false);

  const dir = tempDir({ after: () => {} });
  journalFeature.apply({ provide: (name, service) => provided.set(name, service) }, { logFile: path.join(dir, "custom.jsonl") }, deps);
  const enabled = provided.get("remoteJournal");
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.record("question.sent", { transport: "max" }), true);
  assert.equal(fs.existsSync(path.join(dir, "custom.jsonl")), true);
});
