/**
 * Транспорт `relay`: свой сервер по протоколу v1 (задачи 016/017, дополнения 023).
 *
 * Плагин не знает, что релей написан на Rust: он видит HTTP/JSON и поток
 * событий. Контракт транспорта — `QuestionTransport` из `./base.js`.
 *
 * Что важно:
 *   - `sendQuestion` — `POST /v1/questions` с wrapper `{question}`; повтор с тем
 *     же `id` идемпотентен на сервере (`ON CONFLICT(id)`), дубля не будет;
 *   - `closeQuestion` — в протоколе v1 **нет** операции закрытия: вопросы живут до
 *     ответа или TTL. Транспорт снимает локальную запись и перестаёт ждать ответ,
 *     сервер закроет вопрос сам (это зафиксировано в README и карточке);
 *   - `onAnswer` — WebSocket `GET /v1/events` (если платформа умеет заголовок
 *     `Authorization`), иначе long-poll `GET /v1/answers?questionId=&wait=`.
 *     При разрыве WS — переподключение с backoff, на время простоя — long-poll;
 *   - токен и pairing-код никогда не попадают в логи: всё, что уходит в `log`,
 *     проходит через `redact`.
 *
 * Сеть целиком инжектируется (`fetch`, `wsFactory`, `sleep`), поэтому тесты
 * гоняют сценарии без единого реального запроса.
 *
 * @typedef {import("./base.js").TransportAnswer} TransportAnswer
 */

import { DEFAULT_CAPS } from "./base.js";

/** Заголовок версии протокола: обязателен для каждого запроса (016 §2). */
export const RELAY_VERSION = "1";

/** Служебное имя секрета с токеном агента релея. */
export const RELAY_TOKEN_REF = "DSH_REMOTE_RELAY_TOKEN";

/** База backoff переподключения: 1 с, удвоение до 30 с. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** Сколько секунд держим long-poll (сервер режет по своему максимуму 25 с). */
const LONG_POLL_SECONDS = 25;

const noopLog = () => {};

