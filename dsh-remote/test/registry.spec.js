/**
 * Тесты реестра режима: приоритет «сессия → воркспейс → глобально».
 *
 * Источник состояния инжектируется, поэтому проверяются все ветки без файлов и
 * без DSH: пусто, отдельные уровни, перекрытие уровней и битый источник.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createRegistry } from "../lib/domain/registry.js";

test("пустое состояние — режим выключен, scope нет", () => {
  const registry = createRegistry({ readState: () => ({}) });
  assert.deepEqual(registry.resolve({ sessionId: "s1", workspace: "/p" }), { enabled: false, scope: null });
  assert.equal(registry.enabled({ sessionId: "s1", workspace: "/p" }), false);
});

test("глобальная настройка включает режим", () => {
  const registry = createRegistry({ readState: () => ({ global: true }) });
  assert.deepEqual(registry.resolve({ sessionId: "s1", workspace: "/p" }), { enabled: true, scope: "global" });
});

test("воркспейс главнее глобальной настройки", () => {
  const registry = createRegistry({
    readState: () => ({ global: true, workspaces: { "/p": false } }),
  });
  assert.deepEqual(registry.resolve({ workspace: "/p" }), { enabled: false, scope: "workspace" });
  assert.deepEqual(registry.resolve({ workspace: "/other" }), { enabled: true, scope: "global" });
});

test("сессия главнее воркспейса и глобальной настройки", () => {
  const registry = createRegistry({
    readState: () => ({ global: false, workspaces: { "/p": false }, sessions: { s1: true } }),
  });
  assert.deepEqual(registry.resolve({ sessionId: "s1", workspace: "/p" }), { enabled: true, scope: "session" });
  assert.deepEqual(registry.resolve({ sessionId: "s2", workspace: "/p" }), { enabled: false, scope: "workspace" });
});

test("путь воркспейса сравнивается без хвостового разделителя", () => {
  const registry = createRegistry({ readState: () => ({ workspaces: { "/p/": true } }) });
  assert.deepEqual(registry.resolve({ workspace: "/p" }), { enabled: true, scope: "workspace" });
});

test("нет сессии и воркспейса — работает глобальная настройка", () => {
  const registry = createRegistry({ readState: () => ({ global: true }) });
  assert.equal(registry.enabled({}), true);
});

test("небулевы значения настроек игнорируются", () => {
  const registry = createRegistry({
    readState: () => ({ global: "yes", workspaces: { "/p": 1 }, sessions: { s1: null } }),
  });
  assert.deepEqual(registry.resolve({ sessionId: "s1", workspace: "/p" }), { enabled: false, scope: null });
});

test("битый источник состояния — режим выключен, без исключения", () => {
  const logs = [];
  const registry = createRegistry({
    readState: () => {
      throw new Error("state.json битый");
    },
    log: (message) => logs.push(message),
  });
  assert.deepEqual(registry.resolve({ sessionId: "s1" }), { enabled: false, scope: null });
  assert.match(logs.join("\n"), /state\.json битый/);
});

test("нет источника вовсе — режим выключен", () => {
  const registry = createRegistry();
  assert.equal(registry.enabled({ sessionId: "s1", workspace: "/p" }), false);
});
