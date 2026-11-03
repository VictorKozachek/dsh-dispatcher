/**
 * Маршрутизация входящего ответа: к какому вопросу он относится.
 *
 * Вопросов и сессий может быть несколько одновременно, а чат один, поэтому
 * «просто текст» неоднозначен. Правила разбора:
 *   1. **кнопка** — точное попадание по `callback_data` (`q:<shortId>:<optionId>`);
 *   2. **reply** — ответ относится к вопросу того сообщения (`reply_to_message_id`);
 *   3. **свободный текст** — если открыт ровно один вопрос со свободным ответом
 *      (или ровно один ждёт текст после «Другой ответ…»), он и получает текст;
 *      если таких несколько — `'ambiguous'`: вопрос остаётся открытым, а человек
 *      получает подсказку (`describeOpen`), ответ не теряется;
 *   4. всё остальное — `'ignored'` (чужой `shortId`, пустой текст, повторный ответ).
 *
 * Здесь нет платформенных деталей: `callback_data` разбирается хелпером из 003,
 * allowlist — забота транспорта (004) **до** вызова роутинга, а вопросы приходят
 * из инжектируемого хранилища (`createQuestionStore`): в 008 его заменит
 * персистентное состояние.
 *
 * Ответ возвращается в форме DSH — `{id, selected, custom?}`: домен (002) уже
 * принимает `accept()` и умеет `toAnswer()`, роутинг только выбирает вопрос.
 */

import path from "node:path";

import { DEFAULT_CAPS, parseCallbackData } from "./transport/base.js";

/** `optionId` кнопки «Другой ответ…»: переводит вопрос в ожидание текста. */
export const FREE_TEXT_OPTION = "free";

/** `optionId` кнопки «Показать ещё»: просьба раскрыть остальные варианты. */
export const MORE_OPTION = "more";

/** Маркер усечения длинного текстового ответа. */
export const TRUNCATION_MARKER = "…обрезано";

/** Сколько символов тела вопроса показывать в подсказке «к какому вопросу». */
const DESCRIBE_BODY_LIMIT = 40;

const noop = () => {};

/**
 * Хранилище открытых вопросов для роутинга.
 *
 * Минимальный интерфейс, который нужен маршрутизации; в 008 его реализует
 * состояние на диске. Вопросы — объекты домена (002): `shortId`, `isOpen`,
 * `allowFreeText`, `accept()`, `toAnswer()`.
 *
 * @param {Array<object>} [questions] — уже открытые вопросы.
 */
export function createQuestionStore(questions = []) {
  const byShortId = new Map();
  const messageOwner = new Map();
  const awaiting = new Set();

  const store = {
    /** Запомнить вопрос (ключ — `shortId`). */
    add(question) {
      if (typeof question?.shortId !== "string" || question.shortId === "") {
        throw new TypeError("questionStore.add: у вопроса нет shortId");
      }
      byShortId.set(question.shortId, question);
      return question;
    },
    /** Убрать вопрос из открытых. */
    remove(shortId) {
      awaiting.delete(shortId);
      return byShortId.delete(shortId);
    },
    /** Все вопросы, о которых знает хранилище (роутинг сам смотрит на `isOpen`). */
    list() {
      return [...byShortId.values()];
    },
    /** Вопрос по короткому id. */
    get(shortId) {
      return byShortId.get(shortId) ?? null;
    },
    /** Запомнить, что сообщение мессенджера — это вопрос: для ответов по reply. */
    registerMessage(messageId, shortId) {
      if (messageId === undefined || messageId === null) return false;
      messageOwner.set(String(messageId), shortId);
      return true;
    },
    /** Вопрос того сообщения (для `reply_to_message_id`). */
    byMessageId(messageId) {
      const shortId = messageOwner.get(String(messageId));
      return shortId === undefined ? null : store.get(shortId);
    },
    /** Перевести вопрос в режим ожидания текста («Другой ответ…»). */
    markAwaitingText(shortId) {
      if (!byShortId.has(shortId)) return false;
      awaiting.add(shortId);
      return true;
    },
    /** Снять режим ожидания (текст пришёл или ответ уже дан). */
    clearAwaitingText(shortId) {
      return awaiting.delete(shortId);
    },
    /** Вопросы, ждущие свободного текста. */
    awaitingText() {
      return store.list().filter((question) => awaiting.has(question.shortId) && question.isOpen === true);
    },
  };
  for (const question of Array.isArray(questions) ? questions : []) store.add(question);
  return store;
}

