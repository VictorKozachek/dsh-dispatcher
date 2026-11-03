/**
 * Doctor 2.0 (030): health-модель, JSON и код возврата.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EXIT_CODES,
  buildReport,
  createCheck,
  exitCodeFor,
  formatHealthReport,
  fromLegacyChecks,
  runHealthChecks,
  serializeReport,
  worstStatus,
} from "../lib/doctor.js";
import { createStore } from "../lib/store.js";
import { createRemoteCommands } from "../lib/commands.js";

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-doctor2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return createStore({ file: path.join(dir, "state.json") });
}

function fakeCredentials({ present = true, writable = true, source = present ? "file" : null, onDescribe } = {}) {
  return {
    available: true,
    availableFor: () => true,
    resolve: async () => "secret-token-value",
    set: async () => true,
    describe: async (ref) => {
      if (typeof onDescribe === "function") return onDescribe(ref);
      return { present, configured: present, writable, source };
    },
  };
}

const TOKEN = "123456:DOCTOR-SECRET-TOKEN";

// --- модель -----------------------------------------------------------------

test("createCheck: fail требует action, статусы валидируются", () => {
  assert.throws(() => createCheck({ id: "x", status: "fail", detail: "нет связи" }), /без action/);
  assert.throws(() => createCheck({ id: "x", status: "broken" }), /неизвестный статус/);
  assert.throws(() => createCheck({ status: "ok" }), /нет id/);
  assert.deepEqual(createCheck({ id: "x", status: "warn", detail: "d" }), { id: "x", status: "warn", detail: "d" });
});

test("worstStatus/exitCodeFor: код = худший статус", () => {
  assert.equal(worstStatus([{ status: "ok" }, { status: "ok" }]), "ok");
  assert.equal(worstStatus([{ status: "ok" }, { status: "warn" }]), "warn");
  assert.equal(worstStatus([{ status: "warn" }, { status: "fail" }]), "fail");
  assert.equal(EXIT_CODES.ok, 0);
  assert.equal(EXIT_CODES.warn, 1);
  assert.equal(EXIT_CODES.fail, 2);
  assert.equal(exitCodeFor("ok"), 0);
  assert.equal(exitCodeFor("warn"), 1);
  assert.equal(exitCodeFor("fail"), 2);
});

test("serializeReport: стабильная структура JSON", () => {
  const report = buildReport([
    createCheck({ id: "a", status: "ok", detail: "норм" }),
    createCheck({ id: "b", status: "fail", detail: "сломано", action: "почини" }),
  ]);
  const parsed = JSON.parse(serializeReport(report));

  assert.deepEqual(Object.keys(parsed), ["status", "exitCode", "checks"]);
  assert.equal(parsed.status, "fail");
  assert.equal(parsed.exitCode, 2);
  assert.deepEqual(parsed.checks[1], { id: "b", status: "fail", detail: "сломано", action: "почини" });
  assert.equal("action" in parsed.checks[0], false, "нет пустого action");
  assert.equal(JSON.parse(serializeReport(report)).status, "fail", "повторный вызов стабилен");
});

test("fromLegacyChecks: старые заголовки узнаваемы, hint превращается в action", () => {
  const checks = fromLegacyChecks([
    { level: "ok", title: "токен", detail: "найден" },
    { level: "fail", title: "канал", detail: "нет", hint: "привяжите бота" },
  ]);
  assert.equal(checks[0].id, "token");
  assert.match(checks[0].detail, /токен: найден/);
  assert.equal(checks[1].id, "channel");
  assert.equal(checks[1].action, "привяжите бота");
});

// --- проверки в трёх состояниях ---------------------------------------------

test("credentials: ok (writable), warn (readonly), fail (нет секрета)", async () => {
  const ok = await runHealthChecks({ credentials: fakeCredentials(), tokenRefs: ["A"] });
  const okCheck = ok.find((check) => check.id === "credentials:A");
  assert.equal(okCheck.status, "ok");
  assert.match(okCheck.detail, /источник: file/);

  const readonly = await runHealthChecks({ credentials: fakeCredentials({ writable: false }), tokenRefs: ["A"] });
  const warnCheck = readonly.find((check) => check.id === "credentials:A");
  assert.equal(warnCheck.status, "warn");
  assert.match(warnCheck.action, /только для чтения/);

  const missing = await runHealthChecks({ credentials: fakeCredentials({ present: false }), tokenRefs: ["A"] });
  const failCheck = missing.find((check) => check.id === "credentials:A");
  assert.equal(failCheck.status, "fail");
  assert.match(failCheck.action, /задайте секрет/);

  const env = await runHealthChecks({ credentials: fakeCredentials({ source: "env" }), tokenRefs: ["A"] });
  assert.match(env.find((check) => check.id === "credentials:A").detail, /приоритет env/);

  const none = await runHealthChecks({ credentials: null });
  assert.equal(none.find((check) => check.id === "credentials").status, "warn");
});

test("relay: ok (healthz), fail (нет связи), не настроен — пропуск", async () => {
  const healthy = await runHealthChecks({
    relay: {
      url: "https://relay.test",
      transport: {
        async healthCheck() { return { ok: true, detail: "relay 0.1.0" }; },
        pending: 2,
        stats: { wsState: "open", reconnectAttempts: 1 },
      },
    },
  });
  const relayOk = healthy.find((check) => check.id === "relay");
  assert.equal(relayOk.status, "ok");
  assert.match(relayOk.detail, /на связи/);
  assert.match(relayOk.detail, /WS: open/);
  assert.match(relayOk.detail, /переподключений: 1/);
  assert.match(relayOk.detail, /ждёт ответа: 2/);

  const down = await runHealthChecks({
    relay: { url: "https://relay.test", transport: { async healthCheck() { return { ok: false, detail: "401" }; } } },
  });
  const relayFail = down.find((check) => check.id === "relay");
  assert.equal(relayFail.status, "fail");
  assert.match(relayFail.action, /URL\/токен/);

  const absent = await runHealthChecks({ relay: null });
  assert.equal(absent.find((check) => check.id === "relay").status, "ok");
});

test("schema: ok, warn (новее плагина), warn (не прочитана)", async (t) => {
  const fresh = tempStore(t);
  const ok = await runHealthChecks({ store: fresh, supportedSchemaVersion: 1 });
  assert.equal(ok.find((check) => check.id === "schema").status, "ok");

  const newer = {
    read: () => ({ version: 99 }),
  };
  const warn = await runHealthChecks({ store: newer, supportedSchemaVersion: 1 });
  const schemaWarn = warn.find((check) => check.id === "schema");
  assert.equal(schemaWarn.status, "warn");
  assert.match(schemaWarn.action, /обновите плагин/);

  const broken = { read: () => { throw new Error("битый state"); } };
  const unreadable = await runHealthChecks({ store: broken, supportedSchemaVersion: 1 });
  assert.equal(unreadable.find((check) => check.id === "schema").status, "warn");
});

test("timers: ok (healthy), warn (канал не в порядке), fail (healthCheck бросил), 031 нет — пропуск", async () => {
  const healthy = await runHealthChecks({
    reliability: { async healthCheck() { return { ok: true, watching: 2, pending: 0 }; } },
  });
  const timersOk = healthy.find((check) => check.id === "timers");
  assert.equal(timersOk.status, "ok");
  assert.match(timersOk.detail, /активных 2/);

  const degraded = await runHealthChecks({
    reliability: { async healthCheck() { return { ok: false, watching: 1, pending: 1 }; } },
  });
  const timersWarn = degraded.find((check) => check.id === "timers");
  assert.equal(timersWarn.status, "warn");
  assert.match(timersWarn.action, /\/remote status/);

  const broken = await runHealthChecks({
    reliability: { async healthCheck() { throw new Error("state сломан"); } },
  });
  const timersFail = broken.find((check) => check.id === "timers");
  assert.equal(timersFail.status, "fail");
  assert.match(timersFail.action, /журнал/);

  const absent = await runHealthChecks({ reliability: null });
  const timersSkip = absent.find((check) => check.id === "timers");
  assert.equal(timersSkip.status, "ok");
  assert.match(timersSkip.detail, /031/);
});

test("каждая fail-проверка содержит action", async () => {
  const checks = await runHealthChecks({
    credentials: fakeCredentials({ present: false }),
    tokenRefs: ["broken"],
    relay: { url: "r", transport: { async healthCheck() { return { ok: false, detail: "нет" }; } } },
    reliability: { async healthCheck() { throw new Error("сбой"); } },
    supportedSchemaVersion: null,
  });
  for (const check of checks.filter((item) => item.status === "fail")) {
    assert.equal(typeof check.action, "string", `${check.id} без action`);
    assert.notEqual(check.action, "");
  }
});

// --- команда ----------------------------------------------------------------

function harness(t, { json = false, credentials: providedCredentials = null } = {}) {
  const store = tempStore(t);
  store.setBinding({ transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot" });
  const credentials = providedCredentials ?? fakeCredentials();
  const reliability = { healthCheck: async () => ({ ok: true, watching: 0, pending: 0 }) };
  const ctx = {
    get: (name) => {
      if (name === "credentials") return credentials;
      if (name === "remoteReliability") return reliability;
      if (name === "remoteTransport") return { id: "telegram", lastUpdateId: 5, lastError: null };
      return null;
    },
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
    now: () => 1_700_000_000_000,
    fetch: async () => ({ ok: true, status: 200, async json() { return { ok: true, result: { username: "test_bot" } }; } }),
  });
  return { store, remote, ctx, invoke: (rawInput) => ({
    commandId: "c1",
    agent: { id: "s1", session: { id: "s1" } },
    rawInput,
    signal: new AbortController().signal,
  }) };
}

test("/remote doctor --json: парсится, статус и код возврата на месте, секретов нет", async (t) => {
  const stand = harness(t);
  const result = await stand.remote.handler(stand.invoke("doctor --json"));

  assert.equal(result.kind, "success");
  const report = JSON.parse(result.text);
  assert.deepEqual(Object.keys(report), ["status", "exitCode", "checks"]);
  assert.ok(["ok", "warn", "fail"].includes(report.status));
  assert.equal(report.exitCode, exitCodes()[report.status]);
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 5);
  for (const check of report.checks) {
    assert.equal(typeof check.id, "string");
    assert.ok(["ok", "warn", "fail"].includes(check.status));
    if (check.status === "fail") assert.ok(check.action, `${check.id} без action`);
  }
  assert.equal(result.text.includes(TOKEN), false, "токен не попал в вывод");
  assert.equal(result.text.includes("secret-token-value"), false);
});

function exitCodes() {
  return { ok: 0, warn: 1, fail: 2 };
}

test("/remote doctor: человеческий вывод узнаваем, итог и код печатаются", async (t) => {
  const stand = harness(t);
  const result = await stand.remote.handler(stand.invoke("doctor"));

  assert.equal(result.kind, "success");
  assert.match(result.text, /\[ok\] plugin: плагин:/, "legacy-строка плагина узнаваема");
  assert.match(result.text, /\[ok\] token: токен:/);
  assert.match(result.text, /\[ok\] lock: поллеры:/);
  assert.match(result.text, /\[ok\] relay:/);
  assert.match(result.text, /(код 0|код 1|код 2)/);
});

test("/remote doctor: код возврата 2 при fail (нет секрета)", async (t) => {
  const stand = harness(t, { credentials: fakeCredentials({ present: false }) });

  const result = await stand.remote.handler(stand.invoke("doctor --json"));

  const report = JSON.parse(result.text);
  assert.equal(report.status, "fail");
  assert.equal(report.exitCode, 2);
  const failed = report.checks.filter((check) => check.status === "fail");
  assert.ok(failed.length > 0);
  for (const check of failed) assert.ok(check.action);
});
