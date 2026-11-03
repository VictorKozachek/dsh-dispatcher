/**
 * Представление вопроса: шапка «откуда он», тело и ряды кнопок.
 *
 * Сообщение в мессенджере должно быть самоидентифицируемым: в чате может быть
 * несколько сессий и вопросов одновременно, поэтому первая строка говорит
 * «откуда» — воркспейс, задача, роль, время и дедлайн
 * (`docs/CONCEPT.md` §5.2):
 *
 * ```
 * ▸ dsh-dispatcher · task 007 · worker · 17:41 · до 18:11
 *
 * Удалить ветку task/007 после слияния?
 *
 * [ Да, удалить ] [ Оставить ]
 * [ Другой ответ… ]
 * ```
 *
 * Здесь нет ни транспорта, ни DSH-сервисов: только чистое чтение контекста
 * сессии и раскладка строк под `caps`. Карточки `.kanban/tasks` **только
 * читаются** — представление не имеет права ничего менять на диске.
 */

import fs from "node:fs";
import path from "node:path";

import { DEFAULT_CAPS } from "./transport/base.js";

/** Кнопка свободного ответа: переключает вопрос в режим ожидания текста. */
export const FREE_TEXT_LABEL = "Другой ответ…";

/** Кнопка «вариантов больше, чем влезает» — раскрывает остальные. */
export const MORE_LABEL = "Показать ещё";

/** `optionId` кнопки свободного ответа в `callback_data`. */
export const FREE_TEXT_OPTION = "free";

/** `optionId` кнопки «Показать ещё» в `callback_data`. */
export const MORE_OPTION = "more";

/** Подсказка для multiSelect: одна кнопка-тумблер на вариант. */
export const MULTISELECT_HINT = "Можно выбрать несколько вариантов.";

/** Маркер усечения: честно говорит, что текст не влез целиком. */
export const TRUNCATION_MARKER = "…обрезано";

/** Предел длины имени воркспейса в шапке. */
export const WORKSPACE_LIMIT = 32;

const noop = () => {};

/** Локальное время `ЧЧ:ММ` (зона машины, без локалей и Intl). */
export function formatTime(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * `17:41 · до 18:11` — начало и дедлайн вопроса.
 *
 * Без дедлайна остаётся только время: «до …» не врём.
 */
export function renderClock(now = Date.now(), expiresAt = null) {
  const started = formatTime(now);
  if (!Number.isFinite(expiresAt)) return started;
  return `${started} · до ${formatTime(expiresAt)}`;
}

/** Усечь до `limit` символов, не разрезая суррогатную пару. */
export function truncate(text, limit, marker = "…") {
  const source = String(text ?? "");
  const max = Math.floor(Number(limit));
  if (!Number.isFinite(max) || max <= 0) return "";
  if (source.length <= max) return source;
  const room = max - marker.length;
  if (room <= 0) return marker.slice(0, max);
  let head = source.slice(0, room);
  // Не оставляем «половину» эмодзи на конце: обрезаем до последнего целого code point.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}${marker}`;
}

/** Прочитать поле front matter (между первыми `---`); нет поля — null. */
export function frontMatterField(text, field) {
  const source = typeof text === "string" ? text : "";
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const pattern = new RegExp(`^${field}:[ \\t]*(.*)$`);
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") break;
    const match = pattern.exec(line);
    if (match === null) continue;
    // Убираем комментарий и обрамляющие кавычки: `owner: "s1"  # кто ведёт`.
    const value = match[1].replace(/\s+#.*$/, "").trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    return value;
  }
  return null;
}

/**
 * Найти карточку в `.kanban/tasks` каталога, которую ведёт эта сессия.
 *
 * Только чтение: каталога нет, файл не читается, битый front matter — тихо
 * возвращаем null. Ошибки представления не должны ломать вопрос.
 */
/** Источники карточек: cwd сессии и рабочие деревья проекта (root/worktree). */
function taskDirs(cwd) {
  const dirs = [path.join(cwd, ".kanban", "tasks")];
  for (const worktrees of ["worktrees", ".worktrees"]) {
    const root = path.join(cwd, worktrees);
    let entries;
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = path.join(root, name, ".kanban", "tasks");
      try {
        if (fs.statSync(dir).isDirectory()) dirs.push(dir);
      } catch {
        /* нет доски в этом дереве */
      }
    }
  }
  return dirs;
}

