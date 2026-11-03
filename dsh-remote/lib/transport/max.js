/**
 * MAX-транспорт (platform-api2.max.ru) — второй канал по контракту
 * `QuestionTransport` из `./base.js` (задача 004).
 *
 * Отличия от Telegram, которые здесь видны:
 *   - авторизация **заголовком** `Authorization: <token>` (в query токен больше не
 *     поддерживается), база `platform-api2.max.ru`;
 *   - текст ≤ 4000 символов (вместо 4096), формат `html`;
 *   - нажатие кнопки приходит как `message_callback`, а ответ на него —
 *     `POST /answers?callback_id=…`: один вызов и подтверждает нажатие, и правит
 *     сообщение;
 *   - правка сообщения — `PUT /messages?message_id=…`; сообщения с кнопками
 *     правятся без ограничения срока, остальные — 7 суток;
 *   - входящий свободный текст — `message_created`;
 *   - глобального `update_id` нет, поэтому дедуп по композитному ключу
 *     (`sha256(chat_id, тип, callback_id|mid, timestamp)`);
 *   - лимиты 2 сообщения/сек и 2 правки/сек в чат — свой троттлинг, `retry_after`
 *     в 429 не документирован, поэтому backoff с джиттером; при 8 часах без
 *     успешной доставки платформа отписывает webhook — это видно в healthCheck;
 *   - long polling (`GET /updates`) — для разработки; webhook требует публичный
 *     HTTPS:443, а DSH не умеет слушать внешний адрес, поэтому режим webhook
 *     здесь только валидируется и даёт внятную ошибку (карточка 011).
 *
 * Слой чистый: сеть приходит через инжектируемый `fetch`, часы — через `now`,
 * паузы — через `sleep`, поэтому тесты не ходят в сеть и не ждут реальных секунд.
 */

import { createHash } from "node:crypto";

import {
  DEFAULT_CAPS,
  callbackData,
  checkTransport,
  chrome,
  parseCallbackData,
  splitText,
  throttle,
} from "./base.js";
import { FREE_TEXT_OPTION, MORE_OPTION, renderBody, renderRows } from "../present.js";

/** Базовый адрес MAX Bot API: документация просит именно platform-api2. */
export const MAX_API_BASE = "https://platform-api2.max.ru";

/** Возможности MAX: кнопки есть, править можно, текст ≤ 4000, вариантов ≤ 7. */
export const MAX_CAPS = Object.freeze({
  inlineButtons: true,
  editAfterAnswer: true,
  maxText: 4000,
  maxOptions: 7,
});

/** Лимит платформы: не больше 2 запросов в секунду в один чат. */
export const MAX_CHAT_RPS_INTERVAL_MS = 500;

/** Причины, при которых сообщение закрывается молчаливой пометкой. */
const QUIET_REASONS = new Set([
  "aborted",
  "cancelled",
  "canceled",
  "expired",
  "failed",
  "send-failed",
  "detached",
  "disposed",
  "closed",
  "undelivered",
  "restarted",
  "",
]);

/** Сколько запомненных ключей дедупа держим: защита от роста памяти. */
const DEDUPE_LIMIT = 1000;

/** Ошибки, которые бессмысленно ретраить. */
const NO_RETRY = new Set([400, 401, 404, 405]);

/** Ошибки, которые ретраим с backoff (429/503 и сеть). */
const RETRY = new Set([429, 503]);

/** Текст ошибки для человека: без токена и без stacktrace. */
export function describeError(error, token) {
  let message = error instanceof Error ? error.message : String(error ?? "неизвестная ошибка");
  if (typeof token === "string" && token !== "") message = message.split(token).join("<token>");
  return message;
}

/**
 * Обрезать уже экранированный html под предел платформы, не разорвав сущность.
 *
 * `renderBody` режет *простой* текст до `caps.maxText`, но экранирование
 * (`&` → `&amp;`) удлиняет строку и может вывести её за 4000. Режем по месту и
 * отступаем от последнего незакрытого `&`, чтобы не получить «&am…».
 */
