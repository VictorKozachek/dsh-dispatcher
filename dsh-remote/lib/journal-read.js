/**
 * Чтение рабочего журнала для панели (задача 070).
 *
 * `log.jsonl` пишет `lib/journal.js`: одна JSON-строка на событие. Здесь —
 * только чтение: разбор строк, склейка событий по `shortId` в историю вопроса и
 * фильтры (время/проект). Модуль не пишет ни в журнал, ни в состояние и не
 * импортирует транспорт/ответчик — панель должна оставаться read-only.
 *
 * Формат события: `{ts, level, event, transport?, shortId?, detail?}`; `detail`
 * — JSON-строка (так его пишет `journal.js`). Тексты ответов в журнал не
 * попадают: в истории остаются `customLength`, идентификаторы вариантов и коды
 * ошибок, а не сообщения/токены.
 */

import fs from "node:fs";

/** Сколько часов истории показываем по умолчанию. */
export const HISTORY_HOURS = 24;

/** Сколько строк истории отдаём по умолчанию. */
export const HISTORY_LIMIT = 20;

/** Разобрать `detail`: строка с JSON, объект или undefined. */
export function parseDetail(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Метка времени события: `ts` ISO или число; иначе null. */
function timeOf(entry) {
  const raw = entry?.ts;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Проект из события: поле верхнего уровня или `detail.workspace/project`. */
function projectOf(entry, detail) {
  for (const value of [entry?.project, entry?.workspace, detail?.project, detail?.workspace]) {
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/** Безопасное значение detail: только примитивы, без вложенных тел. */
function scalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

/**
 * Прочитать строки журнала и `.1` после ротации.
 *
 * Порядок: сначала `.1`, затем основной файл — так старые события идут раньше
 * новых. Битые строки не роняют чтение: они считаются в `skipped`.
 *
 * @param logFile - путь `log.jsonl`.
 * @param options - `{now, hours, workspace, logger, limit}`.
 * @returns `{entries, skipped, files, unreadable}`.
 */
export function readJournalEntries(logFile, {
  now = Date.now(),
  hours = HISTORY_HOURS,
  workspace = null,
  logger = () => {},
} = {}) {
  const entries = [];
  let skipped = 0;
  let failed = false;
  // Путь не задан (панель собрана без журнала) — это «пока нет событий», а не
  // ошибка чтения: нечего открывать, и падать тут нечему.
  if (typeof logFile !== "string" || logFile.trim() === "") {
    return { entries, skipped, files: [], unreadable: false };
  }
  const files = [`${logFile}.1`, logFile];
  const cutoff = now - Math.max(1, hours) * 60 * 60 * 1000;

  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        failed = true;
        logger(`история: ${file} не прочитан (${error?.message ?? error})`);
      }
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        skipped += 1;
        continue;
      }
      const ts = timeOf(entry);
      if (ts === null) {
        skipped += 1;
        continue;
      }
      if (ts < cutoff) continue;
      const detail = parseDetail(entry.detail);
      const project = projectOf(entry, detail);
      if (workspace !== null && workspace !== undefined && workspace !== ""
        && project !== null && project !== workspace) continue;
      entries.push({
        ts,
        event: typeof entry.event === "string" ? entry.event : "unknown",
        transport: typeof entry.transport === "string" ? entry.transport : null,
        shortId: typeof entry.shortId === "string" && entry.shortId !== "" ? entry.shortId : null,
        level: typeof entry.level === "string" ? entry.level : "info",
        project,
        detail,
      });
    }
  }

  entries.sort((left, right) => left.ts - right.ts);
  // Отсутствие файла — норма (плагин ещё не писал); unreadable только для
  // реальной ошибки чтения.
  return { entries, skipped, files, unreadable: failed };
}

/** Текст статуса по коду: панель показывает русскую подпись, тесты — код. */
export function historyStatusText(status, { code = null, reason = null } = {}) {
  switch (status) {
    case "queued": return "отправляется";
    case "delivered": return "доставлен";
    case "error": return code === null ? "ошибка доставки" : `ошибка доставки (${code})`;
    case "answered": return "отвечен";
    case "unmatched": return reason === null ? "не сопоставлен" : `не сопоставлен (${reason})`;
    case "cancelled": return reason === null ? "снят" : `снят (${reason})`;
    case "pairing": return "привязка";
    case "pairing-error": return code === null ? "ошибка привязки" : `ошибка привязки (${code})`;
    default: return status;
  }
}

