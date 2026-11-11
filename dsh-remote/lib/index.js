/**
 * Host-половина плагина `dsh-remote`: удалённое управление вопросами агента.
 *
 * Что здесь есть на задаче 001: пакет поднимается в профиле DSH, читает свой
 * `config`, создаёт логгер `[dsh-remote]` и прогоняет реестр фич из
 * `./features.js`. Никакой сети и никаких обязательных сервисов у каркаса нет
 * (`inject` пустой): ответчик `user-questions/request`, транспорты и команды
 * `/remote` приходят следующими задачами и объявляют свои зависимости сами
 * (`needs` у фичи).
 *
 * Правило каркаса: плагин **деградирует, а не падает**. Плагин живёт в процессе
 * DSH, и исключение из `apply` ломает загрузку профиля — то есть заодно и GUI.
 * Поэтому ошибка фичи (и отсутствие её сервиса) — это warn в лог, а не отказ:
 * остальные фичи и сам DSH работают дальше.
 *
 * Состояние плагина живёт вне репозитория — в `~/.dsh/remote-control/`, токены
 * мессенджеров берутся через `ctx.credentials`. Ничего этого каркас пока не
 * трогает.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { features } from "./features.js";

/** Имя плагина: оно же scope логгера и `name` ряда в `cordis.patch.yml`. */
export const name = "dsh-remote";

/**
 * Сервисы, без которых плагин не стартует. Пока пусто: каркас не требует
 * ничего, а фичи проверяют свои зависимости сами (`needs`).
 */
export const inject = [];

apply.inject = inject;

/**
 * Файл трассировки старта: одна строка на каждую загрузку плагина.
 *
 * Зачем: команда `/remote` и панель видны только когда плагин действительно
 * поднялся в профиле, а `logger` пишет в консоль хоста — её не видно без
 * отладки. Строка в файле отвечает на вопрос «загрузился ли плагин» без
 * перезапуска с флагами. Путь переопределяется `$DSH_REMOTE_BOOT_LOG`.
 */
export function bootTraceFile(env = process.env) {
  const explicit = env.DSH_REMOTE_BOOT_LOG;
  if (explicit !== undefined && explicit !== "") return explicit;
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== "" ? env.DSH_HOME : path.join(os.homedir(), ".dsh");
  return path.join(home, "remote-control", "boot.log");
}

