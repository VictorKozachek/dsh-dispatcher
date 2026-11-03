/**
 * Журнал удалённых решений (задача 026): append-only JSONL рядом с `state.json`.
 *
 * Зачем отдельный файл, а не `state.json`:
 *   - решения — это история, а не состояние: их нельзя перезаписывать и терять при
 *     падении, поэтому только `appendFileSync` одной строкой на запись;
 *   - JSONL читается построчно: битая последняя строка (падение посреди записи) не
 *     ломает весь журнал, её просто пропускаем;
 *   - ротация по размеру не даёт файлу расти бесконечно; прежние файлы остаются
 *     рядом (`audit.jsonl.1`, `.2`, `.3`), поэтому `tail` и сводка видят историю.
 *
 * Приватность: в журнал попадают только метаданные решения. **Тел команд и
 * причин там нет** — их и нет в `ApprovalRequestEvent` (DSH не передаёт аргументы
 * инструмента), а `reason`/`displayReason` мы сознательно не пишем. Дополнительно
 * все строки проходят `redactSecrets`: если вызывающий положит в поле токен или
 * ключ, он не окажется в файле. Список полей — белый (`ALLOWED_KEYS`), лишние
 * ключи отбрасываются.
 */

import fs from "node:fs";
import path from "node:path";

import { statePaths } from "./store.js";

/** Имя журнала рядом с `state.json`. */
export const AUDIT_FILE_NAME = "audit.jsonl";

/** Размер, после которого журнал уезжает в `.1` (256 КиБ — это тысячи решений). */
export const DEFAULT_MAX_BYTES = 256 * 1024;

/** Сколько ротированных файлов держим: 3 × 256 КиБ — история без бесконечного роста. */
export const DEFAULT_KEEP_ROTATED = 3;

/** Что пишем: только подтверждения (вопросы — история сессии в DSH). */
export const AUDIT_KIND_APPROVAL = "approval";

/** Откуда пришло решение: удалённо, отдано GUI, истекло/снято без ответа. */
export const AUDIT_DECISIONS = Object.freeze(["remote", "gui", "timeout"]);

/** Разрешённые поля записи (лишние отбрасываются — так безопаснее). */
export const ALLOWED_KEYS = Object.freeze([
  "ts",
  "kind",
  "questionId",
  "toolName",
  "callId",
  "outcome",
  "channel",
  "chatId",
  "answeredBy",
  "sessionId",
  "workspace",
  "waitedMs",
  "decision",
]);

/** Пределы длины строковых полей: журнал не место для простыней. */
const LIMITS = Object.freeze({
  questionId: 64,
  toolName: 128,
  callId: 128,
  outcome: 32,
  channel: 32,
  chatId: 64,
  answeredBy: 128,
  sessionId: 128,
  workspace: 512,
});

/** Секреты, которые не должны попасть в журнал даже по ошибке вызывающего. */
const SECRET_PATTERNS = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(token|secret|password|passwd|api[_-]?key|authorization)\b\s*[=:]\s*[^\s,;"]+/gi,
  /\b\d{3,}:[A-Za-z0-9_-]{20,}\b/g, // токен Telegram-бота
  /\bsk-[A-Za-z0-9]{16,}\b/g,
]);

/** Вырезать секреты из строки; не-строки приводим к строке только если просят. */
export function redactSecrets(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "<redacted>");
  return text;
}

