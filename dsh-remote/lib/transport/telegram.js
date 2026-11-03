/**
 * Telegram-транспорт: long polling `getUpdates`, кнопки-варианты и правка сообщения.
 *
 * Реализует контракт `QuestionTransport` из `./base.js`; выше по стеку о Telegram
 * никто не знает. Сеть — единственное место в плагине, где она вообще есть, и она
 * целиком инжектируется (`fetch`), поэтому тесты гоняют полный сценарий «вопрос →
 * кнопка → ответ» без реального Bot API.
 *
 * Что важно в поведении:
 *   - long polling с `offset = update_id + 1` и дедупом по `update_id`: повторный
 *     апдейт после рестарта не превращается во второй ответ. `offset` переживает
 *     перезапуск через инжектируемые `loadOffset`/`persistOffset` (файл появится в
 *     задаче 005, здесь — колбэки);
 *   - сетевые ошибки и 5xx — экспоненциальный backoff, 429 — пауза ровно
 *     `retry_after` + джиттер (лимиты Bot API: 1 сообщение в секунду в чат, 20 в
 *     минуту в группу, 429 с `parameters.retry_after`);
 *   - `409 Conflict` — не «ещё одна попытка»: это второй `getUpdates` на тот же
 *     токен, цикл останавливается с внятной ошибкой;
 *   - `callback_query` всегда сначала получает `answerCallbackQuery` (иначе у
 *     человека крутятся «часики», а BotFather ругается), и только потом ответ
 *     уходит в `onAnswer`;
 *   - allowlist по `from.id` (кто человек) и `chat.id` (куда доставляем): всё
 *     чужое — строка в лог и игнор;
 *   - токен не попадает ни в лог, ни в текст ошибки: он вырезается (`redact`).
 *
 * @typedef {import("./base.js").TransportAnswer} TransportAnswer
 */

import {
  DEFAULT_CAPS,
  callbackData,
  checkTransport,
  chrome,
  parseCallbackData,
} from "./base.js";

/** Базовый адрес Bot API: тот же формат, что в доке (`/bot<token>/<method>`). */
const API_BASE = "https://api.telegram.org";

/** Какие апдейты просим: только сообщения и кнопки. */
const ALLOWED_UPDATES = Object.freeze(["message", "callback_query"]);

/**
 * Служебные причины закрытия из ответчика: это не ответ человека, и писать
 * «✅ Отвечено: aborted» нельзя. Для них снимаем только кнопки, текст не трогаем.
 */
const CLOSE_REASONS = new Set([
  "aborted",
  "cancelled",
  "canceled",
  "expired",
  "failed",
  "send-failed",
  "detached",
  "disposed",
  "closed",
]);

/** Рабочий диапазон long polling из отчёта по API (25–50 с). */
const POLL_TIMEOUT_MIN_SEC = 25;
const POLL_TIMEOUT_MAX_SEC = 50;

/** База backoff: 500 мс, дальше удвоение до потолка. */
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/** Ошибка Telegram: код, описание и признак «можно повторить». */
export class TelegramError extends Error {
  constructor(message, { code = 0, description = "", retryable = false, retryAfterMs = 0, method = "" } = {}) {
    super(message);
    this.name = "TelegramError";
    this.code = code;
    this.description = description;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.method = method;
  }
}

/** Ошибка отмены: по ней цикл и ожидания понимают, что пора выходить. */
function abortError() {
  const error = new Error("telegram: остановлено");
  error.name = "AbortError";
  return error;
}

/** Пауза, которая прерывается abort-сигналом (иначе `stop()` ждал бы backoff). */
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

/** HTML в `parse_mode: "HTML"`: `<`, `>` и `&` вне тегов обязаны быть сущностями. */
function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Токены HTML-безопасной нарезки: сущность (`&amp;`) и code point неделимы.
 *
 * Резать уже собранную HTML-строку нельзя: граница может попасть внутрь
 * `&amp;`/`&lt;` или между `<b>` и текстом, и `parse_mode: "HTML"` получит
 * сломанную разметку. Поэтому экранируем по одному символу и режем по токенам.
 */
