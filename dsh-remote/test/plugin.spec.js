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
 * Фейковый `ctx` в объёме, который нужен каркасу: `get`, `on`, `effect`, `logger`.
 *
 * `services` — что отдаёт `get`; `loggerShape` — каким бывает логгер у cordis
 * (функция `ctx.logger(name)`, готовый объект, отсутствие, сломанный);
 * `getThrows`/`onThrows`/`effectThrows` — проверка того, что каркас не падает на
 * чужой поломке.
 *
 * `effect(execute, label)` ведёт себя как cordis: выполняет `execute` сразу и
 * отдаёт disposer, который снимет то, что `execute` вернул, — именно так cordis
 * и выгружает файбер плагина (событие `dispose` он не эмитит).
 */
function fakeCtx({
  services = {},
  loggerShape = "function",
  getThrows = false,
  onThrows = false,
  effectThrows = false,
} = {}) {
  const calls = [];
  const scopes = [];
  const handlers = [];
  const effects = [];
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
    effect(execute, label) {
      if (effectThrows) throw new Error("effect сломан");
      const disposable = execute();
      effects.push({ label, disposable });
      return () => {
        if (typeof disposable === "function") disposable();
      };
    },
    logger,
  };
  return { ctx, calls, scopes, handlers, effects };
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

/**
 * Временная фича в реестре: тест не должен оставлять реестр изменённым.
 * `apply` каркаса асинхронный (ждёт async фичи), поэтому и прогон асинхронный.
 */
async function withFeatures(extra, run) {
  features.push(...extra);
  try {
    return await run();
  } finally {
    features.splice(features.length - extra.length, extra.length);
  }
}

test("каркас: имя плагина, пустой inject и фичи с контрактом", () => {
  assert.equal(name, "dsh-remote");
  assert.deepEqual(inject, []);
  // Реестр больше не пуст: задачу 001 он поднимал пустым, 002 подключила ответчика.
  // Здесь проверяем контракт фичи, а не конкретный состав — состав растёт с задачами.
  for (const feature of features) {
    assert.equal(typeof feature.name, "string", "у фичи есть имя для лога");
    assert.equal(typeof feature.apply, "function", "у фичи есть apply");
    assert.ok(Array.isArray(feature.needs ?? []), "needs — список сервисов или отсутствует");
  }
  // Порядок не косметика: транспорт поднимается первым, иначе ответчик с
  // `needs: [remoteTransport]` пропускается, не дождавшись сервиса.
  // Порядок: commands регистрирует фасад и состояние, telegram кладёт транспорт в
  // фасад, reliability даёт ответчику deliver/TTL, answerer и approvals (024)
  // подписываются после транспорта, panel (009) — рядом с ними.
  assert.deepEqual(
    features.map((feature) => feature.name),
    ["commands", "max", "telegram", "reliability", "answerer", "approvals", "relay", "notify", "panel"],
  );
});

test("apply поднимается на пустом ctx без сервисов и не бросает", async () => {
  const { ctx, calls, scopes, handlers, effects } = fakeCtx();
  await assert.doesNotReject(() => apply(ctx, {}));
  assert.equal(scopes[0], "dsh-remote", "логгер создаётся со scope [dsh-remote]");
  assert.deepEqual(messages(calls, "error"), []);
  assert.match(messages(calls, "info").join("\n"), /каркас поднят/);
  assert.deepEqual(effects.map((item) => item.label), ["dsh-remote: dispose"], "cleanup — через ctx.effect");
  assert.deepEqual(handlers.map((item) => item.event), ["dispose"], "событие dispose — хук для хостов");
});

test("apply не падает на ctx без logger, get и on", async () => {
  await assert.doesNotReject(() => apply({}, {}));
  await assert.doesNotReject(() => apply(undefined, undefined));
});

test("apply не падает, когда ctx.get, ctx.on, ctx.effect и ctx.logger сами бросают", async () => {
  const { ctx } = fakeCtx({ loggerShape: "throwing" });
  await assert.doesNotReject(() => apply(ctx, {}));
  await assert.doesNotReject(() => apply(fakeCtx({ getThrows: true }).ctx, {}));
  await assert.doesNotReject(() => apply(fakeCtx({ onThrows: true }).ctx, {}));
  await assert.doesNotReject(() => apply(fakeCtx({ effectThrows: true }).ctx, {}));
  await assert.doesNotReject(() => apply(fakeCtx({ loggerShape: "object" }).ctx, {}));
});

