/**
 * 066: журнал не путает транспорт и не дублирует ответы.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createTransportFacade } from "../lib/features/commands.js";
import { answererFeature } from "../lib/features/answerer.js";
import { createFakeTransport } from "../lib/transport/fake.js";

function fakeJournal() {
  const events = [];
  return { events, record: (event, fields = {}) => { events.push({ event, ...fields }); return true; } };
}

function stand({ binding = "max" } = {}) {
  const transport = createFakeTransport({ now: () => 1000 });
  transport.id = "max";
  const facade = createTransportFacade();
  facade.set(transport);
  const journal = fakeJournal();
  let handler = null;
  const services = new Map([
    ["remoteTransport", facade],
    ["remoteTransports", new Map([["max", transport]])],
    ["remoteJournal", journal],
    ["remoteStore", {
      read: () => ({
        enabled: { global: true },
        bindings: { transport: binding },
        hybrid: { enabled: false },
      }),
    }],
  ]);
  const ctx = {
    get: (name) => services.get(name) ?? null,
    provide: (name, value) => { services.set(name, value); return value; },
    on: (event, callback) => {
      if (event === "user-questions/request") handler = callback;
      return () => {};
    },
    effect: (execute) => execute(),
  };
  const deps = {
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    get: (name) => services.get(name) ?? null,
    onDispose: () => {},
  };
  answererFeature.apply(ctx, {}, deps);
  return { transport, facade, journal, handler: () => handler };
}

test("066: id фасада — реальный транспорт, а не telegram", () => {
  const transport = createFakeTransport({ now: () => 0 });
  transport.id = "max";
  const facade = createTransportFacade();
  assert.equal(facade.id, "facade", "пустой фасад");
  facade.set(transport);
  assert.equal(facade.id, "max");
  facade.clear();
  assert.equal(facade.id, "facade");
});

test("066: один ответ — одно answer.received с реальным id, без telegram", async () => {
  const fixture = stand({ binding: "max" });
  const handler = fixture.handler();
  assert.equal(typeof handler, "function");

  const pending = handler({
    agent: { id: "s1" },
    questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }],
  }, () => new Promise(() => {}));
  await new Promise((resolve) => setImmediate(resolve));
  const shortId = fixture.transport.messages[0].shortId;
  fixture.transport.answer(shortId, "o1");
  await pending;

  const received = fixture.journal.events.filter((entry) => entry.event === "answer.received");
  assert.equal(received.length, 1, "ответ обработан ровно один раз");
  assert.equal(received[0].transport, "max");
  assert.equal(fixture.journal.events.some((entry) => entry.transport === "telegram"), false);
  assert.equal(fixture.journal.events.some((entry) => entry.event === "answer.unmatched"), false);
});

test("066: повтор того же события — answer.duplicate, не unmatched", async () => {
  const fixture = stand({ binding: "max" });
  const handler = fixture.handler();
  const pending = handler({
    agent: { id: "s1" },
    questions: [{ id: "q1", question: "Продолжать?", options: [{ label: "Да" }] }],
  }, () => new Promise(() => {}));
  await new Promise((resolve) => setImmediate(resolve));
  const shortId = fixture.transport.messages[0].shortId;
  fixture.transport.answer(shortId, "o1");
  await pending;
  fixture.transport.answer(shortId, "o1");

  assert.equal(fixture.journal.events.filter((entry) => entry.event === "answer.received").length, 1, "одно received");
  const duplicate = fixture.journal.events.find((entry) => entry.event === "answer.duplicate");
  assert.ok(duplicate, "duplicate записан");
  assert.equal(duplicate.detail.reason, "duplicate");
  assert.equal(fixture.journal.events.some((entry) => entry.event === "answer.unmatched"), false);
});