function htmlTokens(text) {
  const tokens = [];
  for (const point of String(text ?? "")) {
    if (point === "&") tokens.push({ text: "&amp;", space: false });
    else if (point === "<") tokens.push({ text: "&lt;", space: false });
    else if (point === ">") tokens.push({ text: "&gt;", space: false });
    else tokens.push({ text: point, space: /\s/.test(point) });
  }
  return tokens;
}

/**
 * Нарезать **простой** текст под предел сообщения, экранируя HTML по дороге.
 *
 * Предел считается по длине готовой HTML-строки (Telegram считает символы после
 * парсинга entities, то есть строже), поэтому кусок гарантированно влезает.
 * Перенос предпочитаем по пробелу, но никогда не рвём сущность или суррогатную пару.
 */
export function splitHtml(text, limit) {
  const max = Math.max(1, Math.floor(limit));
  const chunks = [];
  let current = "";
  let lastSpace = -1;

  const push = (value) => {
    const trimmed = value.replace(/\s+$/, "");
    if (trimmed !== "") chunks.push(trimmed);
  };

  for (const token of htmlTokens(text)) {
    if (current !== "" && current.length + token.text.length > max) {
      if (lastSpace > 0) {
        push(current.slice(0, lastSpace));
        current = current.slice(lastSpace).replace(/^\s+/, "");
      } else {
        push(current);
        current = "";
      }
      lastSpace = -1;
      if (current !== "" && current.length + token.text.length > max) {
        push(current);
        current = "";
      }
    }
    current += token.text;
    if (token.space) lastSpace = current.length;
  }
  push(current);
  return chunks;
}

/**
 * Текст вопроса в сообщениях: заголовок жирным, тело, подробности курсивом.
 *
 * Части режутся по отдельности (у каждой свой бюджет на теги), а потом соседние
 * части склеиваются переводом строки, если вместе влезают в предел.
 */
function renderMessages(question, limit) {
  const parts = [];
  const title = typeof question?.title === "string" ? question.title.trim() : "";
  const body = typeof question?.body === "string" ? question.body : "";
  const detail = typeof question?.detail === "string" ? question.detail.trim() : "";
  if (title !== "") parts.push({ text: title, wrap: (chunk) => `<b>${chunk}</b>`, overhead: 7 });
  if (body !== "") parts.push({ text: body, wrap: (chunk) => chunk, overhead: 0 });
  if (detail !== "") parts.push({ text: detail, wrap: (chunk) => `<i>${chunk}</i>`, overhead: 7 });
  if (parts.length === 0) return ["(пустой вопрос)"];

  const messages = [];
  let buffer = "";
  let lastGroup = -1;

  parts.forEach((part, group) => {
    for (const chunk of splitHtml(part.text, Math.max(1, limit - part.overhead))) {
      const html = part.wrap(chunk);
      if (buffer === "") {
        buffer = html;
        lastGroup = group;
        continue;
      }
      const joined = `${buffer}\n${html}`;
      if (group !== lastGroup && joined.length <= limit) {
        buffer = joined;
        lastGroup = group;
        continue;
      }
      messages.push(buffer);
      buffer = html;
      lastGroup = group;
    }
  });

  if (buffer !== "") messages.push(buffer);
  // Текст из одних пробелов не даёт ни одного куска: без сообщения ответчик
  // ждал бы ответа вечно, поэтому отправляем заглушку.
  return messages.length > 0 ? messages : ["(пустой вопрос)"];
}