/** Насколько карточка «активна»: чем больше, тем ближе к текущей задаче. */
const STATUS_RANK = { "in-progress": 60, testing: 50, "in-review": 40, ready: 30, todo: 20, backlog: 10, blocked: 5 };

/**
 * Найти карточку, которую сейчас ведёт эта сессия.
 *
 * Смотрим не только `.kanban/tasks` в cwd, но и доски рабочих деревьев проекта:
 * сессия роли живёт в корне, а карточка задачи — в `worktrees/<id>`. Из нескольких
 * своих карточек выбираем **активную**: `in-progress` важнее `todo`, при равенстве
 * берём более поздний id (только что выданную). `merged` не считаем вовсе — иначе
 * хвост из слитых карточек с тем же owner («001» вместо «006») закрывал бы текущую.
 */
export function findOwnedTask(cwd, sessionId, { log = noop } = {}) {
  if (typeof cwd !== "string" || cwd === "" || typeof sessionId !== "string" || sessionId === "") {
    return null;
  }

  const best = { rank: -1, id: null };

  for (const tasksDir of taskDirs(cwd)) {
    let entries;
    try {
      entries = fs.readdirSync(tasksDir);
    } catch {
      continue; // нет каталога доски — просто нет задачи
    }
    for (const name of entries.filter((entry) => entry.endsWith(".md") && entry !== "README.md")) {
      let text;
      try {
        text = fs.readFileSync(path.join(tasksDir, name), "utf8");
      } catch (error) {
        log(`карточка ${name} не прочиталась: ${error?.message ?? error}`);
        continue;
      }
      if (frontMatterField(text, "owner") !== sessionId) continue;
      const status = frontMatterField(text, "status") ?? "";
      if (status === "merged") continue;
      const id = frontMatterField(text, "id") ?? name.replace(/\.md$/, "");
      const rank = STATUS_RANK[status] ?? 0;
      // При равенстве выигрывает более поздний id (свежая задача).
      if (rank > best.rank || (rank === best.rank && id > (best.id ?? ""))) {
        best.rank = rank;
        best.id = id;
      }
    }
  }

  return best.id;
}

/**
 * Контекст сессии для шапки.
 *
 * `workspace` — имя каталога (`basename(cwd)`), `role` — `agentPreset` шапки,
 * `taskId` — карточка доски в `cwd`, у которой `owner` — эта сессия.
 *
 * @returns {{sessionId: string|null, workspace: string|null, cwd: string|null, role: string|null, taskId: string|null}}
 */
export function resolveContext({ sessionId, ctx, log = noop } = {}) {
  const context = {
    sessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : null,
    workspace: null,
    cwd: null,
    role: null,
    taskId: null,
  };
  if (context.sessionId === null) return context;

  let session = null;
  try {
    session = ctx?.get?.("sessions")?.get?.(context.sessionId) ?? null;
  } catch (error) {
    log(`sessions.get(${context.sessionId}): ${error?.message ?? error}`);
    return context;
  }

  const header = session?.header ?? null;
  const cwd = typeof header?.cwd === "string" && header.cwd !== "" ? header.cwd : null;
  context.cwd = cwd;
  context.workspace = cwd === null ? null : path.basename(cwd);
  context.role = typeof header?.agentPreset === "string" && header.agentPreset !== ""
    ? header.agentPreset
    : null;
  context.taskId = findOwnedTask(cwd, context.sessionId, { log });
  return context;
}

/**
 * Первая строка сообщения: `▸ воркспейс · task NN · роль · время · до дедлайна`.
 *
 * Порядок и разделители — как в `docs/CONCEPT.md` §5.2; чего не знаем, того не
 * печатаем (без задачи — без сегмента «task»). Слишком длинное имя воркспейса
 * усекается до {@link WORKSPACE_LIMIT} символов.
 */
export function renderHeader(context = {}) {
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const expiresAt = Number.isFinite(context.expiresAt) ? context.expiresAt : null;
  const segments = [];

  const workspace = typeof context.workspace === "string" && context.workspace !== ""
    ? truncate(context.workspace, WORKSPACE_LIMIT)
    : null;
  if (workspace !== null) segments.push(workspace);
  const taskId = context.taskId === null || context.taskId === undefined ? "" : String(context.taskId);
  if (taskId !== "") segments.push(`task ${taskId}`);
  const role = typeof context.role === "string" && context.role !== "" ? truncate(context.role, WORKSPACE_LIMIT) : null;
  if (role !== null) segments.push(role);
  segments.push(renderClock(now, expiresAt));

  return `▸ ${segments.join(" · ")}`;
}

