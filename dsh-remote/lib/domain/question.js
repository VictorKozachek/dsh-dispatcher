/**
 * Домен вопроса: модель `RemoteQuestion` и правила ответа на неё.
 *
 * Модель — то, что уходит в транспорт и живёт в реестре открытых вопросов.
 * Здесь нет ни сети, ни DSH: только данные, статусы и один-единственный переход
 * `open → answered`, который нельзя повторить.
 *
 * Откуда берётся вопрос: из `AskUserQuestionItem` (см.
 * `packages/interaction/user-questions/src/types.ts`). Одно поле лишнее по
 * сравнению с карточкой, зато обязательное: `questionId` — id, который дал
 * вызывающий (`item.id`), потому что в ответе `AskUserQuestionAnswerItem.id`
 * обязан быть именно он. `id` модели — свой uuid: по нему мы различаем вопросы
 * внутри плагина, и он не пересекается с id, которые придумывает инструмент.
 *
 * Время — миллисекунды epoch (числа): `now` инжектируется, поэтому тесты не ждут
 * реальных часов. `expiresAt` пока только поле модели: TTL, напоминание и
 * протухание — задача 008.
 */

import { randomBytes, randomUUID } from "node:crypto";

/** Статусы вопроса. `pending` — создан, но ещё не отправлен. */
export const QUESTION_STATUS = Object.freeze({
  pending: "pending",
  open: "open",
  answered: "answered",
  expired: "expired",
  cancelled: "cancelled",
});

/** Сколько живёт вопрос по умолчанию: 30 минут (использует задача 008). */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

const noopLog = () => {};

/** Короткий id (8 hex) для `callback_data` мессенджера: ≤64 байт вместе с id варианта. */
function shortId() {
  return randomBytes(4).toString("hex");
}

/** Варианты ответа перенумеровываются в стабильные короткие id (`o1`, `o2`, …). */
function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  const result = [];
  for (const [index, option] of options.entries()) {
    const label = typeof option === "string" ? option : option?.label;
    if (typeof label !== "string" || label.trim() === "") continue;
    result.push({
      id: `o${index + 1}`,
      label,
      ...(typeof option?.description === "string" && option.description !== ""
        ? { description: option.description }
        : {}),
    });
  }
  return result;
}

/** Текст свободного ответа: строка без пробельных краёв или null. */
function cleanText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Вопрос удалённого управления.
 *
 * Инварианты:
 *   - `accept()` работает только в статусе `open` и только один раз: повтор —
 *     `false` и строка в лог, а не исключение (человек мог нажать кнопку дважды);
 *   - `selected` в ответе — **label** вариантов (так ждёт DSH в
 *     `AskUserQuestionAnswerItem.selected`), а не короткие id кнопок;
 *   - свободный текст принимается, только если `allowFreeText`.
 */
export class RemoteQuestion {
  /**
   * @param {object} item — `AskUserQuestionItem` из запроса DSH.
   * @param {object} [context] — `sessionId`, `workspace`, `role`, `taskId`,
   *   `now` (мс epoch), `ttlMs`, `log`.
   */
  constructor(item, context = {}) {
    if (item === null || typeof item !== "object") {
      throw new TypeError("вопрос должен быть объектом AskUserQuestionItem");
    }
    if (typeof item.id !== "string" || item.id === "") {
      throw new TypeError("у вопроса нет id: AskUserQuestionItem.id обязателен");
    }

    const now = typeof context.now === "number" ? context.now : Date.now();
    const ttlMs = Number.isFinite(context.ttlMs) && context.ttlMs > 0 ? context.ttlMs : DEFAULT_TTL_MS;
    const log = typeof context.log === "function" ? context.log : noopLog;

    /** Собственный id вопроса (uuid) — для реестра и транспорта. */
    this.id = randomUUID();
    /** Короткий id для кнопок мессенджера (8 hex). */
    this.shortId = shortId();
    /** id вопроса у вызывающего: его и только его ждёт DSH в ответе. */
    this.questionId = item.id;
    this.sessionId = context.sessionId ?? null;
    this.workspace = context.workspace ?? null;
    this.role = context.role ?? null;
    this.taskId = context.taskId ?? null;
    this.title = typeof item.header === "string" && item.header !== "" ? item.header : null;
    this.body = typeof item.question === "string" ? item.question : "";
    /** Подробности вопроса: рендерятся рядом с телом (шапка и текст — задача 006). */
    this.detail = typeof item.detail === "string" && item.detail !== "" ? item.detail : null;
    this.options = normalizeOptions(item.options);
    this.multiSelect = item.multiSelect === true;
    /** Свободный ответ: у plan-review его нет — там выбор из «approve/decline». */
    this.allowFreeText = item.intent?.kind === "plan-review" ? false : true;
    this.createdAt = now;
    this.expiresAt = now + ttlMs;
    this.status = QUESTION_STATUS.pending;
    /** @type {{selected: string[], custom?: string}|undefined} */
    this.answer = undefined;
    this.answeredBy = undefined;
    this.answeredAt = undefined;
    this.log = log;
  }

