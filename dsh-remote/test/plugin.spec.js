/**
 * Тесты каркаса `dsh-remote` (задача 001).
 *
 * Что проверяем: пакет импортируется, `apply` поднимается на фейковом `ctx` без
 * сервисов и не бросает (деградирует в warn), реестр фич пуст, `cordis.patch.yml`
 * содержит ровно один ряд `ui-remote`, а `package.json` описывает пакет так, как
 * ждёт загрузчик профиля (`dsh.bundle.patch`, `exports`).
 *
 * Сервисов и сети здесь нет: фейковый контекст — объект с `get`, `on`, `logger`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { apply, inject, name } from "../lib/index.js";
import { features } from "../lib/features.js";

/** Корень пакета `dsh-remote`: этот файл лежит в `dsh-remote/test/`. */
const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const LEVELS = ["debug", "info", "warn", "error"];

/**
 * Фейковый `ctx` в объёме, который нужен каркасу: `get`, `on`, `logger`.
 *
 * `services` — что отдаёт `get`; `loggerShape` — каким бывает логгер у cordis
 * (функция `ctx.logger(name)`, готовый объект, отсутствие, сломанный);
 * `getThrows`/`onThrows` — проверка того, что каркас не падает на чужой поломке.
 */
function fakeCtx({ services = {}, loggerShape = "function", getThrows = false, onThrows = false } = {}) {
  const calls = [];
  const scopes = [];
  const handlers = [];
  const record = (level) => (message) => calls.push({ level, message: String(message) });
  const build = () => Object.fromEntries(LEVELS.map((level) => [level, record(level)]));

  let logger;
  if (loggerShape === "none") logger = undefined;
  else if (loggerShape === "object") logger = build();
  else if (loggerShape === "throwing") {
    logger = () => {
      throw new Error("logger сломан");
    };
  } else {
    logger = (scope) => {
      scopes.push(scope);
      return build();
    };
  }

  const ctx = {
    get(service) {
      if (getThrows) throw new Error("get сломан");
      return Object.hasOwn(services, service) ? services[service] : undefined;
    },
    on(event, handler) {
      if (onThrows) throw new Error("on сломан");
      handlers.push({ event, handler });
    },
    logger,
  };
  return { ctx, calls, scopes, handlers };
}

/** Сообщения заданного уровня из записанных вызовов логгера. */
const messages = (calls, level) => calls.filter((call) => call.level === level).map((call) => call.message);

/** Непустые строки файла без комментариев: так проверяется структура yml. */
function significantLines(text) {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("#");
    })
    .map((line) => line.trim());
}

/** Временная фича в реестре: тест не должен оставлять реестр изменённым. */
function withFeatures(extra, run) {
  features.push(...extra);
  try {
    return run();
  } finally {
    features.splice(features.length - extra.length, extra.length);
  }
}

test("каркас: имя плагина, пустой inject и пустой реестр фич", () => {
  assert.equal(name, "dsh-remote");
  assert.deepEqual(inject, []);
  assert.deepEqual(features, []);
});

test("apply поднимается на пустом ctx без сервисов и не бросает", () => {
  const { ctx, calls, scopes, handlers } = fakeCtx();
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(scopes[0], "dsh-remote", "логгер создаётся со scope [dsh-remote]");
  assert.deepEqual(messages(calls, "error"), []);
  assert.match(messages(calls, "info").join("\n"), /каркас поднят/);
  assert.deepEqual(handlers.map((item) => item.event), ["dispose"]);
});

test("apply не падает на ctx без logger, get и on", () => {
  assert.doesNotThrow(() => apply({}, {}));
  assert.doesNotThrow(() => apply(undefined, undefined));
});

test("apply не падает, когда ctx.get, ctx.on и ctx.logger сами бросают", () => {
  const { ctx } = fakeCtx({ loggerShape: "throwing" });
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.doesNotThrow(() => apply(fakeCtx({ getThrows: true }).ctx, {}));
  assert.doesNotThrow(() => apply(fakeCtx({ onThrows: true }).ctx, {}));
  assert.doesNotThrow(() => apply(fakeCtx({ loggerShape: "object" }).ctx, {}));
});

test("config не объект: warn вместо падения", () => {
  const { ctx, calls } = fakeCtx();
  assert.doesNotThrow(() => apply(ctx, "строка"));
  assert.match(messages(calls, "warn").join("\n"), /config/);
});

