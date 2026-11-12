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
import { FREE_TEXT_OPTION, MORE_OPTION, renderBody, renderHtml, renderRows } from "../present.js";

/** Базовый адрес MAX Bot API: документация просит именно platform-api2. */
export const MAX_API_BASE = "https://platform-api2.max.ru";

/**
 * Запасной адрес **того же** MAX Bot API (048).
 *
 * Сертификат `platform-api2.max.ru` выписан Russian Trusted Sub CA (Минцифры), а
 * его корня нет в trust store macOS/Node — первый же `GET /me` падает с
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. У `platform-api.max.ru` обычный публичный
 * CA и тот же API, поэтому при TLS/сетевой ошибке запрос повторяется туда.
 * Переопределение хоста (`maxApiBase`/`MAX_API_BASE`) фолбэк отключает.
 */
export const MAX_API_FALLBACK_BASE = "https://platform-api.max.ru";

/** Коды Node/OpenSSL, которые означают «сертификат не принят». */
const MAX_TLS_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
]);

/** Коды сетевых сбоев (сюда же попадает undici: `fetch failed`). */
const MAX_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * Развернуть ошибку (включая `cause` undici и `AggregateError.errors`) в коды и
 * тексты. `fetch failed` — это обёртка: настоящая причина лежит в `cause`.
 */
function maxErrorFacts(error) {
  const codes = [];
  const texts = [];
  const seen = new Set();
  const visit = (value) => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (typeof value.code === "string") codes.push(value.code);
    if (typeof value.message === "string") texts.push(value.message);
    if (Array.isArray(value.errors)) for (const item of value.errors) visit(item);
    visit(value.cause);
  };
  visit(error);
  return { codes, texts };
}

/** Это TLS-ошибка (сертификат не принят)? */
export function isMaxTlsError(error) {
  const { codes, texts } = maxErrorFacts(error);
  if (codes.some((code) => MAX_TLS_CODES.has(code) || /^ERR_TLS_|^ERR_SSL_/.test(code))) return true;
  return texts.some((text) => /certificate|issuer|self[- ]signed|TLS|SSL/i.test(text));
}

/**
 * Это сетевой сбой (включая TLS)? Фолбэк хоста включается только на них: 401,
 * 403 и 429 — это токен и лимиты, подмена хоста там только запутает.
 */
export function isMaxNetworkError(error) {
  if (isMaxTlsError(error)) return true;
  const { codes, texts } = maxErrorFacts(error);
  if (codes.some((code) => MAX_NETWORK_CODES.has(code) || /^ERR_NETWORK|^UND_ERR_/.test(code))) return true;
  return texts.some((text) => /fetch failed|socket hang up|network|timed? ?out|ECONN|ENOTFOUND|EAI_AGAIN/i.test(text));
}