/**
 * Текст сообщения: шапка, пустая строка, тело вопроса, подсказка multiSelect.
 *
 * Строка целиком укладывается в `caps.maxText`; если не влезает — усечение с
 * маркером «…обрезано» (лучше честный хвост, чем молча потерянный текст).
 */
export function renderBody(question = {}, caps = {}) {
  const maxText = Number.isFinite(caps.maxText) ? caps.maxText : DEFAULT_CAPS.maxText;
  const now = Number.isFinite(question.createdAt) ? question.createdAt : Date.now();
  const cwd = typeof question.workspace === "string" && question.workspace !== "" ? question.workspace : null;

  const header = renderHeader({
    workspace: cwd === null ? null : path.basename(cwd),
    taskId: question.taskId ?? null,
    role: question.role ?? null,
    now,
    expiresAt: question.expiresAt ?? null,
  });

  const parts = [header, ""];
  const title = typeof question.title === "string" ? question.title.trim() : "";
  if (title !== "") parts.push(title, "");
  const detail = typeof question.detail === "string" ? question.detail.trim() : "";
  const rawBody = String(question.body ?? "");
  // Пустое тело без заголовка/подробностей — не молчание: честная заглушка,
  // иначе сообщение выглядело бы пустым.
  parts.push(rawBody.trim() !== "" || title !== "" || detail !== "" ? rawBody : "(пустой вопрос)");
  if (detail !== "") parts.push("", detail);
  if (question.multiSelect === true) parts.push("", MULTISELECT_HINT);
  return truncate(parts.join("\n"), maxText, TRUNCATION_MARKER);
}

/**
 * Ряды кнопок: вариант — одна кнопка на строку, «Другой ответ…» последним.
 *
 * Если вариантов больше, чем влезает в сообщение вместе с «Другой ответ…» и
 * «Показать ещё», показываем первые и добавляем «Показать ещё»: прятать
 * варианты насовсем нельзя, человек должен видеть, что они есть.
 *
 * Каждая кнопка — `{ label, kind: 'option' | 'more' | 'free', optionId? }`:
 * `kind` нужен транспорту и роутингу (007), чтобы отличить вариант от режима
 * свободного текста.
 */
export function renderRows(question = {}, caps = {}) {
  const maxOptions = Math.max(
    0,
    Math.floor(Number.isFinite(caps.maxOptions) ? caps.maxOptions : DEFAULT_CAPS.maxOptions),
  );
  if (maxOptions === 0) return [];

  const options = Array.isArray(question.options) ? question.options : [];
  const allowFree = question.allowFreeText !== false;
  const labelLimit = Number.isFinite(caps.maxText) ? Math.min(64, caps.maxText) : 64;
  const rows = [];

  // Один ряд резервируем под «Другой ответ…»; «Показать ещё» — только если
  // варианты не влезают, и тоже ценой одного ряда.
  let room = Math.max(0, maxOptions - (allowFree ? 1 : 0));
  let more = options.length > room;
  if (more) {
    const afterMore = Math.max(0, room - 1);
    // Если после ряда «Показать ещё» не остаётся ни одного варианта — раскрывать
    // нечего: показываем первый вариант вместо бессмысленной кнопки.
    if (afterMore === 0 && room > 0) more = false;
    else room = afterMore;
  }

  for (const option of options.slice(0, room)) {
    rows.push([{ label: truncate(option?.label ?? "", labelLimit), kind: "option", optionId: option?.id ?? null }]);
  }
  if (more && options.length > room) {
    rows.push([{ label: MORE_LABEL, kind: "more", optionId: MORE_OPTION }]);
  }
  if (allowFree) rows.push([{ label: FREE_TEXT_LABEL, kind: "free", optionId: FREE_TEXT_OPTION }]);

  // Жёсткая гарантия лимита: если рядов всё же больше, первым уходит «Показать
  // ещё» (раскрытие — не ответ), потом лишние варианты; свободный ответ остаётся.
  if (rows.length > maxOptions) {
    const moreIndex = rows.findIndex((row) => row[0]?.kind === "more");
    if (moreIndex >= 0) rows.splice(moreIndex, 1);
    while (rows.length > maxOptions) rows.pop();
  }
  return rows;
}
