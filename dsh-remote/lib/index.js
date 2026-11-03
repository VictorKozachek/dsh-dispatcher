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

import { features } from "./features.js";

/** Имя плагина: оно же scope логгера и `name` ряда в `cordis.patch.yml`. */
export const name = "dsh-remote";

/**
 * Сервисы, без которых плагин не стартует. Пока пусто: каркас не требует
 * ничего, а фичи проверяют свои зависимости сами (`needs`).
 */
export const inject = [];

apply.inject = inject;

/** Уровни лога cordis, которые нужны плагину. */
const LEVELS = ["debug", "info", "warn", "error"];

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
  const { settings, invalid } = readConfig(config);
  if (invalid) logger.warn("config плагина не объект — работаю с пустым конфигом");

  /** Снятие ресурсов фич: собирается здесь, срабатывает на выгрузке плагина. */
  const disposers = [];
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // 034: LIFO — ресурсы снимаются в обратном порядке монтирования. Это важно
    // для graceful shutdown: ответчик закрывает сообщения ещё живым транспортом,
    // а поллеры/WS останавливаются последними (команды/фасад) — иначе закрывать
    // открытые вопросы было бы нечем. Промисы снятия дожидаться нельзя
    // (dispose синхронный), поэтому их отклонения гасим, чтобы после stop() не
    // было unhandledRejection.
    for (const disposer of disposers.splice(0).reverse()) {
      try {
        const result = disposer();
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
    /** Фича просит снять свой ресурс при выгрузке плагина. */
    onDispose(disposer) {
      if (typeof disposer !== "function") return;
      if (disposed) {
        try {
          disposer();
        } catch (error) {
          logger.warn(`снятие ресурса фичи упало: ${describeError(error)}`);
        }
        return;
      }
      disposers.push(disposer);
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
