/**
 * Данные панели «Удалённое управление» — чистый слой без DOM и без сети.
 *
 * Панель живёт в браузере (клиентская половина, `lib/client.js`), а состояние и
 * журнал — на хосте, в `~/.dsh/remote-control/` (`state.json`, `log.jsonl`).
 * Браузер не может читать файлы вне воркспейса, поэтому снимок для панели
 * собирает host-половина (`lib/host-channel.js`) и отдаёт его по RPC. Здесь —
 * вся логика этого снимка: чтение, нормализация, сортировка и **очистка от
 * секретов и полных путей**.
 *
 * Модуль намеренно не знает ни про cordis, ни про React: его тесты гоняют
 * функцию `panelSnapshot()` на временных файлах и на искусственном состоянии.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Сколько строк журнала показываем: у панели мало места. */
export const JOURNAL_TAIL = 20;

/** TTL вопроса по умолчанию (30 минут) — для расчёта дедлайна в снимке. */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Формы секретов, которые не должны доехать до браузера. */
const BOT_TOKEN = /(?<![0-9])(\d{6,}):([A-Za-z0-9_-]{30,})\b/g;
const API_KEY = /sk-[A-Za-z0-9_-]{16,}/g;
const BASE64_RUN = /\b[A-Za-z0-9+]{40,}={0,2}/g;
const HEX_RUN = /\b[0-9A-Fa-f]{32,}\b/g;