function clip(value, limit) {
  const text = String(value);
  if (!Number.isFinite(limit) || text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/**
 * Нормализовать запись: белый список полей, строки без секретов и лишней длины,
 * числа — целые неотрицательные. Возвращает `null`, если запись бессмысленна.
 */
export function sanitizeEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = {};
  for (const [key, raw] of Object.entries(entry)) {
    if (!ALLOWED_KEYS.includes(key)) continue; // `reason`, `command`, … — не пишем
    if (raw === undefined || raw === null) continue;
    if (key === "waitedMs") {
      const number = Number(raw);
      if (!Number.isFinite(number) || number < 0) continue;
      record[key] = Math.round(number);
      continue;
    }
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue;
    const limit = LIMITS[key];
    record[key] = clip(redactSecrets(raw), limit);
  }
  if (typeof record.ts !== "string" || record.ts === "") return null;
  if (record.kind !== AUDIT_KIND_APPROVAL) return null;
  if (!AUDIT_DECISIONS.includes(record.decision)) return null;
  return record;
}

/** Путь журнала: `DSH_REMOTE_AUDIT` главнее каталога состояния (нужно тестам). */
export function auditPaths({ env = process.env, home, dir } = {}) {
  const override = typeof env?.DSH_REMOTE_AUDIT === "string" && env.DSH_REMOTE_AUDIT !== ""
    ? env.DSH_REMOTE_AUDIT
    : null;
  if (override !== null) return { file: override, dir: path.dirname(override) };
  const base = typeof dir === "string" && dir !== "" ? dir : statePaths({ env, home }).dir;
  return { file: path.join(base, AUDIT_FILE_NAME), dir: base };
}

/**
 * Журнал решений.
 *
 * @param {object} [options]
 * @param {string} [options.file] — явный путь (тесты); иначе рядом с `state.json`.
 * @param {string} [options.dir] — каталог состояния, если путь не задан.
 * @param {number} [options.maxBytes] — порог ротации.
 * @param {() => number} [options.now] — часы (мс epoch).
 * @param {(message: string) => void} [options.log]
 * @param {typeof fs} [options.fsImpl] — подмена файловой системы в тестах.
 */
export function createAudit({
  file,
  dir,
  maxBytes = DEFAULT_MAX_BYTES,
  keepRotated = DEFAULT_KEEP_ROTATED,
  now = () => Date.now(),
  log = () => {},
  fsImpl = fs,
} = {}) {
  const paths = typeof file === "string" && file !== "" ? auditPaths({ env: { DSH_REMOTE_AUDIT: file } }) : auditPaths({ dir });
  const rotatedFiles = Array.from({ length: Math.max(0, Math.floor(keepRotated)) }, (_, index) => `${paths.file}.${index + 1}`);
  const rotatedFile = rotatedFiles[0] ?? `${paths.file}.1`;

  /** Дописать решение. Ошибки записи не должны ломать ответ человека. */
  function append(entry) {
    const record = sanitizeEntry({ ts: new Date(now()).toISOString(), kind: AUDIT_KIND_APPROVAL, ...entry });
    if (record === null) {
      log("аудит: запись не прошла проверку — пропускаю");
      return false;
    }
    const line = `${JSON.stringify(record)}\n`;
    try {
      fsImpl.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
      rotateIfNeeded(line.length);
      fsImpl.appendFileSync(paths.file, line, { mode: 0o600 });
      return true;
    } catch (error) {
      log(`аудит: записать решение не удалось (${error?.message ?? error})`);
      return false;
    }
  }

  /** Ротация по размеру: текущий файл уезжает в `.1`, старые сдвигаются вглубь. */
  function rotateIfNeeded(incoming = 0) {
    let size = 0;
    try {
      size = fsImpl.statSync(paths.file).size;
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (size <= 0 || size + incoming <= maxBytes) return;
    if (rotatedFiles.length === 0) {
      // Ротация выключена (keepRotated: 0): просто чистим текущий файл.
      fsImpl.rmSync(paths.file, { force: true });
      log(`аудит: журнал превысил ${maxBytes} байт — старые записи удалены`);
      return;
    }
    // Сдвигаем .N-1 → .N (самый старый удаляем), затем current → .1.
    for (let index = rotatedFiles.length - 1; index >= 1; index -= 1) {
      try {
        fsImpl.renameSync(rotatedFiles[index - 1], rotatedFiles[index]);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    try {
      fsImpl.rmSync(rotatedFiles[0], { force: true });
    } catch {
      /* старого файла нет — и хорошо */
    }
    fsImpl.renameSync(paths.file, rotatedFiles[0]);
    log(`аудит: журнал превысил ${maxBytes} байт — ротация в ${rotatedFiles[0]}`);
  }

  /** Прочитать строки файла; битые строки и не-объекты пропускаем. */
  function readLines(target) {
    let text;
    try {
      text = fsImpl.readFileSync(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") log(`аудит: прочитать ${target} не удалось (${error?.message ?? error})`);
      return [];
    }
    const entries = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) entries.push(parsed);
      } catch {
        // Обрыв записи при падении — ожидаемый случай: строку просто теряем.
      }
    }
    return entries;
  }

  /** Все записи в порядке времени: от самого старого ротированного к текущему. */
  function entries() {
    const older = [...rotatedFiles].reverse().flatMap((target) => readLines(target));
    return [...older, ...readLines(paths.file)];
  }

  /** Последние `limit` решений (новые в конце — как в файле). */
  function tail(limit = 20) {
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20;
    if (count === 0) return [];
    return entries().slice(-count);
  }

  /** Сводка для `/remote status`: сколько решено удалённо/GUI/без ответа. */
  function stats() {
    const all = entries();
    const summary = { total: all.length, remote: 0, gui: 0, timeout: 0 };
    for (const entry of all) {
      if (entry.decision === "remote") summary.remote += 1;
      else if (entry.decision === "gui") summary.gui += 1;
      else if (entry.decision === "timeout") summary.timeout += 1;
    }
    return summary;
  }

  return { paths: { ...paths, rotated: rotatedFile }, append, tail, stats, entries };
}
