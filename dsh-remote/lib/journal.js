/**
 * Рабочий журнал плагина (задача 051): одна JSON-строка на событие.
 *
 * Пишется в `$DSH_HOME/remote-control/log.jsonl` (путь переопределяется
 * `DSH_REMOTE_LOG_FILE`/`config.logFile`, `logFile: false` выключает). Формат:
 * `{ts, level, event, transport, shortId, detail}`. Секреты и тексты ответов
 * человека не пишем: строки проходят маскировку, у ответа остаётся только
 * `customLength`.
 *
 * Ошибка записи не роняет плагин: одна строка в консоль, дальше работаем.
 */

import fs from "node:fs";
import path from "node:path";

import { statePaths } from "./store.js";
import { DEFAULT_KEEP, DEFAULT_MAX_BYTES, rotateIfNeeded } from "./rotate.js";

const SECRET_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(token|secret|password|passwd|api[_-]?key|authorization)\b\s*[=:]\s*[^\s,;"]+/gi,
  /\b\d{3,}:[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
]);

/** Замаскировать секреты в строке. */
export function redactJournalText(text) {
  let result = String(text ?? "");
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "<redacted>");
  return result;
}

/** Безопасно превратить detail в JSON-значение без секретов и без простыней. */
function sanitizeDetail(detail) {
  if (detail === undefined || detail === null) return undefined;
  const json = typeof detail === "string" ? detail : JSON.stringify(detail);
  return redactJournalText(json).slice(0, 2000);
}

/** Путь журнала: явный файл → env DSH_REMOTE_LOG_FILE → statePaths().log. */
export function journalPath({ config = null, env = process.env, home = undefined } = {}) {
  if (typeof config?.logFile === "string" && config.logFile !== "") return config.logFile;
  const fromEnv = env?.DSH_REMOTE_LOG_FILE;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  return path.join(statePaths({ env, home }).dir, "log.jsonl");
}

/**
 * Создать журнал. `enabled: false` — все записи становятся no-op.
 */
export function createJournal({
  file,
  enabled = true,
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
  now = () => Date.now(),
  logger = null,
} = {}) {
  let disabled = enabled !== true;
  let reportedError = false;

  function failOnce(error) {
    if (reportedError) return;
    reportedError = true;
    const message = `journal: запись не удалась (${error?.message ?? error}) — журнал отключён`;
    try {
      if (typeof logger === "function") logger(message);
      else console.error(`[dsh-remote] ${message}`);
    } catch {
      /* консоль может быть недоступна — молчим */
    }
  }

  /**
   * Записать событие. Поля фиксированы; `detail` — объект/строка без секретов.
   * @returns {boolean} удалось ли записать.
   */
  function record(event, fields = {}) {
    if (disabled) return false;
    if (typeof event !== "string" || event === "") return false;
    const ts = new Date(now()).toISOString();
    const entry = {
      ts,
      level: typeof fields?.level === "string" && fields.level !== "" ? fields.level : "info",
      event,
      ...(typeof fields?.transport === "string" && fields.transport !== "" ? { transport: fields.transport } : {}),
      ...(typeof fields?.shortId === "string" && fields.shortId !== "" ? { shortId: fields.shortId } : {}),
      ...(sanitizeDetail(fields?.detail) === undefined ? {} : { detail: sanitizeDetail(fields.detail) }),
    };
    const line = `${JSON.stringify(entry)}\n`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      rotateIfNeeded(fs, file, line.length, { maxBytes, keep, log: () => {} });
      fs.appendFileSync(file, line, { mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* не критично */
      }
      return true;
    } catch (error) {
      failOnce(error);
      return false;
    }
  }

  return {
    file,
    get enabled() {
      return !disabled;
    },
    record,
  };
}
