/**
 * Чтение рабочего журнала для панели (задача 070).
 *
 * `log.jsonl` пишет `lib/journal.js` (051): одна JSON-строка на событие, формат
 * `{ts, level, event, transport?, shortId?, detail?}`; `detail` — JSON-строка
 * (так его пишет `journal.js`). Здесь — только чтение: разбор строк, склейка
 * событий по `shortId` в историю вопроса и фильтр по времени. Модуль не пишет ни
 * в журнал, ни в состояние и не импортирует транспорт/ответчик — панель должна
 * оставаться read-only.
 *
 * Приватность: тексты ответов в журнал не попадают, в истории остаются
 * `customLength`, идентификаторы вариантов и коды/причины, а не сообщения и
 * токены.
 *
 * Ограничение по проекту: 051 не пишет в событие ни `project`, ни `workspace`,
 * поэтому фильтра по проекту здесь нет — он был бы пустым обещанием (все
 * реальные события имеют `project: null`). Поле читается, если событие его
 * когда-нибудь получит, и тогда просто показывается в строке, но не фильтрует.
 */

import fs from "node:fs";

import { DEFAULT_KEEP } from "./rotate.js";

/** Сколько часов истории показываем по умолчанию. */
export const HISTORY_HOURS = 24;

/** Сколько строк истории отдаём по умолчанию. */
export const HISTORY_LIMIT = 20;

/** Сколько ротированных файлов (`log.jsonl.N`) читаем: столько же, сколько держит rotate.js. */
export const HISTORY_ROTATED = DEFAULT_KEEP;

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
 * Код ошибки доставки.
 *
 * `answerer.js` для ошибок транспорта пишет `code: ""` (пустая строка) и
 * числовой `status` — поэтому пустой код заменяем статусом, иначе панель
 * показывала бы «ошибка доставки ()». Нет ни кода, ни статуса — `null`, и
 * подпись остаётся без скобок.
 */
function errorCodeOf(detail) {
  const code = scalar(detail.code);
  if (code !== undefined && code !== null && String(code).trim() !== "") return String(code).trim();
  const status = scalar(detail.status);
  if (status !== undefined && status !== null) {
    const text = String(status).trim();
    // `status: 0` — «HTTP-кода нет» (так answerer пишет неизвестную ошибку),
    // скобки «ошибка доставки (0)» были бы шумом.
    if (text !== "" && text !== "0") return text;
  }
  return null;
}

/**
 * Прочитать строки журнала.
 *
 * Ротация держит `.1`…`.N` (`rotate.js`, `DEFAULT_KEEP`), поэтому читаем все
 * существующие `.N` от старых к свежим, затем сам `log.jsonl`: иначе при
 * большом журнале часть окна 24 часов терялась бы. Битые строки не роняют
 * чтение — они считаются в `skipped`.
 *
 * @param logFile - путь `log.jsonl`.
 * @param options - `{now, hours, rotated, logger}`.
 * @returns `{entries, skipped, files, unreadable}`; `files` — реально прочитанные.
 */
export function readJournalEntries(logFile, {
  now = Date.now(),
  hours = HISTORY_HOURS,
  rotated = HISTORY_ROTATED,
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
  const cutoff = now - Math.max(1, hours) * 60 * 60 * 1000;
  const depth = Number.isFinite(rotated) ? Math.max(0, Math.floor(rotated)) : HISTORY_ROTATED;
  const candidates = [];
  for (let index = depth; index >= 1; index -= 1) candidates.push(`${logFile}.${index}`);
  candidates.push(logFile);

  const files = [];
  for (const file of candidates) {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      // Отсутствие файла — норма: `.N` могли ещё не создать, а сам журнал
      // плагин пока не писал.
      if (error?.code !== "ENOENT") {
        failed = true;
        logger(`история: ${file} не прочитан (${error?.message ?? error})`);
      }
      continue;
    }
    files.push(file);
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
      entries.push({
        ts,
        event: typeof entry.event === "string" ? entry.event : "unknown",
        transport: typeof entry.transport === "string" ? entry.transport : null,
        shortId: typeof entry.shortId === "string" && entry.shortId !== "" ? entry.shortId : null,
        level: typeof entry.level === "string" ? entry.level : "info",
        project: projectOf(entry, detail),
        detail,
      });
    }
  }

  entries.sort((left, right) => left.ts - right.ts);
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

/** Закрытие, которым вопрос отвечен: причина начинается с `answered-in-`. */
function isAnsweredClose(reason) {
  return typeof reason === "string" && reason.startsWith("answered-in-");
}

/** Пометка к строке: ответ пришёл, но не пошёл в дело (повтор/notify/gui). */
function droppedNote(reason) {
  if (reason === "already-answered") return { code: "repeat", reason };
  return { code: "dropped", reason: reason ?? null };
}

