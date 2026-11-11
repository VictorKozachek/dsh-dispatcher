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
import { normalizeQuickReplies } from "./quick-replies.js";
import { DEFAULT_LANG, normalizeLang, t } from "./i18n.js";

/** `optionId` кнопки свободного ответа в `callback_data`. */
export const FREE_TEXT_OPTION = "free";

/** `optionId` кнопки «Показать ещё» в `callback_data`. */
export const MORE_OPTION = "more";

/** 047: значок ссылки на задачу/дерево в подсказке (языконезависим). */
export const TASK_LINK_PREFIX = "🔗";

/** Предел длины имени воркспейса в шапке. */
export const WORKSPACE_LIMIT = 32;

/**
 * 047: предел всей шапки — она должна читаться одной строкой на телефоне.
 * Длинное имя проекта уступает остальным сегментам (по границе слова).
 */
export const HEADER_LIMIT = 64;

/** 047: сколько символов шапки минимум оставляем имени проекта. */
export const MIN_WORKSPACE_LIMIT = 8;

/** 047: предел короткого идентификатора ветки в шапке. */
export const BRANCH_LIMIT = 20;

/** 047: сколько символов тела минимум оставляем при частичной обрезке строки. */
const MIN_PARTIAL_LINE = 12;

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
export function renderClock(now = Date.now(), expiresAt = null, lang = DEFAULT_LANG) {
  const started = formatTime(now);
  if (!Number.isFinite(expiresAt)) return started;
  return `${started} · ${t("present.until", { time: formatTime(expiresAt) }, lang)}`;
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

/**
 * Усечь по границе слова, а не посреди слова (047). Если границы рядом нет —
 * честный `truncate` с маркером.
 */
export function truncateWord(text, limit, marker = "…") {
  const source = String(text ?? "");
  const max = Math.floor(Number(limit));
  if (!Number.isFinite(max) || max <= 0) return "";
  if (source.length <= max) return source;
  const room = Math.max(1, max - marker.length);
  const head = source.slice(0, room + 1);
  const boundary = Math.max(
    head.lastIndexOf(" "),
    head.lastIndexOf("-"),
    head.lastIndexOf("_"),
    head.lastIndexOf("/"),
    head.lastIndexOf("."),
    head.lastIndexOf("·"),
  );
  if (boundary >= Math.floor(room / 2)) {
    return `${source.slice(0, boundary).replace(/[\s·_-]+$/, "")}${marker}`;
  }
  return truncate(source, max, marker);
}

/** Категория числа строк для словаря: RU — one/few/many, EN — one/many (047). */
function linesCategory(count, lang) {
  if (lang === "en") return count === 1 ? "one" : "many";
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "one";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "few";
  return "many";
}

/** Подпись хвоста «…ещё N строк» на языке сообщения (047). */
function moreLinesLabel(count, lang) {
  return t(`present.moreLines.${linesCategory(count, lang)}`, { count }, lang);
}

/**
 * Усечь многострочный текст по границе строки (047): «…ещё N строк».
 *
 * Режем целыми строками, а не посреди строки: ответ агента читается с телефона,
 * и обрывок слова в нём бесполезен. Если очередная строка не влезает целиком,
 * но место под её начало есть — показываем начало с «…», а хвост считает только
 * полностью скрытые строки. Одну слишком длинную строку режем по символам с
 * прежним маркером. Результат всегда ≤ `limit`.
 */
export function truncateLines(text, limit, { lang = DEFAULT_LANG, marker } = {}) {
  const source = String(text ?? "");
  const max = Math.floor(Number(limit));
  if (!Number.isFinite(max) || max <= 0) return "";
  if (source.length <= max) return source;
  const cutMarker = marker ?? t("present.truncationMarker", {}, lang);
  const lines = source.split("\n");
  if (lines.length <= 1) return truncate(source, max, cutMarker);

  const joinLines = (count) => lines.slice(0, count).join("\n");
  const suffixFor = (count) => (count > 0 ? 1 + moreLinesLabel(count, lang).length : 0);

  // Сколько целых строк влезает вместе с хвостом «…ещё N строк».
  let kept = 0;
  while (kept < lines.length) {
    const rest = lines.length - kept - 1;
    if (joinLines(kept + 1).length + suffixFor(rest) > max) break;
    kept += 1;
  }
  if (kept === 0) return truncate(source, max, cutMarker);

  let result = joinLines(kept);
  let hidden = lines.length - kept;
  // Место под начало следующей строки остаётся — покажем его, а не выбросим.
  const room = max - result.length - 1 - suffixFor(hidden - 1);
  if (room >= MIN_PARTIAL_LINE) {
    const partial = truncateWord(lines[kept], room);
    if (partial !== "") {
      result = `${result}\n${partial}`;
      hidden -= 1;
    }
  }
  if (hidden === 0) return result;
  const tailText = moreLinesLabel(hidden, lang);
  if (result.length + 1 + tailText.length <= max) return `${result}\n${tailText}`;
  return truncate(result, max, cutMarker);
}

/**
 * HTML для Telegram/MAX (`parse_mode: "HTML"`): экранировать всё, а код и
 * диффы обернуть в `<pre>` (047). Без этого `<` в коде ломал бы разметку.
 */
export function renderHtml(text) {
  const source = String(text ?? "");
  const escape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = source.split("\n");
  const out = [];
  let block = null;
  const flush = () => {
    if (block !== null && block.lines.length > 0) out.push(`<pre>${escape(block.lines.join("\n"))}</pre>`);
    block = null;
  };
  const isDiffStart = (line) => /^(diff --git |@@ |\+\+\+ |--- )/.test(line);
  const isDiffLine = (line) => /^(diff --git |index |@@ |\+\+\+ |--- |\+|-| )/.test(line);
  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    if (fence) {
      if (block !== null && block.kind === "fence") flush();
      else {
        flush();
        block = { kind: "fence", lines: [] };
      }
      continue;
    }
    if (block !== null && block.kind === "fence") {
      block.lines.push(line);
      continue;
    }
    if (block !== null && block.kind === "diff") {
      if (line.trim() === "" || isDiffLine(line)) {
        block.lines.push(line);
        continue;
      }
      flush();
    }
    if (isDiffStart(line)) {
      flush();
      block = { kind: "diff", lines: [line] };
      continue;
    }
    out.push(escape(line).replace(/`([^`\n]+)`/g, "<code>$1</code>"));
  }
  flush();
  return out.join("\n");
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
/** id задачи из пути рабочего дерева (`.../worktrees/006` → "006"). */
function worktreeTaskId(cwd) {
  const match = /(?:^|\/)(?:worktrees|\.worktrees)\/([^/]+)\/?$/.exec(String(cwd ?? ""));
  return match === null ? null : match[1];
}

/**
 * Найти карточку сессии вместе с её веткой и рабочим деревом (047).
 * Возвращает `{id, branch, worktree}` или null; `findOwnedTask` — только id.
 */
export function findOwnedTaskCard(cwd, sessionId, { log = noop } = {}) {
  if (typeof cwd !== "string" || cwd === "" || typeof sessionId !== "string" || sessionId === "") {
    return null;
  }

  const preferred = worktreeTaskId(cwd);
  const best = { rank: -1, id: null, branch: null, worktree: null };

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
        log(`card ${name} could not be read: ${error?.message ?? error}`);
        continue;
      }
      if (frontMatterField(text, "owner") !== sessionId) continue;
      const status = frontMatterField(text, "status") ?? "";
      if (status === "merged") continue;
      const id = frontMatterField(text, "id") ?? name.replace(/\.md$/, "");
      let rank = STATUS_RANK[status] ?? 0;
      // cwd внутри worktrees/<id> — это и есть текущая задача сессии.
      if (preferred !== null && id === preferred) rank += 1000;
      // При равенстве выигрывает более поздний id (свежая задача).
      if (rank > best.rank || (rank === best.rank && id > (best.id ?? ""))) {
        best.rank = rank;
        best.id = id;
        best.branch = frontMatterField(text, "branch");
        best.worktree = frontMatterField(text, "worktree");
      }
    }
  }

  return best.id === null ? null : { id: best.id, branch: best.branch, worktree: best.worktree };
}

export function findOwnedTask(cwd, sessionId, { log = noop } = {}) {
  const card = findOwnedTaskCard(cwd, sessionId, { log });
  return card === null ? null : card.id;
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
    branch: null,
    worktree: null,
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
  const card = findOwnedTaskCard(cwd, context.sessionId, { log });
  context.taskId = card === null ? null : card.id;
  context.branch = card === null ? null : card.branch;
  context.worktree = card === null ? null : card.worktree;
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
  const lang = normalizeLang(context.lang) ?? DEFAULT_LANG;
  const now = Number.isFinite(context.now) ? context.now : Date.now();
  const expiresAt = Number.isFinite(context.expiresAt) ? context.expiresAt : null;
  const taskId = context.taskId === null || context.taskId === undefined ? "" : String(context.taskId);

  // 047: короткий идентификатор ветки (feature/047 → 047). Номер задачи не
  // повторяем: `task 047 · 047` на телефоне только шумит.
  const branch = typeof context.branch === "string" ? context.branch.replace(/^refs\/heads\//, "") : "";
  const shortBranch = branch === ""
    ? null
    : (branch.split("/").filter((part) => part !== "").at(-1) ?? null);

  const tail = [];
  if (taskId !== "") tail.push(t("present.task", { id: taskId }, lang));
  if (shortBranch !== null && shortBranch !== taskId) tail.push(truncateWord(shortBranch, BRANCH_LIMIT));
  const role = typeof context.role === "string" && context.role !== ""
    ? truncateWord(context.role, WORKSPACE_LIMIT)
    : null;
  if (role !== null) tail.push(role);
  // Номер вопроса в пачке: в мессенджере вопросы идут отдельными сообщениями.
  const index = Number.isFinite(context.index) ? context.index : null;
  const total = Number.isFinite(context.total) ? context.total : null;
  if (index !== null && total !== null && total > 1) {
    tail.push(t("present.questionOf", { index, total }, lang));
  }
  tail.push(renderClock(now, expiresAt, lang));

  // 047: шапка — одна строка на телефоне. Имя проекта уступает остальным
  // сегментам места и усекается по границе слова, а не посреди слова.
  const tailText = tail.join(" · ");
  const roomForWorkspace = HEADER_LIMIT - 2 - tailText.length - (tailText === "" ? 0 : 3);
  const workspaceLimit = Math.min(WORKSPACE_LIMIT, Math.max(MIN_WORKSPACE_LIMIT, roomForWorkspace));
  const workspace = typeof context.workspace === "string" && context.workspace !== ""
    ? truncateWord(context.workspace, workspaceLimit)
    : null;
  const segments = [workspace, tailText].filter((part) => part !== null && part !== "");
  const header = `▸ ${segments.join(" · ")}`;
  // Последняя страховка: даже с аномально длинной ролью шапка остаётся строкой.
  return header.length <= HEADER_LIMIT ? header : truncate(header, HEADER_LIMIT);
}

/** `worktrees/047` из абсолютного пути или basename рабочего дерева (047). */
export function worktreeHint(worktree) {
  const value = typeof worktree === "string" ? worktree.replace(/[\\/]+$/, "") : "";
  if (value === "") return null;
  const match = /(?:^|[\\/])((?:\.)?worktrees[\\/][^\\/]+)$/.exec(value);
  if (match !== null) return match[1].replace(/\\/g, "/");
  return path.basename(value);
}

/**
 * Имя проекта для шапки (047): у сессии в рабочем дереве basename — это номер
 * задачи (`worktrees/047`), и `▸ 047 · task 047` на телефоне только шумит.
 * Поэтому из такого пути берём имя проекта — каталог над `worktrees`.
 */
export function workspaceLabel(cwd) {
  const value = typeof cwd === "string" ? cwd.replace(/[\\/]+$/, "") : "";
  if (value === "") return null;
  const match = /^(.*)[\\/](?:\.)?worktrees[\\/]([^\\/]+)$/.exec(value);
  if (match === null) return path.basename(value);
  return path.basename(match[1]) || match[2];
}

/** Строка «🔗 ветка · worktrees/N» или null, если задачи/ветки нет. */
export function taskLinkHint(question = {}) {
  const branch = typeof question.branch === "string" ? question.branch.replace(/^refs\/heads\//, "") : "";
  const tree = worktreeHint(question.worktree);
  const parts = [branch === "" ? null : branch, tree].filter((part) => part !== null && part !== "");
  if (parts.length === 0) return null;
  return `${TASK_LINK_PREFIX} ${parts.join(" · ")}`;
}

/**
 * Текст сообщения: шапка, пустая строка, тело вопроса, подсказка multiSelect.
 *
 * Строка целиком укладывается в `caps.maxText`; если не влезает — усечение с
 * маркером «…обрезано» (лучше честный хвост, чем молча потерянный текст).
 */
export function renderBody(question = {}, caps = {}) {
  const lang = normalizeLang(question.lang ?? caps.lang) ?? DEFAULT_LANG;
  const maxText = Number.isFinite(caps.maxText) ? caps.maxText : DEFAULT_CAPS.maxText;
  const now = Number.isFinite(question.createdAt) ? question.createdAt : Date.now();
  const cwd = typeof question.workspace === "string" && question.workspace !== "" ? question.workspace : null;

  const header = renderHeader({
    workspace: workspaceLabel(cwd),
    taskId: question.taskId ?? null,
    branch: question.branch ?? null,
    role: question.role ?? null,
    index: question.index ?? null,
    total: question.total ?? null,
    now,
    expiresAt: question.expiresAt ?? null,
    lang,
  });

  const parts = [header, ""];
  const title = typeof question.title === "string" ? question.title.trim() : "";
  if (title !== "") parts.push(title, "");
  const detail = typeof question.detail === "string" ? question.detail.trim() : "";
  const rawBody = String(question.body ?? "");
  // Пустое тело без заголовка/подробностей — не молчание: честная заглушка,
  // иначе сообщение выглядело бы пустым.
  const content = rawBody.trim() !== "" || detail !== ""
    ? [rawBody, detail].filter((part) => part.trim() !== "").join("\n\n")
    : (title !== "" ? "" : t("present.emptyQuestion", {}, lang));
  const head = parts.join("\n");

  // 047: подсказка ровно одна и по делу — «нажмите кнопку» при вариантах,
  // «ответьте текстом» только когда кнопок нет или они бесполезны.
  const hasOptions = Array.isArray(question.options) && question.options.length > 0;
  const buttonsUsable = caps.inlineButtons !== false;
  let answerHint = null;
  if (hasOptions) {
    answerHint = buttonsUsable ? t("present.buttonHint", {}, lang) : t("present.freeTextHint", {}, lang);
  } else if (question.allowFreeText !== false) {
    const quick = normalizeQuickReplies(question.quickReplies, lang);
    const quickShown = buttonsUsable && quick.length > 0;
    answerHint = t(quickShown ? "present.quickReplyHint" : "present.freeTextHint", {}, lang);
  }
  const hints = [];
  if (question.multiSelect === true) hints.push(t("present.multiselectHint", {}, lang));
  if (answerHint !== null) hints.push(answerHint);
  const hintBlock = hints.length === 0 ? "" : `\n\n${hints.join("\n\n")}`;
  // 047: ссылка на задачу/дерево — одной строкой в подсказке, не в теле.
  const taskLink = taskLinkHint(question);
  const linkBlock = taskLink === null ? "" : `\n${taskLink}`;

  // Тело усекаем отдельно от шапки и подсказок: длинный ответ агента не должен
  // вытеснять «как ответить», а хвост «…ещё N строк» не считает их строками.
  const reserved = head.length + 1 + hintBlock.length + linkBlock.length;
  const budget = Math.max(1, maxText - reserved);
  const body = truncateLines(content, budget, { lang });
  const message = `${head}\n${body}${hintBlock}${linkBlock}`;
  return message.length <= maxText ? message : truncate(message, maxText, t("present.truncationMarker", {}, lang));
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
  const lang = normalizeLang(question.lang ?? caps.lang) ?? DEFAULT_LANG;
  const maxOptions = Math.max(
    0,
    Math.floor(Number.isFinite(caps.maxOptions) ? caps.maxOptions : DEFAULT_CAPS.maxOptions),
  );
  if (maxOptions === 0) return [];

  const options = Array.isArray(question.options) ? question.options : [];
  const labelLimit = Number.isFinite(caps.maxText) ? Math.min(64, caps.maxText) : 64;

  // 044: вопрос без вариантов — ряд быстрых ответов вместо поля ввода. Пустой
  // набор (конфиг `quickReplies: []`) выключает кнопки: остаётся текст.
  if (options.length === 0) {
    if (question.allowFreeText === false || caps.inlineButtons === false) return [];
    const quick = normalizeQuickReplies(question.quickReplies, lang);
    if (quick.length === 0) return [];
    return quick.slice(0, maxOptions).map((item) => [{
      label: truncate(item.label, labelLimit),
      kind: "quick",
      optionId: item.id,
    }]);
  }
  const button = (option) => ({
    label: truncate(option?.label ?? "", labelLimit),
    kind: "option",
    optionId: option?.id ?? null,
  });

  // Раскладка по приоритету: варианты → «Показать ещё» (если не всё влезло) →
  // «Другой ответ…». При одном свободном ряде (maxOptions=1) жертвуем раскрытием:
  // одна кнопка «Показать ещё» без вариантов бессмысленна.
  let freeSlots = question.allowFreeText === false ? 0 : 1;
  // Карточка: «Показать ещё» появляется, когда вариантов больше, чем maxOptions-1
  // (один ряд всегда оставляем под служебную кнопку).
  let showMore = options.length > Math.max(1, maxOptions - 1);
  let optionSlots = Math.max(0, maxOptions - freeSlots - (showMore ? 1 : 0));

  if (maxOptions === 1) {
    optionSlots = freeSlots === 1 ? 0 : 1;
    showMore = false;
  } else if (optionSlots === 0 && options.length > 0) {
    // Места нет — жертвуем свободным ответом, но варианты не теряем молча:
    // один вариант + «Показать ещё».
    freeSlots = 0;
    optionSlots = Math.max(1, maxOptions - (showMore ? 1 : 0));
  }

  const shown = options.slice(0, Math.max(0, optionSlots));
  const rows = shown.map((option) => [button(option)]);
  if (showMore && shown.length < options.length) {
    rows.push([{ label: t("present.moreLabel", {}, lang), kind: "more", optionId: MORE_OPTION }]);
  }
  if (freeSlots === 1) {
    rows.push([{ label: t("present.freeTextLabel", {}, lang), kind: "free", optionId: FREE_TEXT_OPTION }]);
  }
  return rows.slice(0, maxOptions);
}
