/**
 * Уведомления доски в канал (задача 014).
 *
 * Это **человеческие** уведомления о событиях доски: карточка ушла в `ready`
 * («можно вливать»), в `blocked` («нужен человек»), в `todo` стало меньше
 * `minTodo` («пора выдать»). Наряды агентам рассылает сторож `dsh-kanban` — их
 * здесь нет и дублировать их нельзя.
 *
 * Жёсткое правило: `.kanban/tasks` здесь **только читается**. Статусы двигает
 * `bin/task-move.sh`, а уведомления — наблюдатель; тесты проверяют, что файлы
 * не изменились (mtime + hash).
 *
 * Дедуп — по ключу `id:status:updated` в `store` (переживает перезапуск), тихие
 * часы — по конфигу, пауза между сообщениями — троттлингом (003).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { throttle } from "./transport/base.js";

/** Статусы, о которых уведомляем: карточка ждёт человека или оркестратора. */
export const NOTIFY_STATUSES = Object.freeze(["ready", "blocked"]);

/** По умолчанию не шлём с 23:00 до 08:00. */
export const DEFAULT_QUIET_HOURS = Object.freeze({ from: 23, to: 8 });

/** Пауза между уведомлениями: не спамим один канал. */
export const NOTIFY_INTERVAL_MS = 1_000;

/** Сколько ключей дедупа помним. */
const SEEN_LIMIT = 500;

const noopLog = () => {};

