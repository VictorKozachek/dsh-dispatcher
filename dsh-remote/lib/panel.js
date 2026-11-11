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
        // Кастомный TTL приходит из вопроса: без expiresAt deadline всегда
        // считался бы как createdAt + 30 минут.
        expiresAt: Number.isFinite(question.expiresAt) ? question.expiresAt : undefined,
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

/** Колонки доски, которые панель показывает в сводке (045). */
export const BOARD_STATUSES = Object.freeze(["in-progress", "in-review", "testing", "ready", "blocked"]);

/** Через сколько минут карточка считается залипшей у роли (045). */
export const DEFAULT_STALE_MINUTES = 30;

/** Статусы, в которых карточка «висит у роли» и может залипнуть. */
const STALE_STATUSES = new Set(["in-progress", "in-review", "testing", "ready"]);

/** Разобрать YAML-подобный фронт-маттер карточки (только простые `key: value`). */
export function parseCardFrontMatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (match === null) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (entry === null) continue;
    let value = entry[2].trim();
    if (value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    result[entry[1]] = value;
  }
  return result;
}

/** Метка времени из ISO/числа; null, если не разобрать. */
function timeOf(value) {
  if (Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Числовое поле токенов; мусор — 0. */
function numberOrZero(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string" || value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Прочитать карточки одного воркспейса: `.kanban/tasks/*.md`.
 *
 * Только чтение: панель ничего не двигает и не пишет (045). Нет каталога или
 * файлы битые — это не ошибка, а `missing`/пропуск.
 */
export function readBoardCards(workspaceRoot, { logger = () => {} } = {}) {
  const root = typeof workspaceRoot === "string" && workspaceRoot !== "" ? workspaceRoot : null;
  if (root === null) return { missing: true, cards: [] };
  const dir = path.join(root, ".kanban", "tasks");
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".md") && !name.startsWith("."));
  } catch (error) {
    if (error?.code !== "ENOENT") logger(`панель: доска ${basenameOf(root)} не прочитана (${error?.message ?? error})`);
    return { missing: true, cards: [] };
  }
  const cards = [];
  for (const name of names) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch (error) {
      logger(`панель: карточка ${name} не прочитана (${error?.message ?? error})`);
      continue;
    }
    const front = parseCardFrontMatter(text);
    const id = typeof front.id === "string" && front.id !== "" ? front.id : name.replace(/\.md$/, "");
    const status = typeof front.status === "string" ? front.status : "";
    const tokens = numberOrZero(front.tokens);
    const tokensByRole = {};
    for (const [key, value] of Object.entries(front)) {
      if (!key.startsWith("tokens_")) continue;
      const amount = numberOrZero(value);
      if (amount > 0) tokensByRole[key.slice("tokens_".length)] = amount;
    }
    cards.push({
      id,
      title: typeof front.title === "string" ? sanitizeText(front.title) : "",
      status,
      role: typeof front.role === "string" ? front.role : "",
      owner: typeof front.owner === "string" ? front.owner : "",
      updated: timeOf(front.updated),
      since: timeOf(front.since),
      tokens,
      tokensByRole,
    });
  }
  return { missing: false, cards };
}

/**
 * Сводка по одному воркспейсу: счётчики по колонкам, залипшие карточки и
 * расход токенов. Пути наружу не отдаются — только basename воркспейса.
 */