/**
 * @param {object} options
 * @param {string} options.token — токен бота (в логах маскируется).
 * @param {string|number} options.chatId — чат доставки из привязки.
 * @param {Array<string|number>} [options.allowedUserIds] — allowlist `from.id`.
 * @param {typeof fetch} [options.fetch] — HTTP-клиент (в тестах подменяется).
 * @param {string} [options.baseUrl] — базовый адрес (тестовый контур Bot API).
 * @param {number} [options.pollTimeoutSec] — 25–50, по умолчанию 30.
 * @param {() => number} [options.loadOffset] — откуда взять `offset` после рестарта.
 * @param {(offset: number) => void} [options.persistOffset] — куда его сохранить.
 * @param {() => number} [options.now] — часы (мс).
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep] — пауза.
 * @param {() => number} [options.jitter] — джиттер к `retry_after`, в тестах 0.
 * @param {(message: string) => void} [options.log] — лог плагина (без токена).
 */
export function createTelegramTransport(options = {}) {
  const token = options.token;
  if (typeof token !== "string" || token === "") {
    throw new TypeError("telegram: нужен токен бота (ctx.credentials, не конфиг)");
  }
  if (options.chatId === undefined || options.chatId === null || options.chatId === "") {
    throw new TypeError("telegram: нужен chatId привязки (/remote connect)");
  }

  const chatId = options.chatId;
  const allowedUserIds = new Set((options.allowedUserIds ?? []).map(String));
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = String(options.baseUrl ?? API_BASE).replace(/\/+$/, "");
  const pollTimeoutSec = Math.min(
    POLL_TIMEOUT_MAX_SEC,
    Math.max(POLL_TIMEOUT_MIN_SEC, Math.floor(Number(options.pollTimeoutSec ?? 30)) || 30),
  );
  const caps = { ...DEFAULT_CAPS, ...(options.caps ?? {}) };
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function" ? options.sleep : defaultSleep;
  const jitter = typeof options.jitter === "function" ? options.jitter : () => Math.floor(Math.random() * 250);
  const log = typeof options.log === "function" ? options.log : () => {};
  const loadOffset = typeof options.loadOffset === "function" ? options.loadOffset : () => 0;
  const persistOffset = typeof options.persistOffset === "function" ? options.persistOffset : () => {};
  const maxAttempts = Math.max(1, Math.floor(Number(options.maxAttempts ?? 3)) || 3);

  /** Что уже отправлено: короткий id → сообщение (для правки и текстовых ответов). */
  const sent = new Map();
  /** Подписчики `onAnswer`. */
  const subscribers = new Set();
  /** Отправленное безымянно? Сообщения без shortId нам не нужны. */
  let offset = Math.max(0, Math.floor(Number(loadOffset()) || 0));
  let lastUpdateId = offset > 0 ? offset - 1 : -1;
  let lastPollAt = null;
  let lastError = null;
  let running = false;
  let controller = null;
  let loopPromise = null;

  /** Токен не должен утечь в лог или текст ошибки. */
  const redact = (text) => String(text ?? "").split(token).join("<token>");

  /** HTTP-запрос к Bot API: разбор ответа и классификация ошибок. */
  async function request(method, payload = {}, { signal } = {}) {
    const url = `${baseUrl}/bot${token}/${method}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw abortError();
      throw new TelegramError(
        redact(`Telegram ${method}: сеть недоступна (${error?.message ?? error})`),
        { retryable: true, method },
      );
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (body?.ok === true) return body.result;

    const status = Number(response?.status ?? 0);
    const description = redact(body?.description ?? `HTTP ${status}`);

    if (status === 429) {
      const retryAfter = Math.max(1, Number(body?.parameters?.retry_after ?? 1));
      throw new TelegramError(
        `Telegram ${method}: 429 Too Many Requests, повтор через ${retryAfter} с`,
        { code: 429, description, retryable: true, retryAfterMs: retryAfter * 1000, method },
      );
    }
    if (status === 409) {
      throw new TelegramError(
        `Telegram ${method}: 409 Conflict — на этот токен уже есть второй поллер getUpdates. `
        + "Остановите второй экземпляр плагина (или бота на другой машине) и запустите снова.",
        { code: 409, description, retryable: false, method },
      );
    }
    if (status >= 500) {
      throw new TelegramError(
        `Telegram ${method}: ${status} ${description}`,
        { code: status, description, retryable: true, method },
      );
    }
    throw new TelegramError(
      `Telegram ${method}: ${status} ${description}`,
      { code: status, description, retryable: false, method },
    );
  }

  /** Вызов с ретраями: 429 — ровно `retry_after` + джиттер, сеть/5xx — backoff. */
  async function call(method, payload, { signal, attempts = maxAttempts } = {}) {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await request(method, payload, { signal });
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if (!error?.retryable || attempt >= attempts) throw error;
        const wait = error.retryAfterMs > 0
          ? error.retryAfterMs + Math.max(0, Number(jitter()) || 0)
          : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
        log(`telegram ${method}: ${error.message}; повтор через ${wait} мс`);
        await sleep(wait, signal);
      }
    }
  }

  /** Человек и чат из allowlist? Пустой allowlist — никого (безопасный дефолт). */
  function allowed(fromId, chatIdOfUpdate) {
    const from = fromId === undefined || fromId === null ? null : String(fromId);
    const chat = chatIdOfUpdate === undefined || chatIdOfUpdate === null ? null : String(chatIdOfUpdate);
    const known = from !== null && allowedUserIds.has(from);
    const ownChat = chat !== null && chat === String(chatId);
    if (!known || !ownChat) {
      log(`telegram: чужой апдейт (from=${from ?? "?"}, chat=${chat ?? "?"}) — игнор`);
      return false;
    }
    return true;
  }

  /** Подписчикам: ответ в форме `TransportAnswer`. */
  function emit(answer) {
    for (const handler of [...subscribers]) {
      try {
        handler(answer);
      } catch (error) {
        log(`telegram: подписчик onAnswer упал (${error?.message ?? error})`);
      }
    }
  }

  /** К какому вопросу относится свободный текст: reply или единственный открытый. */
  function shortIdForText(message) {
    const replyTo = message?.reply_to_message?.message_id;
    if (replyTo !== undefined) {
      for (const [shortId, record] of sent) {
        if (record.messageIds.includes(replyTo) && record.closed === false) return shortId;
      }
    }
    const open = [...sent].filter(([, record]) => record.closed === false);
    if (open.length === 1) return open[0][0];
    return null;
  }

  /** Кнопка нажата: сначала гасим «часики», потом отдаём ответ наверх. */
  async function handleCallback(query) {
    if (typeof query?.id === "string") {
      try {
        await call("answerCallbackQuery", { callback_query_id: query.id }, { attempts: 1 });
      } catch (error) {
        log(`telegram: answerCallbackQuery не прошёл (${error?.message ?? error})`);
      }
    }
    if (!allowed(query?.from?.id, query?.message?.chat?.id)) return;
    const parsed = parseCallbackData(query?.data);
    if (parsed === null) {
      log(`telegram: callback_data не разобрал (${JSON.stringify(query?.data)}) — игнор`);
      return;
    }
    emit({
      shortId: parsed.shortId,
      optionIds: [parsed.optionId],
      answeredBy: String(query.from.id),
    });
  }

  /** Свободный текст: только из привязанного чата и от привязанного человека. */
  async function handleMessage(message) {
    if (message?.from?.is_bot === true) return;
    if (!allowed(message?.from?.id, message?.chat?.id)) return;
    const text = typeof message?.text === "string" ? message.text.trim() : "";
    if (text === "") {
      log("telegram: сообщение без текста (вложения) — игнор");
      return;
    }
    const shortId = shortIdForText(message);
    if (shortId === null) {
      log("telegram: свободный текст без открытого вопроса — игнор");
      return;
    }
    emit({ shortId, text, answeredBy: String(message.from.id) });
  }

  /** Один апдейт: дедуп по `update_id`, сдвиг `offset`, сохранение. */
  async function handleUpdate(update) {
    const id = Number(update?.update_id);
    if (!Number.isFinite(id)) return;
    if (id <= lastUpdateId) {
      log(`telegram: апдейт ${id} уже обработан (last ${lastUpdateId}) — пропуск`);
      return;
    }
    lastUpdateId = id;
    offset = id + 1;
    try {
      persistOffset(offset);
    } catch (error) {
      log(`telegram: offset ${offset} не сохранился (${error?.message ?? error})`);
    }
    if (update.callback_query !== undefined) {
      await handleCallback(update.callback_query);
      return;
    }
    if (update.message !== undefined) await handleMessage(update.message);
  }

  /** Цикл long polling: до abort-сигнала, с backoff на ошибках. */
  async function pollLoop(signal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const updates = await call(
          "getUpdates",
          { offset, timeout: pollTimeoutSec, allowed_updates: [...ALLOWED_UPDATES] },
          { signal },
        );
        failures = 0;
        lastPollAt = now();
        for (const update of Array.isArray(updates) ? updates : []) await handleUpdate(update);
      } catch (error) {
        if (signal.aborted || error?.name === "AbortError") break;
        lastError = error;
        if (error?.code === 409 || error?.retryable === false) {
          // Второй поллер или ошибка запроса: повторять бессмысленно.
          log(`telegram: поллинг остановлен — ${error.message}`);
          break;
        }
        failures += 1;
        const wait = error?.retryAfterMs > 0
          ? error.retryAfterMs
          : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
        log(`telegram: ${error?.message ?? error}; следующая попытка через ${wait} мс`);
        try {
          await sleep(wait, signal);
        } catch {
          break;
        }
      }
    }
    running = false;
  }

  /**
   * Правка закрытого сообщения: снять кнопки и, если это ответ, написать его.
   *
   * Ошибка правки не ломает ответ: ответ уже уехал в сессию, а сообщение —
   * украшение. Запись при этом снимается: переправлять больше некуда.
   */
  async function closeRecord(shortId, record, summary = record.closeSummary) {
    const messageId = record.messageIds.at(-1);
    const text = String(summary ?? "").trim();
    // Пустая строка или служебная причина — не ответ: снимаем кнопки, но текст
    // не переписываем, иначе человек увидит «Ответ: aborted».
    const silent = text === "" || CLOSE_REASONS.has(text.toLowerCase());
    const payload = silent
      ? { chat_id: record.chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }
      : {
        chat_id: record.chatId,
        message_id: messageId,
        parse_mode: "HTML",
        text: `✅ <b>Отвечено</b>: ${escapeHtml(text)}`,
        reply_markup: { inline_keyboard: [] },
      };
    try {
      await call(silent ? "editMessageReplyMarkup" : "editMessageText", payload);
    } catch (error) {
      log(`telegram: правку сообщения ${shortId} сделать не удалось (${error?.message ?? error})`);
    }
    record.closed = true;
    sent.delete(shortId);
  }

  const transport = {
    id: "telegram",
    caps,

    /** Поднять поллинг. Повторный вызов безопасен. */
    async start() {
      if (running) return transport;
      running = true;
      controller = new AbortController();
      lastError = null;
      loopPromise = pollLoop(controller.signal).catch((error) => {
        lastError = error;
        log(`telegram: цикл поллинга упал (${error?.message ?? error})`);
      });
      log(`telegram: поллинг запущен (offset ${offset}, timeout ${pollTimeoutSec} с)`);
      return transport;
    },

    /** Остановить поллинг: сигнал, ожидание цикла, без текущих таймеров. */
    async stop() {
      if (running) {
        running = false;
        controller?.abort();
        const loop = loopPromise;
        loopPromise = null;
        try {
          await loop;
        } catch {
          /* цикл завершился отменой — это нормальный путь остановки */
        }
      }
      // Открытые вопросы закрываем молча: кнопки вопроса, на который уже никто не
      // ответит (плагин остановлен), не должны остаться в чате.
      for (const [shortId, record] of [...sent.entries()]) {
        if (record.messageIds.length > 0) await closeRecord(shortId, record, "");
      }
      sent.clear();
      log("telegram: поллинг остановлен");
      return transport;
    },

    /** Отправить вопрос: текст (HTML) + кнопки по одной в ряд на последнем куске. */
    async sendQuestion(question, sendOptions = {}) {
      const shortId = question?.shortId;
      if (typeof shortId !== "string" || shortId === "") {
        throw new TypeError("telegram: у вопроса нет shortId — кнопки не соберутся");
      }
      const target = sendOptions?.chatId ?? chatId;
      const chunks = renderMessages(question, caps.maxText);
      const options = Array.isArray(question.options) ? question.options : [];
      const keyboard = caps.inlineButtons && options.length > 0
        ? {
          inline_keyboard: chrome(options, 1).map((row) => row.map((option) => ({
            text: option.label,
            callback_data: callbackData(shortId, option.id),
          }))),
        }
        : undefined;

      // Запись заводим ДО отправки: ответчик может снять вопрос (аборт), пока
      // sendMessage ещё висит. Тогда закрытие откладывается до конца отправки.
      const record = { chatId: target, messageIds: [], closed: false, closeSummary: "" };
      sent.set(shortId, record);
      try {
        for (const [index, chunk] of chunks.entries()) {
          const last = index === chunks.length - 1;
          const result = await call("sendMessage", {
            chat_id: target,
            parse_mode: "HTML",
            text: chunk,
            ...(last && keyboard !== undefined ? { reply_markup: keyboard } : {}),
          });
          if (result?.message_id !== undefined) record.messageIds.push(result.message_id);
        }
      } catch (error) {
        if (record.messageIds.length === 0) sent.delete(shortId);
        else if (record.closed) await closeRecord(shortId, record);
        throw error;
      }

      if (record.closed) await closeRecord(shortId, record);
      return { messageId: record.messageIds.at(-1), messageIds: [...record.messageIds] };
    },

    /**
     * Закрыть вопрос: кнопки снимаются, текст правится на «✅ Отвечено: …».
     * Ошибка правки не ломает ответ — ответ уже уехал в сессию.
     */
    async closeQuestion(question, summary = "") {
      const shortId = question?.shortId;
      const record = shortId === undefined ? undefined : sent.get(shortId);
      if (record === undefined) {
        log(`telegram: закрывать нечего — вопрос ${shortId ?? "?"} не отправлялся`);
        return;
      }
      const text = String(summary ?? "").trim();
      if (record.messageIds.length === 0) {
        // Сообщение ещё отправляется (аборт во время sendMessage): запомним
        // просьбу, и sendQuestion закроет его сам, как только получит message_id.
        record.closed = true;
        record.closeSummary = text;
        log(`telegram: закрытие вопроса ${shortId} отложено — сообщение ещё отправляется`);
        return;
      }
      await closeRecord(shortId, record, text);
    },

    /** Подписка на ответы; возвращает отписку. */
    onAnswer(handler) {
      if (typeof handler !== "function") throw new TypeError("telegram: onAnswer ждёт функцию");
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },

    /** Живость: `getMe` + состояние цикла (последний update_id и время опроса). */
    async healthCheck() {
      const state = {
        polling: running,
        lastUpdateId,
        lastPollAt,
        chatId: String(chatId),
      };
      try {
        const me = await call("getMe", {}, { attempts: 1 });
        return { ok: true, detail: `бот @${me?.username ?? "?"} на связи`, ...state };
      } catch (error) {
        return { ok: false, detail: redact(error?.message ?? error), ...state };
      }
    },

    // --- для тестов и диагностики -------------------------------------------

    get offset() {
      return offset;
    },
    get lastUpdateId() {
      return lastUpdateId;
    },
    get lastError() {
      return lastError;
    },
    get polling() {
      return running;
    },
    get subscribers() {
      return subscribers.size;
    },
    get messages() {
      return sent;
    },
    checkTransport() {
      return checkTransport(transport);
    },
  };

  return transport;
}