/** Записать строку трассировки; сбой трассировки не мешает плагину. */
function recordBootTrace(logger) {
  try {
    const file = bootTraceFile();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${new Date().toISOString()} apply pid=${process.pid}\n`, { mode: 0o600 });
  } catch (error) {
    try {
      logger.warn(`трассировка старта не записалась: ${error?.message ?? error}`);
    } catch {
      /* логгер тоже может быть сломан — молчим */
    }
  }
}

/** Уровни лога cordis, которые нужны плагину. */
const LEVELS = ["debug", "info", "warn", "error"];

/**
 * Фазы снятия ресурсов (034). Порядок фиксирован и не зависит от порядка
 * монтирования фич:
 *
 *   other → closers → timers → transports → commands
 *
 * `closers` (ответчики вопросов/подтверждений) закрывают сообщения, пока
 * транспорт ещё жив; `timers` снимают TTL-сторож и сбрасывают состояние;
 * `transports` останавливают поллеры/WS (relay/telegram/max); `commands` —
 * фасад и привязку. Внутри фазы ресурсы снимаются LIFO (обратно монтированию).
 */
export const DISPOSE_PHASES = Object.freeze(["other", "closers", "timers", "transports", "commands"]);

/**
 * Порядок снятия: сначала по фазам, внутри фазы — обратный порядок монтирования.
 * Вынесено отдельно, чтобы контракт shutdown проверялся тестом без поднятия ctx.
 */
export function orderDisposers(entries) {
  const groups = new Map(DISPOSE_PHASES.map((phase) => [phase, []]));
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry?.fn !== "function") continue;
    const phase = groups.has(entry.phase) ? entry.phase : "other";
    groups.get(phase).push(entry);
  }
  const ordered = [];
  for (const phase of DISPOSE_PHASES) ordered.push(...groups.get(phase).slice().reverse());
  return ordered;
}

/**
 * Логгер `[dsh-remote]`: у cordis логгер может быть и функцией (`ctx.logger(name)`
 * даёт именованный), и объектом. Лог не должен мешать работе, поэтому все
 * обращения обёрнуты: даже битый логгер не роняет `apply`.
 */
function createLogger(ctx) {
  let scope = null;
  try {
    scope = typeof ctx?.logger === "function" ? ctx.logger(name) : ctx?.logger;
  } catch {
    scope = null;
  }
  const logger = {};
  for (const level of LEVELS) {
    logger[level] = (message) => {
      try {
        scope?.[level]?.(String(message));
      } catch {
        /* лог не должен мешать работе */
      }
    };
  }
  return logger;
}

/** Текст ошибки для лога: фича может бросить что угодно. */
function describeError(error) {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/** Конфиг плагина: ожидается объект, всё остальное — пустой конфиг с warn. */
function readConfig(config) {
  if (config === undefined) return { settings: {}, invalid: false };
  if (config !== null && typeof config === "object" && !Array.isArray(config)) {
    return { settings: config, invalid: false };
  }
  return { settings: {}, invalid: true };
}

/**
 * Точка входа плагина.
 *
 * Не бросает: любая проблема — warn в лог. `config` — объект из ряда
 * `cordis.patch.yml` (сейчас `{}`, потому что включение режима живёт в состоянии,
 * а не в профиле).
 */
export async function apply(ctx, config = {}) {
  const logger = createLogger(ctx);
  recordBootTrace(logger);
  const { settings, invalid } = readConfig(config);
  if (invalid) logger.warn("config плагина не объект — работаю с пустым конфигом");

  /** Снятие ресурсов фич: собирается здесь, срабатывает на выгрузке плагина. */
  const disposers = [];
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // 034: снятие идёт фазами (см. DISPOSE_PHASES), а не просто обратным
    // порядком монтирования: релею, который монтируется последним, нельзя
    // останавливать транспорт раньше, чем ответчики закроют сообщения. Промисы
    // снятия дожидаться нельзя (dispose синхронный), поэтому их отклонения
    // гасим, чтобы после stop() не было unhandledRejection.
    for (const entry of orderDisposers(disposers.splice(0))) {
      try {
        const result = entry.fn();
        if (result !== null && typeof result?.then === "function") {
          result.then(undefined, (error) => logger.warn(`снятие ресурса фичи упало: ${describeError(error)}`));
        }
      } catch (error) {
        logger.warn(`снятие ресурса фичи упало: ${describeError(error)}`);
      }
    }
  };

  // Снятие ресурсов — через `ctx.effect`: cordis вызывает возвращённый disposer
  // при выгрузке файбера плагина, и это единственный настоящий путь shutdown.
  // Событие `dispose` cordis НЕ эмитит (тот же вывод в образце
  // ~/projects/dsh-kanban/dsh-kanban/lib/index.js:541-549), поэтому `ctx.on` ниже
  // — лишь хук для хостов и тестов, которые эмитят событие сами; `dispose`
  // идемпотентен, двойной вызов безопасен.
  try {
    ctx?.effect?.(() => dispose, "dsh-remote: dispose");
  } catch (error) {
    logger.warn(`не зарегистрировал снятие ресурсов через ctx.effect: ${describeError(error)}`);
  }

  try {
    ctx?.on?.("dispose", dispose);
  } catch (error) {
    logger.warn(`не подписался на событие dispose: ${describeError(error)}`);
  }

  const deps = {
    logger,
    /** Сервис из контекста: нет сервиса (или ctx без `get`) — null, не исключение. */
    get(service) {
      try {
        if (typeof ctx?.get !== "function") return null;
        return ctx.get(service) ?? null;
      } catch {
        return null;
      }
    },
    /**
     * Фича просит снять свой ресурс при выгрузке плагина.
     * `phase` — одна из DISPOSE_PHASES (034): `closers` закрывают сообщения,
     * `timers` снимают сторож, `transports` останавливают поллеры/WS,
     * `commands` — фасад. По умолчанию — `other`.
     */
    onDispose(disposer, phase = "other") {
      if (typeof disposer !== "function") return;
      const effective = DISPOSE_PHASES.includes(phase) ? phase : "other";
      if (disposed) {
        try {
          const result = disposer();
          if (result !== null && typeof result?.then === "function") result.catch(() => {});
        } catch (error) {
          logger.warn(`снятие ресурса фичи упало: ${describeError(error)}`);
        }
        return;
      }
      disposers.push({ fn: disposer, phase: effective });
    },
  };

  // Копия реестра: фича, добавленная во время обхода, не поедет в этом проходе.
  const registry = Array.isArray(features) ? [...features] : [];
  let started = 0;

  for (const [index, feature] of registry.entries()) {
    const label = typeof feature?.name === "string" && feature.name.trim() !== ""
      ? feature.name.trim()
      : `#${index}`;

    if (typeof feature?.apply !== "function") {
      logger.warn(`фича ${label}: нет apply — пропущена`);
      continue;
    }

    const needs = Array.isArray(feature.needs) ? feature.needs.map(String) : [];
    const missing = needs.filter((service) => deps.get(service) === null);
    if (missing.length > 0) {
      logger.warn(`фича ${label}: в контексте нет ${missing.join(", ")} — пропущена, плагин работает без неё`);
      continue;
    }

    try {
      // Фича может быть асинхронной (например, ждёт `credentials.resolve`):
      // дожидаемся её, иначе следующая фича проверит свои `needs` до того, как
      // сервис появится, и будет пропущена навсегда.
      const result = feature.apply(ctx, settings, deps);
      if (result !== null && typeof result?.then === "function") await result;
      started += 1;
    } catch (error) {
      logger.warn(`фича ${label} упала: ${describeError(error)}`);
    }
    if (disposed) {
      logger.warn("плагин выгружен во время запуска фич — остальные не запускаю");
      break;
    }
  }

  logger.info(`каркас поднят: фич ${registry.length}, запущено ${started}`);
}