  /** Вопрос отправлен в транспорт: ждём ответа. */
  markOpen(now = Date.now()) {
    if (this.status !== QUESTION_STATUS.pending) return false;
    this.status = QUESTION_STATUS.open;
    this.openedAt = now;
    return true;
  }

  get isOpen() {
    return this.status === QUESTION_STATUS.open;
  }

  /**
   * Принять ответ человека: единственный переход `open → answered`.
   *
   * Метод назван `accept`, а не `answer`: поле `answer` занято самим ответом,
   * и метод с тем же именем был бы перекрыт свойством экземпляра.
   *
   * @param {{selected?: string[], custom?: string}} choice — выбранные **label**
   *   вариантов и/или свободный текст.
   * @param {{answeredBy?: string, now?: number}} [meta]
   * @returns {boolean} true — ответ принят; false — ответ отклонён (см. лог).
   */
  accept(choice = {}, meta = {}) {
    if (this.status !== QUESTION_STATUS.open) {
      this.log(`вопрос ${this.shortId}: ответ не принят — статус ${this.status}`);
      return false;
    }

    const selected = Array.isArray(choice.selected) ? choice.selected : [];
    const custom = cleanText(choice.custom);

    if (selected.length === 0 && custom === null) {
      this.log(`вопрос ${this.shortId}: пустой ответ — ни варианта, ни текста`);
      return false;
    }
    if (!this.multiSelect && selected.length > 1) {
      this.log(`вопрос ${this.shortId}: несколько вариантов в одиночном вопросе`);
      return false;
    }
    const known = new Set(this.options.map((option) => option.label));
    const unknown = selected.filter((label) => !known.has(label));
    if (unknown.length > 0) {
      this.log(`вопрос ${this.shortId}: неизвестные варианты ${unknown.join(", ")}`);
      return false;
    }
    if (custom !== null && !this.allowFreeText) {
      this.log(`вопрос ${this.shortId}: свободный ответ запрещён`);
      return false;
    }

    this.answer = {
      selected: [...selected],
      ...(custom === null ? {} : { custom }),
    };
    this.answeredBy = meta.answeredBy ?? null;
    this.answeredAt = Number.isFinite(meta.now) ? meta.now : Date.now();
    this.status = QUESTION_STATUS.answered;
    return true;
  }

  /** Снять вопрос до ответа (аборт запроса, выгрузка плагина). */
  cancel(reason = "cancelled", now = Date.now()) {
    if (this.status !== QUESTION_STATUS.pending && this.status !== QUESTION_STATUS.open) return false;
    this.status = QUESTION_STATUS.cancelled;
    this.cancelReason = reason;
    this.closedAt = now;
    return true;
  }

  /** Истёк TTL — наполнение задачи 008, переход объявлен здесь, чтобы статус был один. */
  expire(now = Date.now()) {
    if (this.status !== QUESTION_STATUS.pending && this.status !== QUESTION_STATUS.open) return false;
    this.status = QUESTION_STATUS.expired;
    this.closedAt = now;
    return true;
  }

  /**
   * Ответ в форме DSH: `{id, selected, custom?}`.
   *
   * `id` — id вызывающего (`questionId`), `selected` — метки вариантов.
   * @throws {Error} если вопрос ещё не отвечен: спрашивать нечего.
   */
  toAnswer() {
    if (this.status !== QUESTION_STATUS.answered || this.answer === undefined) {
      throw new Error(`вопрос ${this.shortId} не отвечен: статус ${this.status}`);
    }
    return {
      id: this.questionId,
      selected: [...this.answer.selected],
      ...(this.answer.custom === undefined ? {} : { custom: this.answer.custom }),
    };
  }

  /** Компактное представление для логов и состояния (без секретов). */
  toJSON() {
    return {
      id: this.id,
      shortId: this.shortId,
      questionId: this.questionId,
      sessionId: this.sessionId,
      workspace: this.workspace,
      role: this.role,
      taskId: this.taskId,
      title: this.title,
      body: this.body,
      options: this.options,
      multiSelect: this.multiSelect,
      allowFreeText: this.allowFreeText,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
      status: this.status,
      answer: this.answer,
      answeredBy: this.answeredBy,
    };
  }
}

/** Конструктор из элемента `AskUserQuestionItem` (см. класс). */
export function createQuestion(item, context = {}) {
  return new RemoteQuestion(item, context);
}

/** Вопросы запроса одной пачкой: один контекст на всю пачку. */
export function createQuestions(items, context = {}) {
  return (Array.isArray(items) ? items : []).map((item) => createQuestion(item, context));
}