test("config не объект: warn вместо падения", async () => {
  const { ctx, calls } = fakeCtx();
  await assert.doesNotReject(() => apply(ctx, "строка"));
  assert.match(messages(calls, "warn").join("\n"), /config/);
});

test("фича без своего сервиса пропускается с warn, остальные запускаются", async () => {
  const { ctx, calls } = fakeCtx();
  const called = [];
  const withoutService = {
    name: "нуждается-в-сервисе",
    needs: ["userQuestions"],
    apply: () => called.push("нуждается"),
  };
  const plain = { name: "обычная", apply: () => called.push("обычная") };

  await withFeatures([withoutService, plain], () => apply(ctx, {}));

  assert.deepEqual(called, ["обычная"]);
  const warn = messages(calls, "warn").join("\n");
  assert.match(warn, /нуждается-в-сервисе/);
  assert.match(warn, /userQuestions/);
});

test("фича с сервисом из ctx запускается", async () => {
  const { ctx } = fakeCtx({ services: { userQuestions: { ask: () => {} } } });
  const got = [];
  const feature = {
    name: "видит-сервис",
    needs: ["userQuestions"],
    apply: (_ctx, _config, deps) => got.push(deps.get("userQuestions")),
  };

  await withFeatures([feature], () => apply(ctx, {}));
  assert.equal(got.length, 1);
  assert.equal(typeof got[0].ask, "function");
});

test("упавшая фича не роняет apply и не мешает следующей", async () => {
  const { ctx, calls } = fakeCtx();
  const called = [];
  const broken = {
    name: "падает",
    apply: () => {
      throw new Error("boom");
    },
  };
  const plain = { name: "после-аварии", apply: () => called.push("ok") };

  await withFeatures([broken, plain], () => assert.doesNotReject(() => apply(ctx, {})));

  assert.deepEqual(called, ["ok"]);
  assert.match(messages(calls, "warn").join("\n"), /падает/);
  assert.match(messages(calls, "warn").join("\n"), /boom/);
});

test("отказ асинхронной фичи уходит в warn, а не в необработанный отказ", async () => {
  const { ctx, calls } = fakeCtx();
  const broken = { name: "async-падает", apply: async () => { throw new Error("async boom"); } };

  await withFeatures([broken], () => apply(ctx, {}));

  assert.match(messages(calls, "warn").join("\n"), /async boom/);
});

test("выгрузка плагина через ctx.effect снимает ресурсы фичи", async () => {
  const fake = fakeCtx();
  let released = 0;
  const feature = {
    name: "с-ресурсом",
    apply: (_ctx, _config, deps) => deps.onDispose(() => {
      released += 1;
    }),
  };

  await withFeatures([feature], () => apply(fake.ctx, {}));
  assert.equal(released, 0, "до выгрузки ресурс жив");

  // cordis при выгрузке файбера вызывает disposer, который вернул effect().
  assert.equal(fake.effects.length, 1, "cleanup зарегистрирован одним эффектом");
  assert.equal(fake.effects[0].label, "dsh-remote: dispose");
  fake.effects[0].disposable();
  assert.equal(released, 1, "выгрузка плагина снимает ресурс");

  // Идемпотентность: событие dispose от хоста после выгрузки ничего не ломает.
  for (const { handler } of fake.handlers) handler();
  assert.equal(released, 1, "повторное снятие — no-op");
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
  assert.equal(pkg.exports["./client"], "./lib/client.js", "клиентская половина — задача 009");
  assert.equal(pkg.dsh?.client?.platform, "web", "клиентский бандл для Web");
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0);

  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  assert.deepEqual(pkg.files, ["lib", "cordis.patch.yml", "README.md"]);
  assert.deepEqual(pkg.peerDependencies, { "@deepseek-ai/cordis": "^4.0.2" });
  assert.equal(pkg.dependencies, undefined, "зависимостей у каркаса нет: только peer cordis");
});

test("файлы из exports и files существуют", () => {
  const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  for (const target of [pkg.main, pkg.dsh.bundle.patch, ...pkg.files]) {
    assert.ok(existsSync(path.join(packageDir, target)), `нет файла ${target}`);
  }
});