/** Усечь строку, не разрывая суррогатную пару. */
function truncateText(text, limit) {
  const source = String(text ?? "");
  const max = Math.floor(Number(limit));
  if (!Number.isFinite(max) || max <= 0) return "";
  if (source.length <= max) return source;
  const room = Math.max(0, max - TRUNCATION_MARKER.length);
  let head = source.slice(0, room);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}${TRUNCATION_MARKER}`;
}

/**
 * Нормализовать свободный текст ответа.
 *
 * Многострочный текст допустим как есть; пустой (или из одних пробелов) — `null`;
 * слишком длинный усекается до `maxText` с маркером: ответ человека важнее, чем
 * молчание, но про обрезку он узнаёт.
 *
 * @returns {string|null}
 */
export function normalizeText(text, maxText = DEFAULT_CAPS.maxText) {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (value === "") return null;
  const limit = Number.isFinite(maxText) && maxText > 0 ? Math.floor(maxText) : DEFAULT_CAPS.maxText;
  return value.length <= limit ? value : truncateText(value, limit);
}

/** Привести событие транспорта к одному виду (кнопка/текст/reply). */
function normalizeIncoming(answer) {
  const incoming = {
    shortId: null,
    optionIds: [],
    text: null,
    replyToMessageId: null,
    answeredBy: null,
  };
  if (answer === null || typeof answer !== "object") return incoming;

  if (typeof answer.callbackData === "string") {
    const parsed = parseCallbackData(answer.callbackData);
    if (parsed !== null) {
      incoming.shortId = parsed.shortId;
      incoming.optionIds = [parsed.optionId];
    }
  } else if (typeof answer.shortId === "string" && answer.shortId !== "") {
    incoming.shortId = answer.shortId;
    incoming.optionIds = Array.isArray(answer.optionIds)
      ? answer.optionIds.filter((id) => typeof id === "string" && id !== "")
      : [];
  }

  if (typeof answer.text === "string") incoming.text = answer.text;
  const reply = answer.replyToMessageId ?? answer.replyToMessage_id;
  if (reply !== undefined && reply !== null) incoming.replyToMessageId = reply;
  if (answer.answeredBy !== undefined && answer.answeredBy !== null) incoming.answeredBy = answer.answeredBy;
  return incoming;
}

/** Вопрос по короткому id, если он ещё открыт. */
function openQuestion(store, shortId) {
  const question = store.get(shortId);
  return question !== null && question.isOpen === true ? question : null;
}

/** Принять текстовый ответ в вопрос; вернуть результат роутинга. */
function acceptText(store, question, text, answeredBy, now, log) {
  if (question === null || question.isOpen !== true) {
    log(`ответ на ${question?.shortId ?? "?"}: вопрос уже закрыт — игнор`);
    return "ignored";
  }
  if (question.allowFreeText !== true) {
    log(`ответ на ${question.shortId}: свободный ответ запрещён — игнор`);
    return "ignored";
  }
  if (question.accept({ selected: [], custom: text }, { answeredBy, now }) !== true) {
    return "ignored";
  }
  store.clearAwaitingText(question.shortId);
  return { question, answer: question.toAnswer() };
}

/**
 * Разобрать входящий ответ.
 *
 * @param {object} options
 * @param {object} [options.transport] — транспорт (004): у него берём `caps`.
 * @param {object} options.answer — событие транспорта: `callbackData` или
 *   `shortId`+`optionIds`, либо `text` (+ `replyToMessageId`), `answeredBy`.
 * @param {object} options.store — хранилище вопросов (`createQuestionStore`).
 * @param {(message: string) => void} [options.log]
 * @param {number} [options.now] — часы (тесты).
 * @returns {{question: object, answer: {id: string, selected: string[], custom?: string} | null,
 *   awaitingText?: boolean, showMore?: boolean} | "ambiguous" | "ignored"}
 */
export function routeIncoming({ transport, answer, store, log = noop, now = Date.now } = {}) {
  if (store === null || typeof store?.get !== "function") {
    log("роутинг: нет хранилища вопросов — игнор");
    return "ignored";
  }
  const caps = transport?.caps ?? DEFAULT_CAPS;
  const incoming = normalizeIncoming(answer);

  // 1. Кнопка: точное попадание по shortId из callback_data.
  if (incoming.shortId !== null && incoming.optionIds.length > 0) {
    const question = openQuestion(store, incoming.shortId);
    if (question === null) {
      log(`кнопка ${incoming.shortId}: вопроса нет или он закрыт — игнор`);
      return "ignored";
    }
    const optionId = incoming.optionIds[0];

    if (optionId === FREE_TEXT_OPTION) {
      store.markAwaitingText(question.shortId);
      return { question, answer: null, awaitingText: true };
    }
    if (optionId === MORE_OPTION) {
      return { question, answer: null, showMore: true };
    }

    const option = question.options.find((item) => item.id === optionId) ?? null;
    if (option === null) {
      log(`кнопка ${question.shortId}: варианта ${optionId} нет — игнор`);
      return "ignored";
    }
    if (question.accept({ selected: [option.label] }, { answeredBy: incoming.answeredBy, now: now() }) !== true) {
      log(`кнопка ${question.shortId}: ответ не принят (повтор?) — игнор`);
      return "ignored";
    }
    store.clearAwaitingText(question.shortId);
    return { question, answer: question.toAnswer() };
  }

  // 2. Свободный текст: reply адресует вопрос точно, иначе — по числу ждущих.
  if (incoming.text !== null) {
    const text = normalizeText(incoming.text, caps.maxText);
    if (text === null) {
      log("текстовый ответ пустой — игнор");
      return "ignored";
    }

    if (incoming.replyToMessageId !== null) {
      const question = store.byMessageId(incoming.replyToMessageId);
      if (question === null) {
        log(`reply на сообщение ${incoming.replyToMessageId}: вопроса нет — игнор`);
        return "ignored";
      }
      return acceptText(store, question, text, incoming.answeredBy, now(), log);
    }

    const awaiting = store.awaitingText();
    if (awaiting.length === 1) {
      return acceptText(store, awaiting[0], text, incoming.answeredBy, now(), log);
    }
    if (awaiting.length > 1) {
      log(`текст без reply: ждут ${awaiting.length} вопроса — просим уточнить`);
      return "ambiguous";
    }

    const freeText = store.list().filter((question) => question.isOpen === true && question.allowFreeText === true);
    if (freeText.length === 1) {
      return acceptText(store, freeText[0], text, incoming.answeredBy, now(), log);
    }
    if (freeText.length > 1) {
      log(`текст без reply: открыто ${freeText.length} вопроса — просим уточнить`);
      return "ambiguous";
    }
    log("текст без reply: открытых вопросов со свободным ответом нет — игнор");
    return "ignored";
  }

  return "ignored";
}

/**
 * Человекочитаемый список открытых вопросов для «уточните, к какому вопросу».
 *
 * `1. dsh-dispatcher · task 007 — «Удалить ветку?»` — номер, воркспейс, задача;
 * тело обрезается, чтобы подсказка осталась подсказкой.
 *
 * @returns {string} строки через перевод строки; пустой список — пустая строка.
 */
export function describeOpen(questions = []) {
  const list = (Array.isArray(questions) ? questions : []).filter((question) => question !== null && typeof question === "object");
  return list.map((question, index) => {
    const workspace = typeof question.workspace === "string" && question.workspace !== ""
      ? path.basename(question.workspace)
      : null;
    const task = question.taskId === null || question.taskId === undefined || question.taskId === ""
      ? null
      : `task ${question.taskId}`;
    const where = [workspace, task].filter((part) => part !== null).join(" · ");
    const body = truncateText(String(question.body ?? "").replace(/\s+/g, " ").trim(), DESCRIBE_BODY_LIMIT);
    return `${index + 1}. ${where === "" ? "" : `${where} — `}«${body}»`;
  }).join("\n");
}