/**
 * Склеить историю вопросов по `shortId`.
 *
 * Последнее событие по вопросу задаёт статус; детали накапливаются (messageId,
 * optionIds, customLength, code/reason). Строки сортируются по времени события
 * (свежие сверху), ограничиваются `limit`.
 *
 * @param entries - результат `readJournalEntries().entries` или свой список.
 * @param options - `{limit, workspace}`.
 * @returns `{rows, total}`.
 */
export function buildQuestionHistory(entries, { limit = HISTORY_LIMIT, workspace = null } = {}) {
  const byShort = new Map();
  const pairingRows = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (workspace !== null && workspace !== undefined && workspace !== ""
      && entry.project !== null && entry.project !== workspace) continue;
    const detail = entry.detail ?? {};
    if (entry.event.startsWith("pairing.")) {
      // pairing без shortId: отдельная строка «привязка», только значимые
      // события (poll — шум, его в истории не показываем).
      if (entry.event === "pairing.poll") continue;
      const failed = entry.event === "pairing.error";
      const code = scalar(detail.code) ?? scalar(detail.status) ?? null;
      pairingRows.push({
        key: `pairing-${entry.ts}-${pairingRows.length}`,
        shortId: null,
        time: entry.ts,
        project: entry.project,
        transport: entry.transport,
        status: failed ? "pairing-error" : "pairing",
        statusText: historyStatusText(failed ? "pairing-error" : "pairing", { code }),
        code: code === null ? null : String(code),
        details: { transport: entry.transport, code: code === null ? null : String(code) },
      });
      continue;
    }
    if (entry.shortId === null) continue;
    const current = byShort.get(entry.shortId) ?? {
      key: entry.shortId,
      shortId: entry.shortId,
      time: entry.ts,
      project: entry.project,
      transport: entry.transport,
      status: "queued",
      statusText: historyStatusText("queued"),
      messageId: null,
      optionIds: [],
      customLength: null,
      code: null,
      reason: null,
      details: {},
    };
    if (current.project === null && entry.project !== null) current.project = entry.project;
    if (entry.transport !== null) current.transport = entry.transport;
    current.time = entry.ts;
    current.details.transport = current.transport;
    switch (entry.event) {
      case "question.send":
        current.status = "queued";
        break;
      case "question.sent":
        current.status = "delivered";
        if (scalar(detail.messageId) !== undefined) current.messageId = String(detail.messageId);
        current.details.keyboard = detail.keyboard === true;
        break;
      case "question.error": {
        current.status = "error";
        current.code = scalar(detail.code) ?? scalar(detail.status) ?? null;
        current.reason = scalar(detail.status) === "give-up" ? "give-up" : null;
        current.details.code = current.code;
        break;
      }
      case "answer.received":
        current.status = "answered";
        current.optionIds = Array.isArray(detail.optionIds) ? detail.optionIds.map(String) : [];
        current.customLength = Number.isFinite(detail.customLength) ? detail.customLength : null;
        current.details.optionIds = current.optionIds;
        current.details.customLength = current.customLength;
        break;
      case "answer.unmatched":
        current.status = "unmatched";
        current.reason = scalar(detail.reason) ?? null;
        current.details.reason = current.reason;
        break;
      case "answer.dropped":
        current.status = "cancelled";
        current.reason = scalar(detail.reason) ?? null;
        current.details.reason = current.reason;
        break;
      case "answer.from_gui":
      case "answer.from_transport":
      case "answer.settled":
        current.status = "answered";
        break;
      default:
        // неизвестное служебное событие не меняет статус вопроса
        break;
    }
    current.statusText = historyStatusText(current.status, { code: current.code, reason: current.reason });
    byShort.set(entry.shortId, current);
  }

  const all = [...byShort.values(), ...pairingRows]
    .sort((left, right) => right.time - left.time)
    .slice(0, Math.max(0, limit));
  return { rows: all, total: byShort.size + pairingRows.length };
}

/**
 * История для панели: прочитать журнал и собрать строки.
 *
 * @param logFile - путь журнала.
 * @param options - `{now, hours, limit, workspace, logger}`.
 * @returns `{rows, total, skipped, unreadable}`.
 */
export function readQuestionHistory(logFile, {
  now = Date.now(),
  hours = HISTORY_HOURS,
  limit = HISTORY_LIMIT,
  workspace = null,
  logger = () => {},
} = {}) {
  const read = readJournalEntries(logFile, { now, hours, workspace, logger });
  const history = buildQuestionHistory(read.entries, { limit, workspace });
  return {
    rows: history.rows,
    total: history.total,
    skipped: read.skipped,
    unreadable: read.unreadable,
  };
}
