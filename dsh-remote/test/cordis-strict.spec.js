/**
 * Регрессия: плагин живёт в cordis, а он бросает на прямом доступе к сервису,
 * которого нет в `inject`.
 *
 * Настоящий сбой (живой запуск 2026-11-11): фича `commands` падала с
 * `cannot get property "commands" without inject`, потому что читала `ctx.commands`
 * напрямую. Фиктивный `ctx` из остальных тестов — обычный объект, он такое
 * пропускал. Здесь контекст строгий: свойства сервисов бросают, а `get` возвращает
 * `null` — как в cordis.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { apply } from "../lib/index.js";
import { serviceOf } from "../lib/commands.js";

/** Сервисы, доступ к которым cordis запрещает без `inject`. */
const GUARDED = new Set([
  "commands",
  "sessions",
  "credentials",
  "userQuestions",
  "sessionController",
  "agents",
  "agentPresets",
]);

/** Контекст, ведущий себя как cordis: сервисы — только через `get`. */
function strictCtx(services = {}) {
  const provided = new Map();
  const target = {
    get(name) {
      return services[name] ?? provided.get(name) ?? null;
    },
    provide(name, value) {
      provided.set(name, value);
    },
    on() {
      return () => {};
    },
    effect() {
      return () => {};
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    provided,
  };
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "string" && GUARDED.has(prop) && !(prop in obj)) {
        throw new Error(`cannot get property "${prop}" without inject`);
      }
      return Reflect.get(obj, prop, receiver);
    },
  });
}

test("serviceOf не бросает на сервисе без inject", () => {
  const ctx = strictCtx();
  assert.equal(serviceOf(ctx, "commands"), null, "нет сервиса — null, а не исключение");
  assert.equal(serviceOf({}, "commands"), null, "ctx без get — тоже null");
});

test("apply поднимается на строгом ctx: commands регистрируется через ctx.get", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-remote-strict-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const registered = [];
    const ctx = strictCtx({
      commands: {
        register(definition) {
          registered.push(definition?.name);
          return () => {};
        },
      },
    });

    await apply(ctx, {});

    const trace = fs.readFileSync(path.join(dir, "remote-control", "boot.log"), "utf8");
    assert.ok(
      /commands:ok/.test(trace),
      `фича commands должна подняться, а не упасть. Лог:\n${trace}`,
    );
    assert.deepEqual(registered, ["remote"], "команда /remote зарегистрирована");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