export function boardSummary(workspaceRoot, { now = () => Date.now(), staleMinutes = DEFAULT_STALE_MINUTES, logger = () => {} } = {}) {
  const { missing, cards } = readBoardCards(workspaceRoot, { logger });
  const counts = Object.fromEntries(BOARD_STATUSES.map((status) => [status, 0]));
  const stale = [];
  const tasks = [];
  let total = 0;
  let today = 0;
  let week = 0;
  const current = now();
  const todayStart = new Date(current);
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = current - 7 * 24 * 60 * 60 * 1000;
  for (const card of cards) {
    if (Object.hasOwn(counts, card.status)) counts[card.status] += 1;
    const tokens = card.tokens > 0
      ? card.tokens
      : Object.values(card.tokensByRole).reduce((sum, value) => sum + value, 0);
    total += tokens;
    if (card.updated !== null) {
      if (card.updated >= todayStart.getTime()) today += tokens;
      if (card.updated >= weekStart) week += tokens;
    }
    if (tokens > 0) {
      tasks.push({
        id: card.id,
        title: card.title,
        status: card.status,
        role: card.role,
        updated: card.updated,
        tokens,
        tokensByRole: card.tokensByRole,
      });
    }
    if (!STALE_STATUSES.has(card.status)) continue;
    const startedAt = card.since ?? card.updated;
    if (startedAt === null) continue;
    const ageMinutes = Math.floor(Math.max(0, current - startedAt) / 60000);
    if (ageMinutes < staleMinutes) continue;
    stale.push({
      id: card.id,
      title: card.title,
      status: card.status,
      role: card.role,
      since: startedAt,
      ageMinutes,
    });
  }
  stale.sort((left, right) => right.ageMinutes - left.ageMinutes);
  tasks.sort((left, right) => right.tokens - left.tokens);
  return {
    name: basenameOf(workspaceRoot),
    missing,
    counts,
    stale,
    spend: {
      tasks,
      total,
      today,
      week,
    },
  };
}

/**
 * Доска и расход по нескольким воркспейсам. Сумма токенов — по фронт-маттеру
 * карточек (`tokens`, `tokens_<роль>`); «сегодня»/«неделя» — по `updated`
 * карточки, без новых файлов и без обращения к метрикам.
 */
export function collectBoard({ workspaces = [], now = () => Date.now(), staleMinutes = DEFAULT_STALE_MINUTES, logger = () => {} } = {}) {
  const roots = [...new Set((Array.isArray(workspaces) ? workspaces : [])
    .filter((root) => typeof root === "string" && root.trim() !== ""))];
  const summaries = roots.map((root) => boardSummary(root, { now, staleMinutes, logger }));
  const spend = { tasks: [], total: 0, today: 0, week: 0 };
  for (const summary of summaries) {
    for (const task of summary.spend.tasks) {
      spend.tasks.push({ ...task, workspace: summary.name });
    }
    spend.total += summary.spend.total;
    spend.today += summary.spend.today;
    spend.week += summary.spend.week;
  }
  spend.tasks.sort((left, right) => right.tokens - left.tokens);
  return {
    board: {
      staleMinutes,
      available: summaries.some((summary) => !summary.missing),
      workspaces: summaries.map((summary) => ({
        name: summary.name,
        missing: summary.missing,
        counts: summary.counts,
        stale: summary.stale,
      })),
    },
    spend,
  };
}

/** Воркспейсы для доски: явные, из настроек, из состояния; при желании — cwd. */
function boardRoots({ workspaces, settings, state, includeCwd }) {
  if (Array.isArray(workspaces)) {
    return workspaces.filter((root) => typeof root === "string" && root.trim() !== "");
  }
  for (const candidate of [settings?.boards, settings?.workspaces]) {
    if (Array.isArray(candidate)) {
      const roots = candidate.filter((root) => typeof root === "string" && root.trim() !== "");
      if (roots.length > 0) return roots;
    }
  }
  const enabled = state?.enabled !== null && typeof state?.enabled === "object" ? state.enabled : null;
  const map = enabled?.workspaces !== null && typeof enabled?.workspaces === "object" ? enabled.workspaces : null;
  const fromState = map === null ? [] : Object.keys(map).filter((root) => root.trim() !== "");
  if (fromState.length > 0) return fromState;
  return includeCwd === true ? [process.cwd()] : [];
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
  workspaces = undefined,
  staleMinutes = DEFAULT_STALE_MINUTES,
  includeCwd = false,
  metrics = null,
} = {}) {
  const { state, unreadable } = readState(stateFile, logger);
  const normalized = normalizeState(state);
  const questions = sortQuestionsByDeadline(normalized.questions, ttlMs);
  const journal = readJournalTail(logFile, { limit, logger });
  const boardData = collectBoard({
    workspaces: boardRoots({ workspaces, settings, state, includeCwd }),
    now,
    staleMinutes,
    logger,
  });

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
    board: boardData.board,
    spend: {
      ...boardData.spend,
      // 031: числовые метрики рантайма (вопросы/доставки/латентность). Токенов
      // в них нет — расход по задачам считается по фронт-маттеру карточек.
      ...(metrics !== null && typeof metrics === "object" ? { metrics } : {}),
    },
  };
}