function nonEmptyBase(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Хост с портом для человеческого текста; кривой URL возвращаем как есть. */
export function maxHostOf(base) {
  try {
    return new URL(base).host;
  } catch {
    return String(base ?? "");
  }
}

/**
 * Куда обращаться: явное переопределение (`maxApiBase`/`MAX_API_BASE`) или
 * штатный api2 с запасной базой (тот же API, публичный CA).
 *
 * @param {object} options
 * @param {string} [options.apiBase] — явная база (config.maxApiBase, тесты).
 * @param {object} [options.env] — окружение (по умолчанию `process.env`).
 * @returns {{primary: string, fallback: (string|null), overridden: boolean}}
 */
export function maxApiEndpoint({ apiBase, env = globalThis.process?.env ?? {} } = {}) {
  const explicit = nonEmptyBase(apiBase) ?? nonEmptyBase(env?.MAX_API_BASE);
  if (explicit !== null) return { primary: explicit, fallback: null, overridden: true };
  return { primary: MAX_API_BASE, fallback: MAX_API_FALLBACK_BASE, overridden: false };
}

/**
 * Явная база из конфига профиля (048): `config.maxApiBase` главнее
 * `config.max.apiBase`, пустая строка — «не задано».
 */
export function maxApiBaseFromConfig(config) {
  const top = nonEmptyBase(config?.maxApiBase);
  if (top !== null) return top;
  return nonEmptyBase(config?.max?.apiBase);
}

/**
 * Понятная ошибка «MAX недоступен»: без `fetch failed` и без токена.
 *
 * Для TLS-причины объясняем про Russian Trusted CA и даём два варианта
 * (фолбэк на `platform-api.max.ru` или `NODE_EXTRA_CA_CERTS`); для сети —
 * про прокси/файрвол. Код `MAX_TLS`/`MAX_NETWORK` позволяет команде `connect`
 * не писать сверху «MAX не принял токен».
 */
export function maxUnreachableError({ primary, fallback = null, tried = [] } = {}) {
  const items = (Array.isArray(tried) ? tried : []).filter((item) => item !== null && item !== undefined);
  const hosts = items.length > 0
    ? items.map((item) => maxHostOf(item.base))
    : [maxHostOf(primary ?? MAX_API_BASE)];
  const tls = items.some((item) => isMaxTlsError(item.error));

  if (tls) {
    const fallbackHost = maxHostOf(fallback ?? MAX_API_FALLBACK_BASE);
    const both = hosts.length > 1 ? ` Пробовали ${hosts.join(" и ")} — TLS не прошёл ни там, ни там.` : "";
    const fallbackOption = fallback === null
      ? `(а) убрать переопределение хоста (maxApiBase/MAX_API_BASE) — тогда плагин сам повторит запрос на ${fallbackHost}`
      : `(а) оставить фолбэк на ${fallbackHost} — плагин повторяет запрос туда автоматически`;
    const message = `TLS к MAX не проходит: сертификат ${hosts[0]} выписан Russian Trusted Sub CA (Минцифры), `
      + `и его корня нет в доверенных хранилищах macOS/Node.${both} `
      + `Варианты: ${fallbackOption}; (б) добавить корень Минцифры в доверенные: `
      + "NODE_EXTRA_CA_CERTS=/путь/к/russian_trusted_root_ca.pem";
    const error = new Error(message);
    error.code = "MAX_TLS";
    error.tried = items.map((item) => ({ base: item.base, error: item.error }));
    return error;
  }

  const message = `MAX недоступен по сети: ${hosts.join(" и ")}. `
    + "Проверьте интернет, прокси и файрвол; хост можно задать явно через maxApiBase или MAX_API_BASE.";
  const error = new Error(message);
  error.code = "MAX_NETWORK";
  error.tried = items.map((item) => ({ base: item.base, error: item.error }));
  return error;
}

/** Возможности MAX: кнопки есть, править можно, текст ≤ 4000, вариантов ≤ 7. */
export const MAX_CAPS = Object.freeze({
  inlineButtons: true,
  editAfterAnswer: true,
  maxText: 4000,
  maxOptions: 7,
});

/** Лимит платформы: не больше 2 запросов в секунду в один чат. */
export const MAX_CHAT_RPS_INTERVAL_MS = 500;

/**
 * Таймаут long polling для pairing (`GET /updates?timeout=…`), секунды.
 * 039: без него MAX-опрос был бы коротким раз в секунду (лишняя нагрузка).
 */
export const MAX_PAIRING_POLL_TIMEOUT_SEC = 5;

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
  // 012: проигравший канал закрывается с пометкой, а не «✅ Отвечено».
  "answered-elsewhere",
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

/**
 * 047: HTML обязан влезть в `caps.maxText`, не разрывая `<pre>/<code>`.
 *
 * Сначала ужимаем **plain-текст** (renderBody сам держит место под подсказку),
 * затем рендерим HTML. Если теги/экранирование всё же вывели за лимит — режем
 * готовый HTML по границе тега и закрываем открытые `<pre>/<code>`, а не как
 * раньше «по сырым символам» с незакрытым `<pre>`.
 */
function clipHtml(text, limit) {
  if (text.length <= limit) return text;
  let cut = text.slice(0, Math.max(0, limit - 8));
  const lastOpen = cut.lastIndexOf("<");
  const lastClose = cut.lastIndexOf(">");
  if (lastOpen > lastClose) cut = cut.slice(0, lastOpen);
  const preOpen = (cut.match(/<pre>/g) ?? []).length - (cut.match(/<\/pre>/g) ?? []).length;
  const codeOpen = (cut.match(/<code>/g) ?? []).length - (cut.match(/<\/code>/g) ?? []).length;
  let suffix = "…";
  for (let index = 0; index < Math.max(0, codeOpen); index += 1) suffix += "</code>";
  for (let index = 0; index < Math.max(0, preOpen); index += 1) suffix += "</pre>";
  return `${cut.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

/** 047: plain → HTML с бюджетом на теги, без обрыва подсказки. */
function renderMaxHtml(question, caps) {
  const max = Number.isFinite(caps?.maxText) ? caps.maxText : MAX_CAPS.maxText;
  let budget = max;
  let html = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const plain = renderBody(question, { ...caps, maxText: budget });
    html = renderHtml(plain);
    if (html.length <= max) return html;
    budget = Math.max(40, budget - (html.length - max) - 8);
  }
  const plain = renderBody(question, { ...caps, maxText: Math.max(40, max - 64) });
  html = renderHtml(plain);
  return html.length <= max ? html : clipHtml(html, max);
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
  // 048: штатно api2, а при TLS/сетевой ошибке — platform-api.max.ru (тот же API).
  // Явный apiBase (config.maxApiBase/MAX_API_BASE) фолбэк отключает.
  const endpoint = maxApiEndpoint({ apiBase: options.apiBase });
  let activeBase = endpoint.primary;
  let fallbackUsed = false;
  /** Последние ошибки по базам: из них собирается понятный текст (048). */
  let triedBases = [];
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
    const urlOf = (base) => {
      const url = new URL(path, base);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      return url;
    };
    let remaining = attempts;
    for (let attempt = 1; ; attempt += 1) {
      let response;
      try {
        response = await doFetch(urlOf(activeBase).toString(), {
          method,
          headers: {
            authorization: token,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        // Отмена — не сбой сети: отдаём как есть, фолбэк и текст про TLS не нужны.
        if (signal?.aborted) throw error;
        const recorded = triedBases.find((item) => item.base === activeBase);
        if (recorded === undefined) triedBases.push({ base: activeBase, error });
        else recorded.error = error;
        // 048: TLS/сеть на api2 — сразу пробуем запасной хост, попытку не тратим.
        if (endpoint.fallback !== null && activeBase !== endpoint.fallback && isMaxNetworkError(error)) {
          activeBase = endpoint.fallback;
          fallbackUsed = true;
          log(`max: ${maxHostOf(endpoint.primary)} недоступен по TLS/сети (${describeError(error, token)}) — `
            + `повторяю запрос через ${maxHostOf(endpoint.fallback)}`);
          continue;
        }
        remaining -= 1;
        if (remaining <= 0) {
          // 048: понятный текст — про TLS (сертификат Минцифры); обычный сбой сети
          // отдаём как есть, чтобы не выдавать сетевую проблему за сертификат.
          if (triedBases.some((item) => isMaxTlsError(item.error))) {
            const friendly = maxUnreachableError({
              primary: endpoint.primary,
              fallback: endpoint.fallback,
              tried: triedBases,
            });
            lastError = friendly;
            throw friendly;
          }
          lastError = error;
          throw error;
        }
        await sleep(jitter(500 * 2 ** (attempt - 1)));
        continue;
      }
      const status = response.status;
      if (status === 200) {
        // Успех: прежние сетевые ошибки больше не описывают текущее состояние.
        triedBases = [];
        return response.json();
      }
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
    const chat = update?.chat?.chat_id ?? update?.message?.chat?.chat_id ?? update?.callback?.chat?.chat_id
      ?? update?.message?.recipient?.chat_id ?? update?.callback?.message?.recipient?.chat_id ?? "";
    const stamp = update?.timestamp ?? update?.message?.timestamp ?? update?.callback?.timestamp ?? "";
    const type = updateType(update);
    const identity = type === "message_callback"
      ? update?.callback?.callback_id ?? ""
      : update?.message?.body?.mid ?? update?.message?.mid ?? "";
    return createHash("sha256").update(`${chat}|${type ?? ""}|${identity}|${stamp}`).digest("hex");
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
  /**
   * Чаты, из которых принимаем ответы: привязка + каналы проектов (015).
   * Функция — чтобы `/remote channel` менял набор без перезапуска.
   */
  function allowedChatSet() {
    const extra = typeof options.allowedChatIds === "function" ? options.allowedChatIds() : options.allowedChatIds;
    return new Set(
      [chatId, ...(Array.isArray(extra) ? extra : [])]
        .filter((item) => item !== undefined && item !== null && item !== "")
        .map((item) => String(item)),
    );
  }

  function allowedSender(update) {
    if (allowed.size === 0) return false;
    const sender = senderOf(update);
    if (sender === null || !allowed.has(String(sender))) return false;
    // 054: legacy-хост кладёт chat в message.recipient, а не в callback.chat.
    const updateChat = update?.chat?.chat_id
      ?? update?.callback?.chat?.chat_id
      ?? update?.message?.chat?.chat_id
      ?? update?.message?.recipient?.chat_id
      ?? update?.callback?.message?.recipient?.chat_id
      ?? null;
    if (chatId !== null) return updateChat !== null && allowedChatSet().has(String(updateChat));
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
      log(`max: дубль обновления ${updateType(update) ?? "?"} — игнор`);
      return;
    }
    const type = updateType(update);
    // Служебные события привязки не являются ответами: allowlist к ним не
    // применяем, иначе пустой список (fail-closed) скрыл бы сам факт привязки.
    if (type === "bot_started" || type === "bot_added") {
      const chat = update?.chat?.chat_id ?? update?.message?.chat?.chat_id ?? update?.message?.recipient?.chat_id ?? null;
      const user = update?.user?.user_id ?? update?.message?.sender?.user_id ?? null;
      if (chat !== null) detected.chatId = chat;
      if (user !== null) detected.userId = user;
      log(`max: ${type} — бот подключён (chat_id ${chat ?? "?"}, user_id ${user ?? "?"})`);
      return;
    }
    if (!allowedSender(update)) {
      log(`max: отправитель не в allowlist — игнор (${type ?? "?"})`);
      return;
    }

    if (type === "message_callback") {
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

    if (type === "message_created") {
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

    // 054: legacy-хост присылает update_type; неизвестный/неразобранный тип
    // больше не теряется молча — в журнале видно, что именно пришло.
    log(`max: неизвестный тип апдейта ${type ?? "(пусто)"} — игнор`);
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
    /** Активная база MAX: после TLS-фолбэка здесь `platform-api.max.ru` (048). */
    get apiBase() {
      return activeBase;
    },
    /**
     * Куда ходим и почему (048; doctor/status): `active` — рабочая база,
     * `fallbackUsed` — сработал ли фолбэк, `overridden` — задан ли хост явно.
     */
    get endpoint() {
      return {
        primary: endpoint.primary,
        fallback: endpoint.fallback,
        active: activeBase,
        fallbackUsed,
        overridden: endpoint.overridden,
      };
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

      const text = renderMaxHtml(question, caps);
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
          const text = summary === "answered-elsewhere"
            ? "Отвечено в другом канале"
            : QUIET_REASONS.has(summary)
              ? "⌛ ждёт ответа"
              : `✅ Отвечено: ${summary}`;
          await transport.clearButtons({ messageId }, text);
        }
        return;
      }
      const quiet = QUIET_REASONS.has(summary);
      const text = summary === "answered-elsewhere"
        ? "Отвечено в другом канале"
        : quiet
          ? "⌛ ждёт ответа"
          : `✅ Отвечено: ${escapeHtml(summary)}`;
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

/**
 * Низкоуровневый вызов MAX API без транспорта (039): нужен для `connect`, пока
 * нет chatId/userId — транспорт создаётся только после привязки.
 */
export async function maxApiRequest({
  token,
  method = "GET",
  path,
  query,
  body,
  apiBase,
  fetch: doFetch = globalThis.fetch,
  signal,
  /** 050: предел одного HTTP-запроса (мс), чтобы pairing не висел вечно. */
  timeoutMs = 15_000,
  /** Внутренний хук (048): какой базой в итоге ответили — им пользуются connect/polling. */
  onBase,
  env = globalThis.process?.env ?? {},
} = {}) {
  if (typeof token !== "string" || token === "") throw new TypeError("max: нужен токен бота");
  const endpoint = maxApiEndpoint({ apiBase, env });
  const bases = endpoint.fallback === null ? [endpoint.primary] : [endpoint.primary, endpoint.fallback];
  const tried = [];
  let response = null;
  let usedBase = null;
  for (let index = 0; index < bases.length; index += 1) {
    const base = bases[index];
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    try {
      // 050: каждый запрос ограничен по времени; внешний signal (отмена вопроса)
      // комбинируется с таймаутом, а не подменяется.
      const timeoutSignal = typeof AbortSignal?.timeout === "function" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? AbortSignal.timeout(timeoutMs)
        : null;
      const combinedSignal = signal !== undefined && timeoutSignal !== null
        ? (typeof AbortSignal?.any === "function" ? AbortSignal.any([signal, timeoutSignal]) : signal)
        : (signal ?? timeoutSignal);
      response = await doFetch(url.toString(), {
        method,
        headers: {
          authorization: token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(combinedSignal === null || combinedSignal === undefined ? {} : { signal: combinedSignal }),
      });
      usedBase = base;
      break;
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        const timeoutError = new Error(`MAX ${method} ${path}: таймаут ${timeoutMs} мс`);
        timeoutError.code = "MAX_TIMEOUT";
        timeoutError.retryable = true;
        throw timeoutError;
      }
      if (signal?.aborted) throw error;
      tried.push({ base, error });
      // 048: фолбэк только на TLS/сеть (401/403/429 — это токен и лимиты).
      const hasNext = index < bases.length - 1;
      if (hasNext && isMaxNetworkError(error)) continue;
      if (tried.some((item) => isMaxTlsError(item.error))) {
        throw maxUnreachableError({ primary: endpoint.primary, fallback: endpoint.fallback, tried });
      }
      throw new Error(`MAX ${method} ${path}: сеть недоступна (${describeError(error, token)})`);
    }
  }
  if (typeof onBase === "function") {
    onBase({
      base: usedBase,
      primary: endpoint.primary,
      fallback: endpoint.fallback,
      fallbackUsed: usedBase !== endpoint.primary,
      overridden: endpoint.overridden,
    });
  }
  if (response.status === 200) return response.json();
  let detail = "";
  let payloadValue;
  try {
    const payload = await response.json();
    detail = typeof payload?.message === "string" ? describeError(new Error(payload.message), token) : "";
    payloadValue = payload?.retry_after ?? payload?.retryAfter;
  } catch {
    detail = "";
  }
  const error = new Error(`MAX ${method} ${path}: ${response.status}${detail === "" ? "" : ` ${detail}`}`);
  error.status = response.status;
  error.host = usedBase;
  // 050: 429 — пауза по retry_after (заголовок или поле тела), иначе 1 с.
  const headerRetry = typeof response.headers?.get === "function" ? response.headers.get("retry-after") : null;
  let retryAfter = Number(headerRetry);
  if (!Number.isFinite(retryAfter) && payloadValue !== undefined) {
    const value = Number(payloadValue);
    if (Number.isFinite(value)) retryAfter = value;
  }
  if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfterMs = Math.floor(retryAfter * 1000);
  throw error;
}

/**
 * `GET /me`: проверить токен бота MAX до привязки.
 *
 * Возвращает ещё и базу, которая ответила (048): если api2 не прошёл TLS, а
 * platform-api — прошёл, `connect` доопрашивает pairing уже по рабочему хосту.
 */
export async function maxMe({ token, apiBase, fetch: doFetch } = {}) {
  let used = null;
  const me = await maxApiRequest({
    token,
    path: "/me",
    apiBase,
    fetch: doFetch,
    onBase: (info) => {
      used = info;
    },
  });
  return {
    name: typeof me?.name === "string" && me.name !== ""
      ? me.name
      : typeof me?.username === "string" && me.username !== ""
        ? me.username
        : typeof me?.user?.name === "string" && me.user.name !== ""
          ? me.user.name
          : null,
    apiBase: used?.base ?? null,
    fallbackUsed: used?.fallbackUsed === true,
    primaryBase: used?.primary ?? null,
  };
}

/**
 * Ждём сообщение с pairing-кодом боту MAX (`GET /updates`, long polling).
 *
 * Возвращает `{chatId, userId, marker}` или `null`, если код не пришёл до
 * `deadline`. `marker` сохраняется вызывающим (в состоянии привязки), чтобы
 * после привязки транспорт не перечитал старые апдейты.
 */
export async function maxPollForCode({
  token,
  code,
  deadline,
  pollTimeoutSec = MAX_PAIRING_POLL_TIMEOUT_SEC,
  apiBase,
  fetch: doFetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
  log = () => {},
  /** 050: сюда складывается диагностика для текста ошибки (`polls/updates/types/host`). */
  stats = null,
  timeoutMs = 15_000,
} = {}) {
  let marker = null;
  // 048: как только один из хостов ответил, дальше опрашиваем именно его —
  // иначе каждый long polling начинался бы с падения на TLS у api2.
  let workingBase = apiBase;
  let waitMs = 1_000;
  let attempt = 0;
  const counts = stats ?? { polls: 0, updates: 0, types: new Set(), codeSeen: 0, host: null };

  while (now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error("подключение отменено"), { name: "AbortError" });
    const remainingSec = Math.max(0, Math.ceil((deadline - now()) / 1000));
    const requestTimeoutSec = Math.max(0, Math.floor(pollTimeoutSec));
    let response;
    try {
      response = await maxApiRequest({
        token,
        path: "/updates",
        query: {
          timeout: Math.min(90, requestTimeoutSec),
          limit: 100,
          ...(marker === null ? {} : { marker }),
        },
        apiBase: workingBase,
        fetch: doFetch,
        signal,
        timeoutMs: Math.max(1_000, Math.min(timeoutMs, Math.max(0, deadline - now()))),
        onBase: (info) => {
          if (typeof info?.base === "string") {
            workingBase = info.base;
            counts.host = info.base;
          }
        },
      });
      waitMs = 1_000;
      attempt = 0;
      counts.lastError = null;
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      const status = Number(error?.status ?? 0);
      // 401/403 — токен/активация бота: повторять бессмысленно, пусть человек чинит.
      if (status === 401 || status === 403) throw error;
      attempt += 1;
      counts.lastError = { status, code: error?.code ?? null, retryAfterMs: error?.retryAfterMs ?? null, message: describeError(error, token) };
      let pause = waitMs;
      if (status === 429) {
        pause = Math.max(1_000, Number(error?.retryAfterMs ?? 0) || 1_000);
        log(`max pairing: 429 rate limit, пауза ${Math.round(pause / 1000)} с (retry_after)`);
      } else {
        pause = Math.min(10_000, waitMs * 2 ** Math.min(4, attempt - 1));
        log(`max pairing: опрос не удался (${describeError(error, token)}), backoff ${pause} мс`);
      }
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(pause, left));
      continue;
    }
    counts.polls += 1;
    if (Number.isFinite(response?.marker)) marker = response.marker;
    const updates = Array.isArray(response?.updates) ? response.updates : [];
    counts.updates += updates.length;
    for (const update of updates) {
      const type = updateType(update);
      if (type !== null) counts.types.add(type);
    }
    // 050: одна строка на каждый опрос — по ней видно «пусто» vs «пришло, но не разобрали».
    const types = counts.types.size === 0 ? "—" : [...counts.types].join(",");
    const found = findPairingUpdate(updates, code);
    if (found.codeSeen) counts.codeSeen += 1;
    log(`max pairing: poll host=${counts.host ?? workingBase ?? "?"} updates=${updates.length} types=${types} code=${found.codeSeen ? "yes" : "no"}`);
    if (found.match !== null) return { ...found.match, marker, stats: counts };
    // Long polling уже ждал ответ `pollTimeoutSec`; короткий опрос (0) — пауза 1 с.
    await sleep(pollTimeoutSec > 0 ? 200 : 1000);
  }
  stats && Object.assign(stats, counts);
  return null;
}

/** Тип апдейта с учётом v1/v2: `type`, `update_type` или вложенный `update.update_type`. */
export function updateType(update) {
  for (const value of [update?.type, update?.update_type, update?.message?.type, update?.update?.update_type, update?.update?.type]) {
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

/**
 * Найти pairing-код в апдейте, не завися от схемы v1/v2.
 *
 * Код ищем в сериализованном апдейте (любая вложенность), id — по цепочке
 * известных путей. Возвращает `{match, codeSeen}`; `match` — `{chatId,userId}`.
 */
export function findPairingUpdate(updates, code) {
  let codeSeen = false;
  for (const update of Array.isArray(updates) ? updates : []) {
    let serialized = "";
    try {
      serialized = JSON.stringify(update);
    } catch {
      serialized = "";
    }
    if (serialized.includes(code)) codeSeen = true;
    // v2 иногда заворачивает событие в `update`; разбираем и плоскую, и вложенную форму.
    const base = update?.update !== null && typeof update?.update === "object" ? update.update : update;
    const userId = base?.message?.sender?.user_id
      ?? base?.user?.user_id
      ?? base?.sender?.user_id
      ?? base?.message?.sender?.id
      ?? null;
    const chatId = base?.message?.recipient?.chat_id
      ?? base?.message?.chat?.chat_id
      ?? base?.chat?.chat_id
      ?? base?.chat_id
      ?? base?.recipient?.chat_id
      ?? null;
    if (serialized.includes(code) && chatId !== null && userId !== null) {
      return { match: { chatId, userId }, codeSeen: true };
    }
  }
  return { match: null, codeSeen };
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
