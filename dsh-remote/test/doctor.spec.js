/**
 * Тесты `/remote doctor`: форматирование отчёта и проверки на фейковых
 * сервисах. Без сети и без реального профиля.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatDoctorReport, readPluginVersion, runDoctorChecks } from "../lib/commands.js";

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-doctor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Состояние с привязкой, права 600. */
function writeState(t, { binding = true, perms = 0o600, raw = null } = {}) {
  const dir = tempDir(t);
  const file = path.join(dir, "state.json");
  const content = raw ?? JSON.stringify({
    version: 1,
    bindings: binding ? { transport: "telegram", chatId: 42, userId: 7, botUsername: "test_bot", createdAt: 1 } : null,
    enabled: { global: false, workspaces: {}, sessions: {} },
  });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, perms);
  return file;
}

function fakeServices(t, overrides = {}) {
  const file = overrides.stateFile ?? writeState(t, overrides.state);
  return {
    store: {
      paths: { file, dir: path.dirname(file), lock: path.join(path.dirname(file), "lock") },
      lockState: () => overrides.lock ?? { held: false, holder: null, mine: false },
    },
    credentials: "credentials" in overrides ? overrides.credentials : {
      availableFor: () => true,
      resolve: async () => "123456:TEST-TOKEN",
      describe: async () => ({ source: "file", writable: true }),
    },
    transport: "transport" in overrides ? overrides.transport : { lastUpdateId: 5, lastError: null },
    telegramCallImpl: overrides.telegramCallImpl ?? (async () => ({ result: { username: "test_bot" } })),
    version: overrides.version ?? "0.1.0",
  };
}

test("formatDoctorReport: все ok — короткий итог «всё в порядке»", () => {
  const text = formatDoctorReport([
    { level: "ok", title: "плагин", detail: "dsh-remote 0.1.0" },
    { level: "ok", title: "канал", detail: "транспорт поднят" },
  ]);

  assert.match(text, /\[ok\] плагин: dsh-remote 0\.1\.0/);
  assert.match(text, /всё в порядке$/);
  assert.doesNotMatch(text, /fail/);
});

test("formatDoctorReport: есть fail — итог просит сделать шаги и печатает подсказку", () => {
  const text = formatDoctorReport([
    { level: "fail", title: "токен", detail: "нет ссылки", hint: "выполните /remote connect" },
    { level: "warn", title: "канал", detail: "транспорт не поднят" },
  ]);

  assert.match(text, /\[fail\] токен: нет ссылки/);
  assert.match(text, /→ выполните \/remote connect/);
  assert.match(text, /есть проблемы: 1 fail, 1 warn/);
});

test("runDoctorChecks: здоровый плагин — ни одного fail", async (t) => {
  const checks = await runDoctorChecks(fakeServices(t));

  assert.equal(checks.some((check) => check.level === "fail"), false, JSON.stringify(checks));
  const token = checks.find((check) => check.title === "токен");
  assert.match(token.detail, /источник: file/);
  const getMe = checks.find((check) => check.title === "getMe");
  assert.match(getMe.detail, /@test_bot/);
  const rights = checks.find((check) => check.title === "права");
  assert.match(rights.detail, /600/);
});

test("runDoctorChecks: нет ctx.credentials — fail с подсказкой", async (t) => {
  const checks = await runDoctorChecks(fakeServices(t, { credentials: null }));

  const token = checks.find((check) => check.title === "токен");
  assert.equal(token.level, "fail");
  assert.match(token.hint, /секрет/);
  assert.match(formatDoctorReport(checks), /есть проблемы/);
});

test("runDoctorChecks: getMe упал — fail, текст без токена", async (t) => {
  const checks = await runDoctorChecks(fakeServices(t, {
    telegramCallImpl: async () => {
      throw new Error("Unauthorized 401 с токеном 123456:TEST-TOKEN");
    },
  }));

  const getMe = checks.find((check) => check.title === "getMe");
  assert.equal(getMe.level, "fail");
  assert.equal(getMe.detail.includes("TEST-TOKEN"), false, "токен в отчёте не печатается");
  assert.match(getMe.hint, /@BotFather/);
});

test("runDoctorChecks: чужой lock — warn про 409", async (t) => {
  const checks = await runDoctorChecks(fakeServices(t, {
    lock: { held: true, holder: { pid: 999_999 }, mine: false },
  }));

  const pollers = checks.find((check) => check.title === "поллеры");
  assert.equal(pollers.level, "warn");
  assert.match(pollers.hint, /409/);
});

test("runDoctorChecks: свой lock — ok", async (t) => {
  const checks = await runDoctorChecks(fakeServices(t, {
    lock: { held: true, holder: { pid: process.pid }, mine: true },
  }));

  assert.equal(checks.find((check) => check.title === "поллеры").level, "ok");
});

test("runDoctorChecks: нет транспорта — warn, есть ошибка канала — warn", async (t) => {
  const withoutChannel = await runDoctorChecks(fakeServices(t, { transport: null }));
  assert.equal(withoutChannel.find((check) => check.title === "канал").level, "warn");

  const withError = await runDoctorChecks(fakeServices(t, {
    transport: { lastUpdateId: -1, lastError: new Error("409 Conflict") },
  }));
  const channel = withError.find((check) => check.title === "канал");
  assert.equal(channel.level, "warn");
  assert.match(channel.detail, /409 Conflict/);
});

test("runDoctorChecks: битый state.json — fail, свободные права — warn", async (t) => {
  const broken = await runDoctorChecks(fakeServices(t, { stateFile: writeState(t, { raw: "{не json" }) }));
  assert.equal(broken.find((check) => check.title === "состояние").level, "fail");

  const loose = await runDoctorChecks(fakeServices(t, {
    stateFile: writeState(t, { perms: 0o644 }),
  }));
  const rights = loose.find((check) => check.title === "права");
  assert.equal(rights.level, "warn");
  assert.match(rights.hint, /chmod 600/);
});

test("runDoctorChecks: файла состояния ещё нет — warn, а не fail", async (t) => {
  const dir = tempDir(t);
  const checks = await runDoctorChecks(fakeServices(t, { stateFile: path.join(dir, "nope.json") }));

  const state = checks.find((check) => check.title === "состояние");
  assert.equal(state.level, "warn");
  assert.match(state.detail, /ещё нет/);
});

test("readPluginVersion: версия читается из package.json плагина", () => {
  assert.match(readPluginVersion(), /^\d+\.\d+\.\d+/);
});

test("runDoctorChecks: битый JSON и права 644 — обе проблемы видны", async (t) => {
  const file = writeState(t, { raw: "{не json", perms: 0o644 });
  const checks = await runDoctorChecks(fakeServices(t, { stateFile: file }));

  assert.equal(checks.find((check) => check.title === "состояние").level, "fail");
  const rights = checks.find((check) => check.title === "права");
  assert.equal(rights.level, "warn", "права проверяются независимо от парсинга");
  assert.match(rights.detail, /644/);
});