function clipEscaped(text, limit) {
  if (text.length <= limit) return text;
  let cut = text.slice(0, Math.max(0, limit - 1));
  const amp = cut.lastIndexOf("&");
  if (amp >= 0 && !/^&(amp|lt|gt);$/.test(cut.slice(amp))) cut = cut.slice(0, amp);
  return `${cut}…`;
}

/** Вырезать токен из произвольного текста (сервер может его отразить). */
function maskToken(text, secret) {
  if (typeof secret !== "string" || secret === "") return String(text ?? "");
  return String(text ?? "").split(secret).join("<token>");
}

/** Экранирование простого текста под `format: "html"`. */
function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Создать MAX-транспорт.
 *
 * @param {object} options
 * @param {string} options.token — токен бота (только из credentials).
 * @param {string|number} [options.chatId] — чат привязки (для отправки).
 * @param {string|number} [options.userId] — личный диалог, если chatId нет.
 * @param {(string|number)[]} [options.allowedUserIds] — allowlist отправителей.
 * @param {string} [options.webhookUrl] — режим webhook; без туннеля будет ошибка.
 * @param {string} [options.apiBase] — переопределение базы (тесты).
 * @param {Function} [options.fetch] — fetch (тесты).
 * @param {number} [options.pollTimeoutSec] — long polling timeout (0–90).
 * @param {number} [options.marker] — стартовый marker (переживает перезапуск).
 * @param {(marker: number) => void} [options.persistMarker] — сохранение marker.
 * @param {Function} [options.now] — часы.
 * @param {Function} [options.sleep] — пауза.
 * @param {Function} [options.jitter] — джиттер backoff.
 * @param {Function} [options.log] — лог.
 * @returns объект `QuestionTransport` (см. base.js).
 */