/** Разобрать front matter карточки: `key: value`, кавычки снимаются. */
export function parseFrontMatter(text) {
  const source = String(text ?? "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (match === null) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (field === null) continue;
    let value = field[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[field[1]] = value;
  }
  return result;
}

/** Число из поля фронт-маттера (или null). */
function numberOf(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Прочитать доску проекта: карточки и `minTodo`.
 *
 * Только чтение: ни одной записи в `.kanban`. Ошибки чтения одной карточки не
 * ломают обзор — она просто пропускается с логом.
 *
 * @param {object} options - `{workspace, log}`.
 * @returns {{workspace: string, cards: object[], minTodo: number|null}}
 */
export function readBoard({ workspace, log = noopLog } = {}) {
  const root = typeof workspace === "string" && workspace !== "" ? workspace : null;
  if (root === null) return { workspace: null, cards: [], minTodo: null };

  const tasksDir = path.join(root, ".kanban", "tasks");
  const cards = [];
  let entries = [];
  try {
    entries = fs.readdirSync(tasksDir);
  } catch (error) {
    if (error?.code !== "ENOENT") log(`доска ${root}: каталог не прочитан (${error?.message ?? error})`);
    return { workspace: root, cards: [], minTodo: null };
  }
  for (const name of entries.filter((entry) => entry.endsWith(".md") && entry !== "README.md").sort()) {
    try {
      const text = fs.readFileSync(path.join(tasksDir, name), "utf8");
      const meta = parseFrontMatter(text);
      const id = typeof meta.id === "string" && meta.id !== "" ? meta.id : name.replace(/\.md$/, "");
      cards.push({
        id,
        status: typeof meta.status === "string" ? meta.status : "",
        title: typeof meta.title === "string" ? meta.title : "",
        note: typeof meta.note === "string" ? meta.note : "",
        updated: typeof meta.updated === "string" ? meta.updated : "",
      });
    } catch (error) {
      log(`доска ${root}: карточка ${name} не прочитана (${error?.message ?? error})`);
    }
  }

  let minTodo = null;
  try {
    const board = JSON.parse(fs.readFileSync(path.join(root, ".kanban", "board.json"), "utf8"));
    minTodo = numberOf(board?.minTodo);
  } catch (error) {
    if (error?.code !== "ENOENT") log(`доска ${root}: board.json не прочитан (${error?.message ?? error})`);
  }
  return { workspace: root, cards, minTodo };
}

/** Короткий текст уведомления: воркспейс + номер карточки (+ причина). */
export function noticeText(notice, { maxText = 4000 } = {}) {
  const workspace = path.basename(String(notice.workspace ?? "")) || "проект";
  const card = notice.cardId === null ? "" : ` · #${notice.cardId}`;
  const reason = notice.reason === undefined || notice.reason === "" ? "" : `\n${notice.reason}`;
  let text = `${workspace}${card}: ${notice.title}${reason}`;
  if (text.length > maxText) text = `${text.slice(0, Math.max(0, maxText - 1))}…`;
  return text;
}

/**
 * Собрать уведомления о переходах: `ready`, `blocked`, `todo` ниже `minTodo`.
 *
 * @param {object} options
 * @param {{cards: object[], minTodo: (number|null)}} options.board — текущая доска.
 * @param {Set<string>} options.seen — уже отправленные ключи.
 * @param {number|null} options.lastTodo — сколько было в `todo` при прошлом чтении.
 * @param {string} options.workspace — корень проекта (в текст идёт basename).
 * @returns {{notices: object[], nextSeen: Set<string>, todoCount: number}}
 */
export function collectNotices({ board, seen = new Set(), lastTodo = null, workspace }) {
  const cards = Array.isArray(board?.cards) ? board.cards : [];
  const nextSeen = new Set(seen);
  const notices = [];

  for (const card of cards) {
    if (!NOTIFY_STATUSES.includes(card.status)) continue;
    // Воркспейс в ключе: два проекта могут иметь карточки с одинаковыми
    // id/status/updated — это разные уведомления.
    const key = `${workspace}:${card.id}:${card.status}:${card.updated}`;
    if (seen.has(key)) continue;
    nextSeen.add(key);
    notices.push({
      key,
      kind: card.status,
      cardId: card.id,
      status: card.status,
      workspace,
      title: card.status === "ready" ? "можно вливать" : "нужен человек",
      reason: card.status === "blocked" && card.note !== "" ? card.note : "",
    });
  }

  const todoCount = cards.filter((card) => card.status === "todo").length;
  const minTodo = numberOf(board?.minTodo);
  if (minTodo !== null && lastTodo !== null && todoCount < minTodo && lastTodo >= minTodo) {
    const key = `${workspace}:todo-low:${minTodo}:${todoCount}`;
    if (!seen.has(key)) {
      nextSeen.add(key);
      notices.push({
        key,
        kind: "todo-low",
        cardId: null,
        status: "todo-low",
        workspace,
        title: `пора выдать: в todo ${todoCount}, минимум ${minTodo}`,
        reason: "",
      });
    }
  }

  return { notices, nextSeen, todoCount };
}

/** Попадает ли момент в тихие часы (`from` включительно, `to` исключительно). */
export function inQuietHours(date, { from = DEFAULT_QUIET_HOURS.from, to = DEFAULT_QUIET_HOURS.to } = {}) {
  const hour = new Date(date).getHours();
  if (from === to) return false;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to; // окно через полночь
}

/**
 * Создать планировщик уведомлений.
 *
 * @param {object} options
 * @param {object} options.store — хранилище (`store.js`): дедуп и `lastTodo`.
 * @param {string[]} options.workspaces — корни проектов для наблюдения.
 * @param {(message: {text: string, kind: string}) => Promise<any>} options.send — отправка.
 * @param {() => number} [options.now] — часы (тесты).
 * @param {object|false} [options.quietHours] — окно тишины или `false`.
 * @param {boolean} [options.enabled] — `notify: false` выключает всё.
 * @param {number} [options.intervalMs] — пауза между сообщениями.
 * @param {(message: string) => void} [options.log]
 * @returns {{scan: () => Promise<object[]>, start: () => void, stop: () => void, stats: object}}
 */
export function createNotifier({
  store,
  workspaces = [],
  send,
  now = () => Date.now(),
  quietHours = DEFAULT_QUIET_HOURS,
  enabled = true,
  intervalMs = NOTIFY_INTERVAL_MS,
  maxText = 4000,
  /** Лимит текста в момент отправки: caps канала могут появиться позже старта. */
  resolveMaxText = null,
  log = noopLog,
  setInterval: setIntervalImpl = setInterval,
  clearInterval: clearIntervalImpl = clearInterval,
} = {}) {
  const roots = (Array.isArray(workspaces) ? workspaces : []).filter((item) => typeof item === "string" && item !== "");
  const stats = { sent: 0, skippedQuiet: 0, errors: 0 };
  let timer = null;
  let scanning = false;

  /** Состояние дедупа из store (устойчиво к отсутствию полей). */
  function readNotifyState() {
    const state = typeof store?.read === "function" ? store.read() : {};
    const notify = state?.notify !== null && typeof state?.notify === "object" ? state.notify : {};
    return {
      seen: new Set(Array.isArray(notify.seen) ? notify.seen.slice(-SEEN_LIMIT) : []),
      byWorkspace: notify.lastTodo !== null && typeof notify.lastTodo === "object" ? { ...notify.lastTodo } : {},
      // baseline — по воркспейсам: новый проект не должен «догонять» историей.
      baselines: notify.baseline !== null && typeof notify.baseline === "object" ? { ...notify.baseline } : {},
    };
  }

  /** Записать новое состояние дедупа. */
  function writeNotifyState({ seen, byWorkspace, baselines }) {
    if (typeof store?.update !== "function") return;
    store.update((state) => {
      state.notify = {
        seen: [...seen].slice(-SEEN_LIMIT),
        lastTodo: { ...byWorkspace },
        baseline: { ...baselines },
      };
      return state;
    });
  }

  /**
   * Один проход: прочитать доски, собрать новые уведомления, отправить.
   *
   * Первый проход — базовый: запоминает текущее состояние и ничего не шлёт,
   * иначе после каждого рестарта плагина приходил бы спам «можно вливать» по
   * всем старым `ready`-карточкам.
   */
  async function scan() {
    if (enabled !== true) return [];
    if (scanning) return [];
    scanning = true;
    try {
      const state = readNotifyState();
      const seen = state.seen;
      const byWorkspace = { ...state.byWorkspace };
      // Базовый проход — один раз: запоминаем текущее состояние и молчим,
      // иначе после рестарта плагина приходил бы спам по старым ready/blocked.
      const baselines = state.baselines;
      const sent = [];

      for (const workspace of roots) {
        const board = readBoard({ workspace, log });
        const previousTodo = Number.isFinite(byWorkspace[workspace]) ? byWorkspace[workspace] : null;
        const { notices, nextSeen, todoCount } = collectNotices({
          board,
          seen,
          lastTodo: previousTodo,
          workspace,
        });
        // Первый проход по конкретному воркспейсу — базовый: запоминаем, молчим.
        if (baselines[workspace] !== true) {
          for (const notice of notices) seen.add(notice.key);
          byWorkspace[workspace] = todoCount;
          baselines[workspace] = true;
          continue;
        }
        const quiet = quietHours === false ? false : inQuietHours(now(), quietHours);
        if (quiet && notices.length > 0) {
          // Ни ключи, ни lastTodo не обновляем: иначе todo-low «сгорит» тем, что
          // последнее значение уже стало ниже минимума. После тишины повторим.
          stats.skippedQuiet += notices.length;
          for (const notice of notices) log(`уведомления: тихие часы — ${notice.key} отложено`);
          continue;
        }
        byWorkspace[workspace] = todoCount;
        const queue = throttle([], intervalMs, { now });
        for (const notice of notices) {
          queue.push(async () => {
            try {
              const limit = typeof resolveMaxText === "function" ? (resolveMaxText() ?? maxText) : maxText;
              await send({ kind: notice.kind, text: noticeText(notice, { maxText: limit }), workspace: notice.workspace });
              // Ключ помечаем ТОЛЬКО после успешной отправки: сбой сети/канала
              // должен повторяться, а не терять уведомление навсегда.
              seen.add(notice.key);
              stats.sent += 1;
              sent.push(notice);
            } catch (error) {
              stats.errors += 1;
              log(`уведомление ${notice.key} не отправлено (${error?.message ?? error})`);
            }
          });
        }
        await queue.run();
      }

      writeNotifyState({ seen, byWorkspace, baselines });
      return sent;
    } finally {
      scanning = false;
    }
  }

  /** Периодический проход (таймер инжектируется: тесты не ждут). */
  function start() {
    if (enabled !== true || timer !== null) return;
    void scan();
    timer = setIntervalImpl(() => {
      void scan();
    }, 30_000);
    timer?.unref?.();
  }

  function stop() {
    if (timer !== null) {
      clearIntervalImpl(timer);
      timer = null;
    }
  }

  return { scan, start, stop, stats, workspaces: roots };
}
