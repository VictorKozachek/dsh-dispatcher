/**
 * Политика удалённых подтверждений (approvals, задача 025).
 *
 * Подтверждение действия опаснее вопроса: ошибка стоит дорого. Поэтому политика
 * решает **до** отправки в канал, можно ли вообще спрашивать человека удалённо,
 * и что делать, если он не ответил. Принципы:
 *
 *   - по умолчанию удалённо подтверждается только **чтение** (read-only):
 *     политика не видит путь, поэтому не может доказать, что запись идёт «в свой
 *     воркспейс». Инструменты записи человек добавляет явно;
 *   - `denyRemote` всегда отдаёт инструмент в GUI, даже если он в allowlist;
 *   - неизвестный инструмент — в GUI (fail closed);
 *   - таймаут — **отказ** (`cancelled`), а не «тихое разрешение»; альтернатива
 *     `unavailable` — тоже отказ, но по контракту DSH вызывающий получает
 *     «нет человека» и решает сам (fail closed);
 *   - TTL по умолчанию 30 минут, как у вопросов.
 *
 * Модуль чистый: ни DSH, ни сети. Ответчик 024 спрашивает `decide()` перед
 * публикацией в канал, а при таймауте берёт `timeoutOutcome()`.
 */

import { DEFAULT_LANG, normalizeLang, t } from "../i18n.js";

/** Инструменты, которые по умолчанию можно подтверждать удалённо. */
export const DEFAULT_TOOLS = Object.freeze([
  "read_file",
  "list_files",
  "glob",
  "grep",
]);

/**
 * Инструменты, которые по умолчанию нельзя подтверждать удалённо: запуск
 * процессов/команд и всё, что может тронуть систему вне воркспейса.
 */
export const DEFAULT_DENY_REMOTE = Object.freeze([
  "bash",
  "shell",
  "terminal",
  "exec",
  "run_command",
  "spawn",
  "git_push",
  "git_reset",
  "delete_file",
  "rm",
]);

export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_ON_TIMEOUT = "cancelled";

/** Исходы, допустимые для `onTimeout` (оба — отказ). */
export const ON_TIMEOUT_VALUES = Object.freeze(["cancelled", "unavailable"]);

const noopLog = () => {};

function stringList(value) {
  if (!Array.isArray(value)) return null;
  const items = value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  // Массив с мусором (целиком или частично) не должен молча менять политику:
  // возвращаем null (безопасный дефолт), а не усечённый список.
  if (value.length !== items.length) return null;
  return [...new Set(items)];
}

/**
 * Собрать действующую политику из конфига плагина.
 *
 * Неизвестные/битые значения не расширяют права: список заменяется дефолтом
 * только при **отсутствии** поля; явный пустой список означает «удалённо
 * подтверждать нечего» (тоже безопасно).
 *
 * @param {object|null} config — секция `approvals` строки плагина.
 * @returns {{tools: string[], denyRemote: string[], onTimeout: "cancelled"|"unavailable", ttlMs: number}}
 */
export function normalizePolicy(config, { log = noopLog } = {}) {
  const section = config !== null && typeof config === "object" ? config : {};
  const tools = stringList(section.tools);
  const denyRemote = stringList(section.denyRemote);

  let onTimeout = DEFAULT_ON_TIMEOUT;
  if (section.onTimeout !== undefined) {
    if (ON_TIMEOUT_VALUES.includes(section.onTimeout)) {
      onTimeout = section.onTimeout;
    } else {
      log(`политика подтверждений: onTimeout=${JSON.stringify(section.onTimeout)} не поддерживается — остаётся ${DEFAULT_ON_TIMEOUT} (отказ)`);
    }
  }

  let ttlMs = DEFAULT_TTL_MS;
  if (section.ttlMs !== undefined) {
    const value = Number(section.ttlMs);
    if (Number.isFinite(value) && value >= 60_000 && value <= 24 * 60 * 60 * 1000) {
      ttlMs = Math.floor(value);
    } else {
      log(`политика подтверждений: ttlMs=${JSON.stringify(section.ttlMs)} вне 1 мин..24 ч — остаётся ${DEFAULT_TTL_MS}`);
    }
  }

  return {
    tools: tools ?? [...DEFAULT_TOOLS],
    denyRemote: denyRemote ?? [...DEFAULT_DENY_REMOTE],
    onTimeout,
    ttlMs,
  };
}

/** Имя инструмента из запроса `approval/request` (DSH может класть по-разному). */
export function toolNameOf(request) {
  const candidates = [request?.toolName, request?.tool?.name, request?.name, request?.tool];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

/**
 * Решение «спрашивать удалённо или отдать GUI».
 *
 * @param {object} policy — результат `normalizePolicy`.
 * @param {object} request — запрос подтверждения (`toolName`, `reason`, ...).
 * @returns {{remote: boolean, reason: string, toolName: string|null, message: string}}
 *   `reason`: `allowed` | `tool-not-allowed` | `deny-remote` | `unknown-tool`.
 */
export function decide(policy, request) {
  const toolName = toolNameOf(request);
  if (toolName === null) {
    return {
      remote: false,
      reason: "unknown-tool",
      toolName: null,
      message: "инструмент не указан — подтверждение только в GUI",
    };
  }
  if ((policy?.denyRemote ?? []).includes(toolName)) {
    return {
      remote: false,
      reason: "deny-remote",
      toolName,
      message: `${toolName} в denyRemote — подтверждение только в GUI`,
    };
  }
  if (!(policy?.tools ?? []).includes(toolName)) {
    return {
      remote: false,
      reason: "tool-not-allowed",
      toolName,
      message: `${toolName} не в allowlist approvals.tools — подтверждение только в GUI`,
    };
  }
  return {
    remote: true,
    reason: "allowed",
    toolName,
    message: `${toolName} разрешён политикой — можно спросить удалённо`,
  };
}

/** Исход, который ответчик обязан вернуть при таймауте. Никогда не `allowed-once`. */
export function timeoutOutcome(policy) {
  return ON_TIMEOUT_VALUES.includes(policy?.onTimeout) ? policy.onTimeout : DEFAULT_ON_TIMEOUT;
}

/** Человеческое описание политики для `/remote status`. */
export function describePolicy(policy, lang = DEFAULT_LANG) {
  const code = normalizeLang(lang) ?? DEFAULT_LANG;
  const tools = policy?.tools ?? [];
  const deny = policy?.denyRemote ?? [];
  return [
    t("policy.tools", { p0: tools.join(", ") || "—" }, code),
    t("policy.denyRemote", { p0: deny.join(", ") || "—" }, code),
    t("policy.timeout", {
      p0: timeoutOutcome(policy),
      p1: Math.round((policy?.ttlMs ?? DEFAULT_TTL_MS) / 60000),
    }, code),
  ];
}

/**
 * Готовая политика по умолчанию (для ответчика без конфига и для тестов).
 * @param {object|null} config
 */
export function createApprovalPolicy(config, options) {
  const policy = normalizePolicy(config, options);
  return {
    ...policy,
    decide: (request) => decide(policy, request),
    timeoutOutcome: () => timeoutOutcome(policy),
    describe: (lang = DEFAULT_LANG) => describePolicy(policy, lang),
  };
}