export function createMaxTransport(options = {}) {
  if (typeof options.token !== "string" || options.token === "") {
    throw new TypeError("max: нужен токен бота");
  }
  const token = options.token;
  const apiBase = typeof options.apiBase === "string" && options.apiBase !== "" ? options.apiBase : MAX_API_BASE;
  const doFetch = typeof options.fetch === "function" ? options.fetch : globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function"
    ? options.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const jitter = typeof options.jitter === "function" ? options.jitter : (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));
  const log = typeof options.log === "function" ? options.log : () => {};
  const persistMarker = typeof options.persistMarker === "function" ? options.persistMarker : () => {};

  const chatId = options.chatId === undefined || options.chatId === null || options.chatId === "" ? null : options.chatId;
  const userId = options.userId === undefined || options.userId === null || options.userId === "" ? null : options.userId;
  if (chatId === null && userId === null && options.webhookUrl === undefined) {
    throw new TypeError("max: нужен chatId (или userId) привязки");
  }
  const allowed = new Set(
    (Array.isArray(options.allowedUserIds) ? options.allowedUserIds : [])
      .filter((id) => id !== undefined && id !== null)
      .map((id) => String(id)),
  );
  const caps = { ...MAX_CAPS, ...(options.caps ?? {}) };
  const pollTimeoutSec = Math.min(90, Math.max(0, Math.floor(options.pollTimeoutSec ?? 30)));
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const webhookUrl = typeof options.webhookUrl === "string" && options.webhookUrl !== "" ? options.webhookUrl : null;

  let marker = Number.isFinite(options.marker) ? options.marker : null;
  /** Кого увидели в bot_started/bot_added: сессия может взять id отсюда. */
  const detected = { chatId: null, userId: null };
  let running = false;
  let loopPromise = null;
  const sent = new Map();
  const subscribers = new Set();
  const dedupe = new Map();
  let lastError = null;

  /** Один HTTP-вызов MAX с авторизацией заголовком и ретраями 429/503/сеть. */
  async function request(method, path, { query, body, signal, attempts = maxAttempts } = {}) {
    const url = new URL(path, apiBase);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let remaining = attempts;
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await doFetch(url.toString(), {
          method,
          headers: {
            authorization: token,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        remaining -= 1;
        lastError = error;
        if (remaining <= 0 || signal?.aborted) throw error;
        await sleep(jitter(500 * 2 ** (attempt - 1)));
        continue;
      }
      const status = response.status;
      if (status === 200) return response.json();
      const text = maskToken(await safeText(response), token);
      const error = new Error(`MAX ${method} ${path}: ${status}${text === "" ? "" : ` ${text}`}`);
      error.status = status;
      lastError = error;
      if (NO_RETRY.has(status) || remaining <= 1) throw error;
      if (RETRY.has(status) || status >= 500) {
        remaining -= 1;
        await sleep(jitter(500 * 2 ** (attempt - 1)));
        continue;
      }
      throw error;
    }
  }

  async function safeText(response) {
    try {
      const json = await response.json();
      return typeof json?.message === "string" ? json.message : "";
    } catch {
      return "";
    }
  }

  /** Ключ дедупа: глобального update_id у MAX нет. */
  function dedupeKey(update) {
    const chat = update?.chat?.chat_id ?? update?.message?.chat?.chat_id ?? update?.callback?.chat?.chat_id ?? "";
    const stamp = update?.timestamp ?? update?.message?.timestamp ?? update?.callback?.timestamp ?? "";
    const identity = update?.type === "message_callback"
      ? update?.callback?.callback_id ?? ""
      : update?.message?.body?.mid ?? update?.message?.mid ?? "";
    return createHash("sha256").update(`${chat}|${update?.type ?? ""}|${identity}|${stamp}`).digest("hex");
  }

  /** Уже видели это обновление? */
  function isDuplicate(update) {
    const key = dedupeKey(update);
    if (dedupe.has(key)) return true;
    dedupe.set(key, true);
    if (dedupe.size > DEDUPE_LIMIT) dedupe.delete(dedupe.keys().next().value);
    return false;
  }

  /** Отправитель из обновления. */
  function senderOf(update) {
    return update?.callback?.user?.user_id
      ?? update?.message?.sender?.user_id
      ?? update?.user?.user_id
      ?? null;
  }

  /**
   * Пропускать ответ только от привязанного человека и только из привязанного
   * чата. Пустой allowlist — **fail-closed**: MAX-бот публичен по нику, и без
   * списка любой мог бы ответить за человека (канал удалённого управления).
   */
  function allowedSender(update) {
    if (allowed.size === 0) return false;
    const sender = senderOf(update);
    if (sender === null || !allowed.has(String(sender))) return false;
    const updateChat = update?.chat?.chat_id
      ?? update?.callback?.chat?.chat_id
      ?? update?.message?.chat?.chat_id
      ?? null;
    if (chatId !== null) return updateChat !== null && String(updateChat) === String(chatId);
    if (userId !== null) return String(sender) === String(userId);
    return false;
  }

  // Очереди объявляем до обработчиков: ответ на колбэк и правки тоже проходят
  // через троттлинг (MAX ограничивает и POST /answers двумя запросами в секунду).
  const sendQueue = throttle([], MAX_CHAT_RPS_INTERVAL_MS, { now, sleep });
  const editQueue = throttle([], MAX_CHAT_RPS_INTERVAL_MS, { now, sleep });

  /** Ответить на колбэк: один запрос и подтверждает нажатие, и правит сообщение. */
  async function answerCallback(callbackId, text) {
    // Документация MAX: тело — NewMessageBody в поле `message`
    // ({message: {text, format, attachments}}), не «плоский» {text}.
    await editQueue.push(() => request("POST", "/answers", {
      query: { callback_id: callbackId },
      body: { message: { text, format: "html", attachments: [] } },
    })).run();
  }

  /** Раздать ответ подписчикам. */
  function emit(answer) {
    for (const handler of subscribers) {
      try {
        handler(answer);
      } catch (error) {
        log(`max: подписчик ответа упал (${describeError(error, token)})`);
      }
    }
  }

  /** Найти запись по mid сообщения (reply/несколько открытых). */
  function shortIdByMid(mid) {
    for (const [shortId, record] of sent.entries()) {
      if (record.mid === mid) return shortId;
    }
    return null;
  }

  /** Разобрать одно обновление. */
  async function handleUpdate(update) {
    if (isDuplicate(update)) {
      log(`max: дубль обновления ${update?.type ?? "?"} — игнор`);
      return;
    }
    // Служебные события привязки не являются ответами: allowlist к ним не
    // применяем, иначе пустой список (fail-closed) скрыл бы сам факт привязки.
    if (update?.type === "bot_started" || update?.type === "bot_added") {
      const chat = update?.chat?.chat_id ?? update?.message?.chat?.chat_id ?? null;
      const user = update?.user?.user_id ?? update?.message?.sender?.user_id ?? null;
      if (chat !== null) detected.chatId = chat;
      if (user !== null) detected.userId = user;
      log(`max: ${update.type} — бот подключён (chat_id ${chat ?? "?"}, user_id ${user ?? "?"})`);
      return;
    }
    if (!allowedSender(update)) {
      log(`max: отправитель не в allowlist — игнор (${update?.type ?? "?"})`);
      return;
    }

    if (update?.type === "message_callback") {
      const parsed = parseCallbackData(update?.callback?.payload);
      if (parsed === null) {
        log("max: колбэк без нашего payload — игнор");
        return;
      }
      const record = sent.get(parsed.shortId);
      if (record === undefined) {
        log(`max: колбэк для ${parsed.shortId}: вопроса уже нет — игнор`);
        return;
      }
      const label = record.labels.get(parsed.optionId) ?? parsed.optionId;
      emit({
        shortId: parsed.shortId,
        optionIds: [parsed.optionId],
        answeredBy: senderOf(update) === null ? undefined : String(senderOf(update)),
      });
      try {
        await answerCallback(update.callback.callback_id, `✅ Отвечено: ${escapeHtml(label)}`);
      } catch (error) {
        log(`max: подтвердить нажатие не удалось (${describeError(error, token)})`);
      }
      sent.delete(parsed.shortId);
      return;
    }

    if (update?.type === "message_created") {
      const message = update.message;
      const text = typeof message?.body?.text === "string" ? message.body.text.trim() : "";
      if (text === "") return;
      const replyMid = message?.link?.type === "reply" ? message.link.mid : null;
      const shortId = replyMid === null ? (sent.size === 1 ? [...sent.keys()][0] : null) : shortIdByMid(replyMid);
      if (shortId === null) {
        log("max: свободный текст не к какому вопросу не относится — игнор");
        return;
      }
      emit({
        shortId,
        optionIds: [],
        text,
        answeredBy: senderOf(update) === null ? undefined : String(senderOf(update)),
      });
      return;
    }

    if (update?.type === "bot_started" || update?.type === "bot_added") {
      const chat = update?.chat?.chat_id ?? update?.message?.chat?.chat_id ?? null;
      const user = update?.user?.user_id ?? update?.message?.sender?.user_id ?? null;
      if (chat !== null) detected.chatId = chat;
      if (user !== null) detected.userId = user;
      log(`max: ${update.type} — бот подключён (chat_id ${chat ?? "?"}, user_id ${user ?? "?"})`);
    }
  }

  /** Один цикл long polling. */
  async function pollOnce(signal) {
    const response = await request("GET", "/updates", {
      query: {
        timeout: pollTimeoutSec,
        limit: 100,
        ...(marker === null ? {} : { marker }),
        // `types` в MAX описан как string[], а кодирование массива в GET не
        // документировано — не рискуем форматом и фильтруем типы на клиенте.
      },
      signal,
    });
    if (Number.isFinite(response?.marker)) {
      marker = response.marker;
      try {
        persistMarker(marker);
      } catch (error) {
        log(`max: marker не сохранён (${describeError(error, token)})`);
      }
    }
    for (const update of Array.isArray(response?.updates) ? response.updates : []) {
      await handleUpdate(update);
    }
  }

  /** Клавиатура вопроса (attachments MAX) — общая для отправки и правок. */
  function buildKeyboard(question) {
    const shortId = question?.shortId;
    const rows = caps.inlineButtons ? renderRows(question, caps) : [];
    const buttons = rows.map((row) => row.map((button) => {
      const optionId = button.optionId
        ?? (button.kind === "free" ? FREE_TEXT_OPTION : button.kind === "more" ? MORE_OPTION : null);
      return optionId === null
        ? null
        : { type: "callback", text: button.label, payload: callbackData(shortId, optionId) };
    }).filter((button) => button !== null)).filter((row) => row.length > 0);
    return { type: "inline_keyboard", payload: { buttons } };
  }

  const transport = {
    id: "max",
    caps,
    /** Чат привязки: reliability сохраняет его рядом с messageId. */
    get chatId() {
      return chatId;
    },
    get marker() {
      return marker;
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
    /** id, увиденные в bot_started/bot_added (для ручной привязки). */
    get detected() {
      return { ...detected };
    },

    /** Поднять long polling. Повторный вызов безопасен. */
    async start() {
      if (webhookUrl !== null) {
        throw new Error(
          "MAX webhook требует публичный HTTPS:443 и валидный сертификат, а DSH не умеет слушать внешний адрес — "
          + "используйте long polling (GET /updates) или туннель с сертификатом",
        );
      }
      if (running) return transport;
      running = true;
      const controller = new AbortController();
      transport.__controller = controller;
      loopPromise = (async () => {
        while (running) {
          try {
            await pollOnce(controller.signal);
          } catch (error) {
            if (!running) break;
            lastError = error;
            log(`max: поллинг не удался (${describeError(error, token)})`);
            await sleep(jitter(1000));
          }
        }
      })();
      log("max: поллинг запущен");
      return transport;
    },

    /** Остановить поллинг. */
    async stop() {
      running = false;
      try {
        transport.__controller?.abort?.();
      } catch {
        /* уже остановлен */
      }
      await loopPromise;
      loopPromise = null;
      sent.clear();
      sendQueue; // очереди не сбрасываем: stop не должен терять уже начатые задачи
      editQueue;
      log("max: поллинг остановлен");
      return transport;
    },

    /** Отправить вопрос: текст (html) + кнопки по одной в ряд. */
    async sendQuestion(question, sendOptions = {}) {
      const shortId = question?.shortId;
      if (typeof shortId !== "string" || shortId === "") {
        throw new TypeError("max: у вопроса нет shortId — кнопки не соберутся");
      }
      const targetChat = sendOptions?.chatId ?? chatId;
      const query = targetChat !== null ? { chat_id: targetChat } : { user_id: userId };

      const text = clipEscaped(escapeHtml(renderBody(question, caps)), caps.maxText);
      const keyboard = buildKeyboard(question);
      const attachments = keyboard.payload.buttons.length === 0 ? undefined : [keyboard];

      const labels = new Map(
        (Array.isArray(question.options) ? question.options : []).map((option) => [String(option?.id), String(option?.label ?? option?.id ?? "")]),
      );
      labels.set(FREE_TEXT_OPTION, "Другой ответ");
      labels.set(MORE_OPTION, "Показать ещё");

      const body = {
        text,
        format: "html",
        ...(attachments === undefined ? {} : { attachments }),
      };
      const response = await sendQueue.push(() => request("POST", "/messages", { query, body })).run().then((results) => results[0]);
      const mid = response?.message?.body?.mid ?? response?.message?.mid ?? null;
      if (mid !== null) {
        sent.set(shortId, { chatId: targetChat, mid, text, labels, attachments });
      }
      return { messageId: mid };
    },

    /**
     * Правка сообщения по сохранённым `chatId`/`messageId` — после рестарта,
     * когда in-memory `sent` пуст (нужно 008: recover и TTL-пометка).
     */
    async editMessage({ chatId: target, messageId } = {}, text, attachments) {
      if (messageId === undefined || messageId === null) return false;
      await editQueue.push(() => request("PUT", "/messages", {
        query: { message_id: messageId },
        body: {
          text: escapeHtml(text),
          format: "html",
          ...(Array.isArray(attachments) ? { attachments } : {}),
        },
      })).run();
      return true;
    },

    /**
     * Снять кнопки по сохранённым id (после рестарта).
     *
     * Текст **не трогаем**: recover (008) сначала правит его на «сессия
     * перезапущена…», и только потом снимает кнопки. Если нужен новый текст —
     * передайте его вторым аргументом.
     */
    async clearButtons({ messageId } = {}, text) {
      if (messageId === undefined || messageId === null) return false;
      await editQueue.push(() => request("PUT", "/messages", {
        query: { message_id: messageId },
        body: {
          ...(typeof text === "string" && text !== "" ? { text: escapeHtml(text), format: "html" } : {}),
          attachments: [],
        },
      })).run();
      return true;
    },

    /** Правка текста вопроса (напоминание, TTL-пометка). */
    async editQuestion(question, text) {
      const record = sent.get(question?.shortId);
      if (record === undefined) {
        // После рестарта записи нет, но reliability сохраняет id в состоянии.
        // Кнопки восстанавливаем из вопроса: напоминание/TTL-пометка не должны
        // «съесть» клавиатуру.
        const messageId = question?.messageId;
        if (messageId !== undefined && messageId !== null) {
          const attachments = Array.isArray(question?.options) && question.options.length > 0
            ? [buildKeyboard(question)]
            : undefined;
          return transport.editMessage({ messageId }, text, attachments);
        }
        return false;
      }
      await editQueue.push(() => request("PUT", "/messages", {
        query: { message_id: record.mid },
        body: {
          text: escapeHtml(text),
          format: "html",
          ...(record.attachments === undefined ? {} : { attachments: record.attachments }),
        },
      })).run();
      return true;
    },

    /** Закрыть вопрос: кнопки снимаются, текст помечается. */
    async closeQuestion(question, summary = "") {
      const record = sent.get(question?.shortId);
      if (record === undefined) {
        const messageId = question?.messageId;
        if (messageId !== undefined && messageId !== null) {
          // clearButtons сам экранирует текст — здесь не экранируем, иначе двойное.
          const text = QUIET_REASONS.has(summary) ? "⌛ ждёт ответа" : `✅ Отвечено: ${summary}`;
          await transport.clearButtons({ messageId }, text);
        }
        return;
      }
      const quiet = QUIET_REASONS.has(summary);
      const text = quiet ? "⌛ ждёт ответа" : `✅ Отвечено: ${escapeHtml(summary)}`;
      try {
        await editQueue.push(() => request("PUT", "/messages", {
          query: { message_id: record.mid },
          body: { text, format: "html", attachments: [] },
        })).run();
      } catch (error) {
        log(`max: закрыть сообщение ${question.shortId} не удалось (${describeError(error, token)})`);
      }
      sent.delete(question.shortId);
    },

    /** Подписка на ответы; возвращает отписку. */
    onAnswer(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },

    /** Живость: GET /me (токен + связь). */
    async healthCheck() {
      try {
        const me = await request("GET", "/me", { attempts: 1 });
        const name = me?.name ?? me?.username ?? me?.user?.name ?? "?";
        return { ok: true, detail: `бот MAX ${name} на связи` };
      } catch (error) {
        return { ok: false, detail: describeError(error, token) };
      }
    },

    checkTransport() {
      return checkTransport(transport);
    },
  };

  return transport;
}

/** Хелпер для тестов: разложить текст под предел MAX, не потеряв символы. */
export function splitMaxText(text) {
  return splitText(text, MAX_CAPS.maxText);
}

/** Ряды для клавиатуры MAX (не больше 7 в ряд — платформа разрешает 7). */
export function maxRows(buttons = []) {
  return chrome(buttons, 1);
}

export { DEFAULT_CAPS };
