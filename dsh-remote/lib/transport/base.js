/**
 * Контракт транспорта мессенджера и хелперы, которые нужны любому транспорту.
 *
 * Транспорт — единственное место, где плагин знает про конкретный мессенджер:
 * Telegram (задача 004), MAX (фаза 2) и `fake` (тесты) реализуют один интерфейс,
 * и выше по стеку — ответчик, домен, рендер — о различиях не знают.
 *
 * Слой чистый: ни сети, ни `fetch`, ни таймеров, кроме инжектируемого `sleep`.
 * Здесь только раскладка данных под ограничения мессенджера: сборка callback-data,
 * нарезка длинного текста, ряды кнопок и троттлинг отправки.
 *
 * @typedef {object} TransportAnswer
 * @property {string} shortId — короткий id вопроса (тот же, что в кнопках).
 * @property {string[]} [optionIds] — выбранные варианты (id из `question.options`).
 * @property {string} [text] — свободный ответ человека.
 * @property {string} [answeredBy] — кто ответил (для allowlist — задача 008).
 *
 * @typedef {object} QuestionTransport
 * @property {string} id — имя транспорта для логов и состояния (`telegram`, `fake`).
 * @property {{inlineButtons: boolean, editAfterAnswer: boolean, maxText: number, maxOptions: number}} caps
 *   Возможности мессенджера: кнопки, правка сообщения после ответа, предел текста
 *   (в единицах UTF-16, как считает Bot API) и предел числа вариантов.
 * @property {() => void | Promise<void>} start — поднять транспорт (поллер, вебхук).
 * @property {() => void | Promise<void>} stop — остановить и снять ресурсы.
 * @property {(question: object, options?: {chatId?: string}) => void | Promise<{messageId?: string}>} sendQuestion
 *   Отправить вопрос; `question.shortId` и `question.options[{id,label}]` — то, из
 *   чего строятся кнопки.
 * @property {(question: object, summary?: string) => void | Promise<void>} closeQuestion
 *   Снять кнопки/пометить сообщение закрытым (ответили, истёк TTL, аборт).
 * @property {(handler: (answer: TransportAnswer) => void) => (() => void)} onAnswer
 *   Подписка на ответы; возвращает функцию отписки.
 * @property {() => ({ok: boolean, detail?: string} | Promise<{ok: boolean, detail?: string}>)} healthCheck
 *   Проверка живости (токен, связь) для `/remote doctor` и `status`.
 */

/** Пределы и возможности по умолчанию: их перекрывает транспорт своими `caps`. */
export const DEFAULT_CAPS = Object.freeze({
  inlineButtons: true,
  editAfterAnswer: true,
  /** Предел текста сообщения в единицах UTF-16 (Telegram Bot API: 4096). */
  maxText: 4096,
  /** Сколько вариантов влезает в одно сообщение. */
  maxOptions: 8,
});

/** Методы, без которых объект не является транспортом. */
export const TRANSPORT_METHODS = Object.freeze([
  "start",
  "stop",
  "sendQuestion",
  "closeQuestion",
  "onAnswer",
  "healthCheck",
]);

/** Предел `callback_data` мессенджера: 64 байта UTF-8. */
export const CALLBACK_LIMIT_BYTES = 64;

const CALLBACK_PREFIX = "q";

/**
 * Проверка, что объект реализует контракт.
 *
 * Нужна и в тестах, и в `/remote doctor`: `fake` обязан проходить ту же проверку,
 * что и настоящий транспорт, иначе он перестаёт быть доказательством.
 *
 * @param {unknown} candidate
 * @returns {{ok: boolean, missing: string[]}}
 */
export function checkTransport(candidate) {
  const missing = [];
  if (candidate === null || typeof candidate !== "object") {
    return { ok: false, missing: ["(объект)"] };
  }
  if (typeof candidate.id !== "string" || candidate.id === "") missing.push("id");
  if (candidate.caps === null || typeof candidate.caps !== "object") {
    missing.push("caps");
  } else {
    for (const [key, value] of Object.entries(DEFAULT_CAPS)) {
      if (typeof candidate.caps[key] !== typeof value) missing.push(`caps.${key}`);
    }
  }
  for (const method of TRANSPORT_METHODS) {
    if (typeof candidate[method] !== "function") missing.push(method);
  }
  return { ok: missing.length === 0, missing };
}

/** Часть `callback_data` не может быть пустой и не может содержать `:`. */
function token(value, name) {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`callback_data: ${name} должен быть непустой строкой`);
  }
  if (value.includes(":")) {
    throw new TypeError(`callback_data: ${name} не может содержать ":"`);
  }
  return value;
}

/**
 * `callback_data` кнопки: `q:<shortId>:<optionId>`, не длиннее 64 байт.
 *
 * Формат нарочно короткий: Telegram ограничивает callback_data 64 **байтами**,
 * а id вопроса и варианта приходят из домена (`shortId` там 8 hex, вариант — `o1`).
 * Длинные строки не обрезаем молча: это ошибка программиста, пусть падает громко.
 *
 * @throws {TypeError} пустая часть или `:` внутри части.
 * @throws {RangeError} результат длиннее 64 байт.
 */