/** Путь от `/` (или корня диска Windows) — в панели оставляем только basename. */
const ABSOLUTE_PATH = /(?:^|[\s("'=[])((?:\/|[A-Za-z]:\\)[^\s"'()[\]{}<>,;]+)/g;

/**
 * Пути состояния и журнала по умолчанию.
 *
 * Их можно переопределить переменными окружения (`DSH_REMOTE_STATE`,
 * `DSH_REMOTE_LOG`) — так делают тесты и `bin/install-remote.sh` (задача 010).
 *
 * @param env - окружение (по умолчанию `process.env`).
 * @returns `{stateFile, logFile}`.
 */
export function defaultPaths(env = process.env) {
  const dir = path.join(os.homedir(), ".dsh", "remote-control");
  const state = env?.DSH_REMOTE_STATE;
  const log = env?.DSH_REMOTE_LOG;
  return {
    stateFile: typeof state === "string" && state !== "" ? state : path.join(dir, "state.json"),
    logFile: typeof log === "string" && log !== "" ? log : path.join(dir, "log.jsonl"),
  };
}

/** Последний сегмент пути: в панели полные пути запрещены. */
export function basenameOf(value) {
  const text = String(value ?? "");
  if (text === "") return "";
  const trimmed = text.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * Спрятать секреты и полные пути в произвольной строке.
 *
 * Путь заменяем на basename, а не на `<redacted>`: человеку в панели важно
 * видеть *какой* это проект, но не `/Users/<логин>/...`.
 *
 * @param value - строка (или что угодно, приводимое к строке).
 * @returns очищенная строка.
 */
export function sanitizeText(value) {
  let text = String(value ?? "");
  text = text.replace(BOT_TOKEN, (_match, id) => `${id}:<redacted>`);
  text = text.replace(API_KEY, "sk-<redacted>");
  text = text.replace(BASE64_RUN, (candidate) => {
    const digits = (candidate.match(/\d/g) ?? []).length;
    const strong = /[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && digits > 0;
    return strong ? "<redacted-base64>" : candidate;
  });
  text = text.replace(HEX_RUN, (candidate) => (/\d/.test(candidate) ? "<redacted-hex>" : candidate));
  text = text.replace(ABSOLUTE_PATH, (_match, absolute) => basenameOf(absolute));
  return text;
}

/**
 * Прочитать состояние плагина.
 *
 * Файла нет или он битый — это норма (панель открыта раньше, чем человек
 * привязал бота), поэтому возвращаем `null` и флаг, а не исключение.
 *
 * @param stateFile - путь к `state.json`.
 * @param logger - необязательный лог.
 * @returns `{state, unreadable}`.
 */
export function readState(stateFile, logger = () => {}) {
  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") logger(`панель: состояние не прочитано (${error?.message ?? error})`);
    return { state: null, unreadable: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { state: null, unreadable: true };
    }
    return { state: parsed, unreadable: false };
  } catch {
    return { state: null, unreadable: true };
  }
}

/**
 * Привести состояние к форме, на которую опирается панель.
 *
 * Ключей может не быть: состояние заполняют разные задачи (005 — привязка и
 * режим, 008 — очередь и открытые вопросы). Панель не должна падать от того,
 * что какая-то половина ещё не влита.
 *
 * @param state - прочитанный объект (или null).
 * @returns нормализованный снимок.
 */
export function normalizeState(state) {
  const source = state !== null && typeof state === "object" ? state : {};
  const bindings = source.bindings !== null && typeof source.bindings === "object" ? source.bindings : null;
  const enabled = source.enabled !== null && typeof source.enabled === "object" ? source.enabled : {};
  const workspaces = enabled.workspaces !== null && typeof enabled.workspaces === "object" ? enabled.workspaces : {};
  const sessions = enabled.sessions !== null && typeof enabled.sessions === "object" ? enabled.sessions : {};
  const questions = Array.isArray(source.questions) ? source.questions : [];

  return {
    binding: bindings === null
      ? null
      : {
        transport: String(bindings.transport ?? "telegram"),
        chatId: bindings.chatId ?? null,
        userId: bindings.userId ?? null,
        botUsername: typeof bindings.botUsername === "string" ? bindings.botUsername : null,
        createdAt: Number.isFinite(bindings.createdAt) ? bindings.createdAt : null,
      },
    enabled: {
      global: enabled.global === true,
      workspaces: Object.keys(workspaces).filter((key) => workspaces[key] === true).map(basenameOf),
      sessions: Object.keys(sessions).filter((key) => sessions[key] === true),
    },
    questions: questions
      .filter((question) => question !== null
        && typeof question === "object"
        && typeof question.shortId === "string"
        && /^[0-9a-f]{8}$/.test(question.shortId))
      .map((question) => ({
        shortId: question.shortId,
        sessionId: typeof question.sessionId === "string" ? question.sessionId : null,
        taskId: typeof question.taskId === "string" ? question.taskId : null,
        role: typeof question.role === "string" ? question.role : null,
        workspace: typeof question.workspace === "string" ? basenameOf(question.workspace) : null,
        createdAt: Number.isFinite(question.createdAt) ? question.createdAt : null,
      })),
  };
}

/**
 * Дедлайн вопроса: явный `expiresAt` или `createdAt + ttl`.
 *
 * @param question - нормализованный вопрос.
 * @param ttlMs - TTL по умолчанию.
 * @returns метка времени или `null`.
 */
export function deadlineOf(question, ttlMs = DEFAULT_TTL_MS) {
  if (Number.isFinite(question?.expiresAt)) return question.expiresAt;
  if (Number.isFinite(question?.createdAt)) return question.createdAt + ttlMs;
  return null;
}

/**
 * Отсортировать вопросы по дедлайну: сначала те, что истекают раньше.
 *
 * Вопросы без дедлайна — в конце: панель не должна прятать «горящие» из-за них.
 *
 * @param questions - список вопросов.
 * @param ttlMs - TTL по умолчанию.
 * @returns новый отсортированный список.
 */
export function sortQuestionsByDeadline(questions, ttlMs = DEFAULT_TTL_MS) {
  return [...(Array.isArray(questions) ? questions : [])]
    .map((question) => ({ ...question, deadlineAt: deadlineOf(question, ttlMs) }))
    .sort((left, right) => {
      const a = Number.isFinite(left.deadlineAt) ? left.deadlineAt : Number.POSITIVE_INFINITY;
      const b = Number.isFinite(right.deadlineAt) ? right.deadlineAt : Number.POSITIVE_INFINITY;
      if (a !== b) return a - b;
      return String(left.shortId).localeCompare(String(right.shortId));
    });
}

/**
 * Хвост журнала: последние строки, очищенные от секретов и путей.
 *
 * Журнал — `jsonl`; показываем компактную строку `время событие shortId`, а
 * неизвестные форматы — как есть (очищенными). Ошибки чтения не фатальны.
 *
 * @param logFile - путь к `log.jsonl`.
 * @param options - `{limit, logger}`.
 * @returns `{lines, unreadable}`.
 */
export function readJournalTail(logFile, { limit = JOURNAL_TAIL, logger = () => {} } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(logFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") logger(`панель: журнал не прочитан (${error?.message ?? error})`);
    return { lines: [], unreadable: true };
  }
  const all = raw.split("\n").filter((line) => line.trim() !== "");
  const tail = all.slice(-Math.max(1, limit));
  const lines = tail.map((line) => {
    try {
      const entry = JSON.parse(line);
      if (entry === null || typeof entry !== "object") return sanitizeText(line);
      const time = typeof entry.time === "string" ? entry.time : typeof entry.at === "string" ? entry.at : "";
      const parts = [time, entry.event, entry.shortId].filter((part) => typeof part === "string" && part !== "");
      return sanitizeText(parts.length > 0 ? parts.join(" ") : line);
    } catch {
      return sanitizeText(line);
    }
  });
  return { lines, unreadable: false };
}

/**
 * Статус для панели: привязка, режим и канал.
 *
 * `channel` — есть ли живой транспорт в этой же сборке: фича telegram (004)
 * пишет его в сервис `remoteTransport`, а без привязки он спит. Панель честно
 * говорит «канала нет», а не «включено».
 *
 * @param options - `{state, channelPresent, settings}`.
 * @returns `{binding, enabled, channel, configChannel}`.
 */
export function describeStatus({ state = null, channelPresent = false, settings = {} } = {}) {
  const normalized = normalizeState(state);
  const configChat = settings?.telegram?.chatId;
  return {
    binding: normalized.binding,
    enabled: normalized.enabled,
    channel: channelPresent === true,
    configChannel: configChat !== undefined && configChat !== null,
  };
}

/**
 * Снимок для панели: всё, что нужно одному обновлению.
 *
 * @param options - `{stateFile, logFile, now, ttlMs, channelPresent, settings, logger, limit}`.
 * @returns `{ok, generatedAt, status, questions, journal}`.
 */
export function panelSnapshot({
  stateFile,
  logFile,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  channelPresent = false,
  settings = {},
  logger = () => {},
  limit = JOURNAL_TAIL,
} = {}) {
  const { state, unreadable } = readState(stateFile, logger);
  const normalized = normalizeState(state);
  const questions = sortQuestionsByDeadline(normalized.questions, ttlMs);
  const journal = readJournalTail(logFile, { limit, logger });

  return {
    ok: true,
    generatedAt: now(),
    status: {
      ...describeStatus({ state, channelPresent, settings }),
      unreadable,
    },
    questions,
    journal: {
      lines: journal.lines,
      unreadable: journal.unreadable,
    },
  };
}