test("фича без своего сервиса пропускается с warn, остальные запускаются", () => {
  const { ctx, calls } = fakeCtx();
  const called = [];
  const withoutService = {
    name: "нуждается-в-сервисе",
    needs: ["userQuestions"],
    apply: () => called.push("нуждается"),
  };
  const plain = { name: "обычная", apply: () => called.push("обычная") };

  withFeatures([withoutService, plain], () => apply(ctx, {}));

  assert.deepEqual(called, ["обычная"]);
  const warn = messages(calls, "warn").join("\n");
  assert.match(warn, /нуждается-в-сервисе/);
  assert.match(warn, /userQuestions/);
});

test("фича с сервисом из ctx запускается", () => {
  const { ctx } = fakeCtx({ services: { userQuestions: { ask: () => {} } } });
  const got = [];
  const feature = {
    name: "видит-сервис",
    needs: ["userQuestions"],
    apply: (_ctx, _config, deps) => got.push(deps.get("userQuestions")),
  };

  withFeatures([feature], () => apply(ctx, {}));
  assert.equal(got.length, 1);
  assert.equal(typeof got[0].ask, "function");
});

test("упавшая фича не роняет apply и не мешает следующей", () => {
  const { ctx, calls } = fakeCtx();
  const called = [];
  const broken = {
    name: "падает",
    apply: () => {
      throw new Error("boom");
    },
  };
  const plain = { name: "после-аварии", apply: () => called.push("ok") };

  withFeatures([broken, plain], () => assert.doesNotThrow(() => apply(ctx, {})));

  assert.deepEqual(called, ["ok"]);
  assert.match(messages(calls, "warn").join("\n"), /падает/);
  assert.match(messages(calls, "warn").join("\n"), /boom/);
});

test("отказ асинхронной фичи уходит в warn, а не в необработанный отказ", async () => {
  const { ctx, calls } = fakeCtx();
  const broken = { name: "async-падает", apply: async () => { throw new Error("async boom"); } };

  await withFeatures([broken], async () => {
    apply(ctx, {});
    await new Promise((resolve) => setImmediate(resolve));
  });

  assert.match(messages(calls, "warn").join("\n"), /async boom/);
});

test("onDispose снимает ресурсы фичи при выгрузке плагина", () => {
  const { ctx, handlers } = fakeCtx();
  let released = 0;
  const feature = {
    name: "с-ресурсом",
    apply: (_ctx, _config, deps) => deps.onDispose(() => {
      released += 1;
    }),
  };

  withFeatures([feature], () => apply(ctx, {}));
  assert.equal(released, 0, "до выгрузки ресурс жив");
  for (const { event, handler } of handlers) {
    if (event === "dispose") handler();
  }
  assert.equal(released, 1, "dispose снимает ресурс");
});

test("cordis.patch.yml: один insert-ряд ui-remote с name dsh-remote", () => {
  const rows = significantLines(readFileSync(path.join(packageDir, "cordis.patch.yml"), "utf8"));
  assert.deepEqual(rows, ["- insert:", "- id: ui-remote", "name: 'dsh-remote'", "config: {}"]);
  assert.equal(rows.filter((row) => row === "- insert:").length, 1, "ровно один insert-ряд");
});

test("package.json: поля, которые читает загрузчик профиля", () => {
  const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));

  assert.equal(pkg.name, "dsh-remote");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.private, true);
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.main, "lib/index.js");

  assert.equal(pkg.exports["."], "./lib/index.js");
  assert.equal(pkg.exports["./cordis.patch.yml"], "./cordis.patch.yml");
  assert.equal(pkg.exports["./package.json"], "./package.json");
  assert.equal(pkg.exports["./client"], undefined, "клиентская половина — задача 009, не сейчас");

  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.deepEqual(pkg.files, ["lib", "cordis.patch.yml"]);
  assert.deepEqual(pkg.peerDependencies, { "@deepseek-ai/cordis": "^4.0.2" });
  assert.equal(pkg.dependencies, undefined, "зависимостей у каркаса нет: только peer cordis");
});

test("файлы из exports и files существуют", () => {
  const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  for (const target of [pkg.main, pkg.dsh.bundle.patch, ...pkg.files]) {
    assert.ok(existsSync(path.join(packageDir, target)), `нет файла ${target}`);
  }
});