/**
 * Склеить историю вопросов по `shortId`.
 *
 * Последнее значимое событие задаёт статус, детали накапливаются (messageId,
 * optionIds, customLength, code/reason). Правила статуса (важны на живом
 * журнале — 070):
 *
 * - `answer.received` → «отвечен»; окончательный ответ (`answer.from_transport`,
 *   `answer.from_gui`, `answer.settled`, `question.closed(answered-in-*)`)
 *   закрепляет его: ни `answer.dropped`, ни `answer.unmatched` его не понижают;
 * - `answer.dropped` статус **не меняет** (это повторный клик/notify/gui-ответ,
 *   уже отвеченный вопрос он не превращает в «снят»), остаётся пометка
 *   `note: {code: "repeat"|"dropped", reason}`;
 * - `answer.unmatched` → «не сопоставлен (причина)» — ответ пришёл, но не
 *   сопоставился (до окончательного ответа это честный статус);
 * - «снят» — только `question.closed` с причиной снятия/аборта (`aborted`,
 *   `expired`, `undelivered`, `send-failed`, …).
 *
 * Строки сортируются по времени последнего события (свежие сверху),
 * ограничиваются `limit`.
 *
 * @param entries - результат `readJournalEntries().entries` или свой список.
 * @param options - `{limit, workspace}`; `workspace` — basename проекта (076).
 * @returns `{rows, total}`.
 */
export function buildQuestionHistory(entries, { limit = HISTORY_LIMIT, workspace = null } = {}) {
  const byShort = new Map();
  const pairingRows = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
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
      project: null,
      transport: null,
      status: "queued",
      statusText: historyStatusText("queued"),
      messageId: null,
      optionIds: [],
      customLength: null,
      code: null,
      reason: null,
      note: null,
      // Окончательный ответ получен (from_transport/from_gui/settled/closed):
      // поздние служебные события его больше не перебивают.
      accepted: false,
      details: {},
    };
    if (current.project === null && entry.project !== null) current.project = entry.project;
    if (entry.transport !== null) current.transport = entry.transport;
    current.time = entry.ts;
    current.details.transport = current.transport;

    switch (entry.event) {
      case "question.send":
        // Повторная отправка (после ошибки) снова «отправляется», но уже
        // решённый вопрос назад не откатываем.
        if (current.status !== "answered" && current.status !== "cancelled") {
          current.status = "queued";
        }
        break;
      case "question.sent":
        if (current.status !== "answered" && current.status !== "cancelled") {
          current.status = "delivered";
        }
        if (scalar(detail.messageId) !== undefined) current.messageId = String(detail.messageId);
        current.details.keyboard = detail.keyboard === true;
        break;
      case "question.error": {
        const code = errorCodeOf(detail);
        // Ошибка закрытия сообщения (после ответа) — не ошибка доставки:
        // статус не меняем, оставляем пометку.
        if (code === "close-failed") {
          current.note = { code: "close", reason: "close-failed" };
          break;
        }
        if (current.accepted === true) break;
        current.status = "error";
        current.code = code;
        current.reason = null;
        current.details.code = code;
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
        // Ответ не сопоставился: до окончательного ответа это честный статус;
        // принятый ответ unmatched уже не понижает.
        if (current.accepted === true) break;
        current.status = "unmatched";
        current.reason = scalar(detail.reason) ?? null;
        current.details.reason = current.reason;
        break;
      case "answer.dropped":
        // Ответ пришёл, но не пошёл в дело (повторный клик, notify, gui).
        // Статус не меняем: уже отвеченный вопрос не превращается в «снят».
        current.note = droppedNote(scalar(detail.reason) ?? null);
        if (scalar(detail.source) !== undefined) current.details.noteSource = String(detail.source);
        break;
      case "answer.from_gui":
      case "answer.from_transport":
      case "answer.settled":
        current.status = "answered";
        current.accepted = true;
        break;
      case "question.closed": {
        const reason = scalar(detail.reason) ?? null;
        if (isAnsweredClose(reason)) {
          current.status = "answered";
          current.accepted = true;
          current.reason = null;
        } else if (current.accepted !== true) {
          // «Снят» — только здесь: вопрос закрыт без ответа (аборт, TTL,
          // недоставка, ошибка отправки).
          current.status = "cancelled";
          current.reason = reason;
          current.details.reason = reason;
        }
        break;
      }
      default:
        // неизвестное служебное событие не меняет статус вопроса
        break;
    }
    current.statusText = historyStatusText(current.status, { code: current.code, reason: current.reason });
    byShort.set(entry.shortId, current);
  }

  const all = [...byShort.values(), ...pairingRows]
    .sort((left, right) => right.time - left.time);
  // 076: фильтр по проекту — реальные данные, событие несёт `workspace`
  // (basename). Строки без проекта при фильтре не угадываем.
  const filtered = workspace === null || workspace === ""
    ? all
    : all.filter((row) => row.project === workspace);
  return {
    rows: filtered.slice(0, Math.max(0, limit)),
    total: filtered.length,
  };
}

/**
 * История для панели: прочитать журнал и собрать строки.
 *
 * @param logFile - путь журнала.
 * @param options - `{now, hours, limit, rotated, logger}`.
 * @returns `{rows, total, skipped, unreadable}`.
 */
export function readQuestionHistory(logFile, {
  now = Date.now(),
  hours = HISTORY_HOURS,
  limit = HISTORY_LIMIT,
  rotated = HISTORY_ROTATED,
  logger = () => {},
  workspace = null,
} = {}) {
  const read = readJournalEntries(logFile, { now, hours, rotated, logger });
  const history = buildQuestionHistory(read.entries, { limit, workspace });
  return {
    rows: history.rows,
    total: history.total,
    skipped: read.skipped,
    unreadable: read.unreadable,
  };
}