/** Ошибка релея: код протокола и признак «можно повторить». */
export class RelayError extends Error {
  constructor(message, { status = 0, code = "", retryable = false, detail = "" } = {}) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

/** Вырезать секреты из строки: токен не должен попасть в лог/ошибку. */
export function redact(text, secret) {
  const source = String(text ?? "");
  if (typeof secret !== "string" || secret === "") return source;
  return source.split(secret).join("***");
}

function abortError() {
  const error = new Error("relay: остановлено");
  error.name = "AbortError";
  return error;
}

function joinUrl(base, path) {
  return `${String(base ?? "").replace(/\/+$/, "")}${path}`;
}

/**
 * Создать транспорт релея.
 *
 * @param {object} options
 * @param {string} options.url — базовый URL релея (`https://relay.example`).
 * @param {string} options.agentToken — Bearer агента (публикация вопросов, чтение ответов).
 * @param {string|null} [options.deviceToken] — токен устройства (если релей различает).
 * @param {string|null} [options.keyId] — id ключа e2e (конверт подключается задачей 021).
 * @param {typeof fetch} [options.fetch] — инжектируемая сеть.
 * @param {(url: string, headers: object) => object} [options.wsFactory] — фабрика WS.
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {() => number} [options.now]
 * @param {() => number} [options.jitter]
 * @param {(message: string) => void} [options.log]
 * @returns {object} транспорт, проходящий `checkTransport`.
 */
export function createRelayTransport({
  url,
  agentToken = null,
  deviceToken = null,
  keyId = null,
  fetch: fetchImpl = globalThis.fetch,
  wsFactory = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimeout: setTimeoutImpl = setTimeout,
  clearTimeout: clearTimeoutImpl = clearTimeout,
  now = () => Date.now(),
  jitter = () => Math.random(),
  log = noopLog,
  longPollSeconds = LONG_POLL_SECONDS,
  reconnectBaseMs = BACKOFF_BASE_MS,
  reconnectMaxMs = BACKOFF_MAX_MS,
} = {}) {
  if (typeof url !== "string" || url === "") throw new TypeError("relay: нужен url");
  const token = typeof agentToken === "string" && agentToken !== "" ? agentToken : deviceToken;
  if (typeof token !== "string" || token === "") {
    throw new TypeError("relay: нужен токен агента (ctx.credentials) — без него вопросы не публикуются");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("relay: нужен fetch");

  const caps = Object.freeze({
    ...DEFAULT_CAPS,
    // Кнопки рисует клиент релея, а не плагин; правка сообщения протоколом v1 не
    // предусмотрена (вопрос закрывается ответом или TTL).
    inlineButtons: false,
    editAfterAnswer: false,
    maxText: 4000,
    maxOptions: 10,
  });

  /** Вопросы, которые мы отправили и ещё ждём: `questionId → {shortId, question}`. */
  const sent = new Map();
  /** Отвеченные/закрытые локально: повторный ответ не эмитим. */
  const settled = new Set();
  /** Подписчики на ответы. */
  const handlers = new Set();

  let started = false;
  let stopped = false;
  let ws = null;
  let wsAbort = null;
  let reconnectTimer = null;
  let pollAbort = null;
  let pollLoop = null;
  let attempts = 0;

  const safeLog = (message) => log(redact(message, token));

  function authHeaders() {
    return {
      authorization: `Bearer ${token}`,
      "x-relay-version": RELAY_VERSION,
      "content-type": "application/json",
    };
  }

  /** HTTP-вызов с разбором ошибок протокола (тело `{error:{code,message,...}}`). */
  async function call(method, path, body, { signal } = {}) {
    let response;
    try {
      response = await fetchImpl(joinUrl(url, path), {
        method,
        headers: authHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw abortError();
      // Сеть: сообщение без токена.
      throw new RelayError(`relay: сеть недоступна (${redact(error?.message ?? error, token)})`, { retryable: true });
    }
    const text = typeof response.text === "function" ? await response.text() : "";
    let payload = null;
    if (text !== "") {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new RelayError(`relay: ответ не JSON (${method} ${path})`, { status: response.status ?? 0 });
      }
    }
    const status = response.status ?? (response.ok ? 200 : 500);
    if (status >= 400) {
      const code = payload?.error?.code ?? "";
      const message = payload?.error?.message ?? `HTTP ${status}`;
      throw new RelayError(`relay: ${code || "error"} — ${redact(message, token)}`, {
        status,
        code,
        retryable: payload?.error?.retryable === true || status >= 500 || status === 429,
        detail: redact(payload?.error?.details === undefined ? "" : JSON.stringify(payload.error.details), token),
      });
    }
    return payload;
  }

  /** Тело вопроса по контракту 023 (открытый режим; e2e — задача 021). */
  function questionPayload(question) {
    const body = {
      id: question?.id,
      shortId: question?.shortId,
      createdAt: new Date(question?.createdAt ?? now()).toISOString(),
      expiresAt: new Date(question?.expiresAt ?? now() + 30 * 60 * 1000).toISOString(),
      options: (question?.options ?? []).map((option) => ({ id: option.id, label: option.label })),
    };
    if (typeof question?.workspace === "string") body.workspace = question.workspace;
    if (typeof question?.taskId === "string") body.taskId = question.taskId;
    if (typeof question?.role === "string") body.role = question.role;
    if (typeof question?.title === "string") body.title = question.title;
    if (typeof question?.body === "string") body.body = question.body;
    if (typeof question?.detail === "string") body.detail = question.detail;
    if (question?.multiSelect === true) body.multiSelect = true;
    // 5) allowFreeText — булево поле контракта: отправляем и true, и false.
    if (typeof question?.allowFreeText === "boolean") body.allowFreeText = question.allowFreeText;
    // keyId здесь НЕ отправляем: в 016/023 у Question такого поля нет, а релей 017
    // отвергает неизвестные поля (400). Он нужен только конверту e2e (задача 021),
    // поэтому живёт в конфиге транспорта и попадёт в `enc`, а не в открытую часть.
    return body;
  }

  function emit(answer) {
    for (const handler of handlers) {
      try {
        handler(answer);
      } catch (error) {
        safeLog(`relay: обработчик ответа упал (${error?.message ?? error})`);
      }
    }
  }

  /** Забрать ответ по questionId и превратить в `TransportAnswer`. */
  async function fetchAnswer(questionId) {
    if (settled.has(questionId)) return null;
    const record = sent.get(questionId);
    if (record === undefined) return null;
    const answer = await call("GET", `/v1/answers?questionId=${encodeURIComponent(questionId)}`);
    const selected = Array.isArray(answer?.selected) ? answer.selected : [];
    const text = typeof answer?.custom === "string" ? answer.custom : "";
    settled.add(questionId);
    sent.delete(questionId);
    return {
      shortId: record.shortId,
      optionIds: selected,
      ...(text === "" ? {} : { text }),
    };
  }

  /** Long-poll: пока WS недоступен, ждём ответы по одному вопросу за раз. */
  async function pollLoopFn(signal) {
    while (!stopped && !signal.aborted) {
      const open = [...sent.keys()];
      if (open.length === 0) {
        await sleep(250);
        continue;
      }
      let progressed = false;
      for (const questionId of open) {
        if (stopped || signal.aborted) return;
        let answer;
        try {
          answer = await call(
            "GET",
            `/v1/answers?questionId=${encodeURIComponent(questionId)}&wait=${longPollSeconds}`,
            undefined,
            { signal },
          );
        } catch (error) {
          if (error?.name === "AbortError") return;
          if (error?.retryable !== true) {
            safeLog(`relay: long-poll ${questionId}: ${error?.message ?? error}`);
            await sleep(1_000);
            continue;
          }
          await sleep(backoffDelay());
          continue;
        }
        const record = sent.get(questionId);
        if (record === undefined || settled.has(questionId)) continue;
        const selected = Array.isArray(answer?.selected) ? answer.selected : [];
        const text = typeof answer?.custom === "string" ? answer.custom : "";
        settled.add(questionId);
        sent.delete(questionId);
        progressed = true;
        emit({ shortId: record.shortId, optionIds: selected, ...(text === "" ? {} : { text }) });
      }
      if (!progressed) await sleep(250);
    }
  }

  function backoffDelay() {
    const base = reconnectBaseMs * 2 ** Math.min(attempts, 10);
    const capped = Math.min(base, reconnectMaxMs);
    return Math.round(capped * (0.8 + jitter() * 0.4));
  }

  /** Поднять WS-поток: события `question.answered` → забрать ответ HTTP-ом. */
  function openSocket() {
    if (stopped) return;
    if (typeof wsFactory !== "function") {
      // Платформа не умеет WebSocket с заголовком Authorization — работаем
      // long-poll'ом (он и есть fallback по контракту).
      startPolling();
      return;
    }
    let socket;
    try {
      socket = wsFactory(joinUrl(url, "/v1/events"), authHeaders());
    } catch (error) {
      safeLog(`relay: WS не открылся (${error?.message ?? error}) — fallback на long-poll`);
      startPolling();
      scheduleReconnect();
      return;
    }
    ws = socket;
    wsAbort = new AbortController();
    socket.addEventListener("open", () => {
      attempts = 0;
      safeLog("relay: WS подключён");
    });
    socket.addEventListener("message", (event) => {
      void onSocketMessage(event?.data);
    });
    socket.addEventListener("close", () => {
      ws = null;
      if (stopped) return;
      safeLog("relay: WS закрыт — переподключаюсь");
      startPolling();
      scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      safeLog("relay: ошибка WS — fallback на long-poll");
      try {
        socket.close?.();
      } catch {
        /* уже закрыт */
      }
    });
  }

  async function onSocketMessage(data) {
    let event;
    try {
      event = typeof data === "string" ? JSON.parse(data) : null;
    } catch {
      return;
    }
    const questionId = event?.questionId;
    if (typeof questionId !== "string") return;
    if (event?.type === "question.expired") {
      // Истёкший вопрос больше не ждёт ответа: иначе long-poll продолжил бы его
      // опрашивать до бесконечности.
      settled.add(questionId);
      sent.delete(questionId);
      safeLog(`relay: вопрос ${questionId} истёк — снимаю с ожидания`);
      return;
    }
    if (event?.type !== "question.answered") return;
    try {
      const answer = await fetchAnswer(questionId);
      if (answer !== null) emit(answer);
    } catch (error) {
      safeLog(`relay: ответ ${questionId} не прочитан (${error?.message ?? error})`);
      if (error?.retryable === true) startPolling();
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    const delay = backoffDelay();
    attempts += 1;
    reconnectTimer = setTimeoutImpl(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
    reconnectTimer?.unref?.();
  }

  function startPolling() {
    if (stopped || pollLoop !== null) return;
    pollAbort = new AbortController();
    pollLoop = pollLoopFn(pollAbort.signal).catch((error) => {
      if (error?.name !== "AbortError") safeLog(`relay: long-poll остановился (${error?.message ?? error})`);
    });
  }

  const transport = {
    id: "relay",
    caps,

    async start() {
      if (started) return transport;
      started = true;
      // Проверяем связь и версию: неверный токен должен быть виден сразу.
      const health = await transport.healthCheck();
      if (!health.ok) safeLog(`relay: сервер не готов (${health.detail}) — транспорт поднимется, но вопросы будут падать`);
      openSocket();
      return transport;
    },

    async stop() {
      stopped = true;
      started = false;
      handlers.clear();
      if (reconnectTimer !== null) {
        clearTimeoutImpl(reconnectTimer);
        reconnectTimer = null;
      }
      pollAbort?.abort();
      pollAbort = null;
      pollLoop = null;
      try {
        ws?.close?.();
      } catch {
        /* уже закрыт */
      }
      ws = null;
      wsAbort?.abort();
      wsAbort = null;
      return transport;
    },

    /**
     * Отправить вопрос. Повтор с тем же `id` идемпотентен: сервер обновляет
     * запись, а не создаёт вторую (в тестах это проверяется счётчиком).
     */
    async sendQuestion(question, sendOptions = {}) {
      if (typeof question?.shortId !== "string" || question.shortId === "") {
        throw new TypeError("relay: у вопроса нет shortId");
      }
      const payload = questionPayload(question);
      // `clientId` — id вопроса: он же id записи на сервере (повтор не дублирует).
      const saved = await call("POST", "/v1/questions", { question: payload, version: 1 }, {
        signal: sendOptions?.signal,
      });
      const questionId = saved?.id ?? payload.id;
      sent.set(questionId, { shortId: question.shortId, question });
      settled.delete(questionId);
      return { messageId: questionId };
    },

    /** Протокол v1 не умеет закрывать вопрос: снимаем локально, сервер закроет TTL/ответ. */
    async closeQuestion(question) {
      const questionId = question?.id;
      if (typeof questionId !== "string") return;
      settled.add(questionId);
      sent.delete(questionId);
      safeLog(`relay: вопрос ${questionId} снят локально (протокол закроет его ответом или TTL)`);
    },

    onAnswer(handler) {
      if (typeof handler !== "function") throw new TypeError("relay: onAnswer ждёт функцию");
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    async healthCheck() {
      try {
        const health = await call("GET", "/healthz");
        return { ok: true, detail: `relay ${health?.version ?? "?"}` };
      } catch (error) {
        return { ok: false, detail: redact(error?.message ?? error, token) };
      }
    },

    /** Для `/remote status`: сколько вопросов ждёт ответа. */
    get pending() {
      return sent.size;
    },
  };

  return transport;
}