export function callbackData(shortId, optionId) {
  const data = `${CALLBACK_PREFIX}:${token(shortId, "shortId")}:${token(optionId, "optionId")}`;
  const bytes = Buffer.byteLength(data, "utf8");
  if (bytes > CALLBACK_LIMIT_BYTES) {
    throw new RangeError(`callback_data ${bytes} байт > ${CALLBACK_LIMIT_BYTES}: ${data}`);
  }
  return data;
}

/**
 * Разбор `callback_data` от мессенджера.
 *
 * Мусор не бросает: чужие/битые callback'и (старые сообщения, другие боты в том же
 * чате) — нормальный поток, отвечать на них надо «ничего не делать».
 *
 * @returns {{shortId: string, optionId: string} | null}
 */
export function parseCallbackData(data) {
  if (typeof data !== "string" || data === "") return null;
  if (Buffer.byteLength(data, "utf8") > CALLBACK_LIMIT_BYTES) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  const [prefix, shortId, optionId] = parts;
  if (prefix !== CALLBACK_PREFIX || shortId === "" || optionId === "") return null;
  return { shortId, optionId };
}

/**
 * Нарезать текст под предел сообщения, не потеряв ни одного символа.
 *
 * `limit` — в единицах UTF-16 (так считает Bot API и `String.length`), режем по
 * границам строк/слов, а слово длиннее предела — по code points: суррогатная пара
 * (эмодзи) не разрывается никогда. Склейка кусков даёт исходный текст байт в байт.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 * @throws {RangeError} предел не положительное число.
 */
export function splitText(text, limit = DEFAULT_CAPS.maxText) {
  const source = typeof text === "string" ? text : String(text ?? "");
  const max = Math.floor(Number(limit));
  if (!Number.isFinite(max) || max <= 0) {
    throw new RangeError("splitText: limit должен быть положительным числом");
  }
  if (source === "") return [];
  if (source.length <= max) return [source];

  /** Куски собираются в массив; разделители остаются в предыдущем куске. */
  const chunks = [];
  let current = "";

  // Токен — слово вместе с хвостовыми пробелами или просто пробелы: склейка
  // токенов даёт исходную строку, поэтому «не терять символы» выполняется даром.
  for (const part of source.match(/[^\s]+\s*|\s+/g) ?? []) {
    if (current.length + part.length <= max) {
      current += part;
      continue;
    }
    if (current !== "") {
      chunks.push(current);
      current = "";
    }
    if (part.length <= max) {
      current = part;
      continue;
    }
    // Одно слово длиннее предела: режем по code points, не по code units.
    for (const point of Array.from(part)) {
      if (current !== "" && current.length + point.length > max) {
        chunks.push(current);
        current = "";
      }
      current += point;
    }
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/**
 * Разложить варианты ответа по строкам клавиатуры.
 *
 * Мессенджеры рисуют кнопки рядами, и «все в один ряд» ломает узкие экраны.
 *
 * @template T
 * @param {T[]} options
 * @param {number} [limit] — максимум кнопок в строке (меньше единицы — одна).
 * @returns {T[][]}
 */
export function chrome(options = [], limit = 2) {
  const items = Array.isArray(options) ? options : [];
  const perRow = Math.max(1, Math.floor(Number(limit)) || 1);
  const rows = [];
  for (let index = 0; index < items.length; index += perRow) {
    rows.push(items.slice(index, index + perRow));
  }
  return rows;
}

/**
 * Троттлинг очереди: задачи идут по одной, между стартами — не меньше интервала.
 *
 * Мессенджеры бьют за частые запросы (Telegram — 429), поэтому отправка идёт
 * через этот примитив. Часы и `sleep` инжектируются: в тестах интервал
 * проверяется на фейковом времени, без реального ожидания.
 *
 * @param {Array<() => any>} [queue] — исходные задачи (функции).
 * @param {number} [minIntervalMs]
 * @param {{now?: () => number, sleep?: (ms: number) => Promise<void>}} [options]
 * @returns {{readonly size: number, push: (task: () => any) => any, run: () => Promise<any[]>}}
 */
export function throttle(queue = [], minIntervalMs = 0, options = {}) {
  const tasks = Array.isArray(queue) ? [...queue] : [];
  const interval = Math.max(0, Number(minIntervalMs) || 0);
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function"
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let lastAt = null;

  const runner = {
    get size() {
      return tasks.length;
    },
    push(task) {
      if (typeof task !== "function") throw new TypeError("throttle: задача должна быть функцией");
      tasks.push(task);
      return runner;
    },
    async run() {
      const results = [];
      while (tasks.length > 0) {
        const task = tasks.shift();
        if (lastAt !== null && interval > 0) {
          const wait = interval - (now() - lastAt);
          if (wait > 0) await sleep(wait);
        }
        lastAt = now();
        results.push(await task());
      }
      return results;
    },
  };
  return runner;
}
