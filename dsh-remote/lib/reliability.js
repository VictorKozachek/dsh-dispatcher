/**
 * Устойчивость: недоставка, рестарт, TTL и секреты в теле вопроса.
 *
 * Модуль отвечает за «неудобные» случаи, в которых плагин обычно теряет вопрос
 * или сессию:
 *
 *   - **недоставка**: `deliver()` повторяет отправку с экспоненциальным backoff,
 *     уважает `retry_after` транспорта, а если за `connectTimeoutMs` (30 с) вопрос
 *     так и не ушёл — кладёт его в `pending` состояния и возвращает `'give-up'`:
 *     ответчик (002) по этому сигналу зовёт `next()`, и вопрос достаётся GUI.
 *     Решение «мессенджер или GUI» принимается до публикации — после `next()`
 *     отменить панель нельзя (`docs/research/dsh-hooks.md` §2.3);
 *   - **рестарт**: `recoverOrphans()` снимает вопросы, оставшиеся в состоянии от
 *     прошлого процесса: статус `cancelled`, сообщение правится «сессия
 *     перезапущена, вопрос снят» (best-effort: ошибка правки не валит старт);
 *   - **TTL**: `watch()` + `tick()` (и `start()` с `setInterval(...).unref()`):
 *     напоминание «⏳ осталось 5 минут» за `reminderMs` до истечения, затем
 *     `expired` и снятые кнопки. Таймаута в DSH нет, поэтому у истечения три
 *     исхода (`onExpire`, один обязателен): `abort` (`ASK_ABORTED`), `empty`
 *     (`selected: []`, `custom: "(нет ответа)"`) или `default-first` (первый
 *     вариант). Поздний ответ применяется, пока вопрос открыт, иначе уходит в
 *     сессию через `sessionController.prompt({ mode: 'steer' })` (§9.4);
 *   - **секреты**: `redact()` маскирует токены ботов, `sk-…`, приватные ключи и
 *     длинные base64/hex-строки; `redactMode: 'warn'` отправляет замаскированное
 *     тело, `'strict'` — не отправляет вовсе («вопрос скрыт»);
 *   - **журнал**: `log.jsonl` вне репозитория, без токенов и тел вопросов,
 *     с ротацией по размеру; `healthCheck()` — для `/remote doctor`.
 *
 * Всё внешнее инжектируется: транспорт, состояние, часы, `sleep`, таймер,
 * `sessionController`, файлы. Поэтому тесты быстрые и без реальных задержек.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const noop = () => {};

/** Сколько ждём доставку, прежде чем отдать вопрос в GUI. */
export const CONNECT_TIMEOUT_MS = 30_000;

/** TTL вопроса по умолчанию: 30 минут (как в домене 002). */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Напоминание за 5 минут до истечения. */
export const REMINDER_MS = 5 * 60 * 1000;

/** Повторное напоминание — не чаще раза в 30 минут. */
export const REPUSH_MS = 30 * 60 * 1000;

/** Исходы истечения TTL: один из них обязан быть выбран. */
export const ON_EXPIRE_VALUES = Object.freeze(["abort", "empty", "default-first"]);

/** Режимы обработки секретов в теле вопроса. */
export const REDACT_MODES = Object.freeze(["warn", "strict"]);

/** Куда по умолчанию пишется состояние и журнал (вне репозитория). */
export function defaultPaths({ env = process.env, home = os.homedir() } = {}) {
  const dir = typeof env?.DSH_REMOTE_STATE === "string" && env.DSH_REMOTE_STATE !== ""
    ? path.dirname(env.DSH_REMOTE_STATE)
    : path.join(home, ".dsh", "remote-control");
  return {
    dir,
    state: path.join(dir, "state.json"),
    log: path.join(dir, "log.jsonl"),
  };
}

/** Ошибка отмены: по ней ответчик понимает, что вопрос надо снять. */
export function abortError(reason = "вопрос снят") {
  const error = new Error(reason);
  error.name = "AbortError";
  return error;
}

// --- секреты ---------------------------------------------------------------

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const BOT_TOKEN = /(?<![0-9])(\d{6,}):([A-Za-z0-9_-]{30,})\b/g;
const API_KEY = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
// Слэш разрешён (в base64 он значащий), но путь в CamelCase отличается: у него
// нет '+', он не кончается на '=' и цифр в нём мало — replacer это проверяет.
const BASE64_RUN = /\b[A-Za-z0-9+/]{40,}={0,2}/g;
const HEX_RUN = /\b[0-9A-Fa-f]{32,}\b/g;

/**
 * Замаскировать секреты в тексте.
 *
 * Обычный текст не трогаем: шаблоны требуют либо формы токена (`123456:AA…`,
 * `sk-…`, PEM), либо «длинная случайная строка» — base64 с буквами обоих
 * регистров и цифрами, либо hex ≥32 символов с цифрой. Слова, пути, русский
 * текст и URL без секрета остаются как есть.
 */
export function redact(text) {
  return findSecrets(text).text;
}

/** Как {@link redact}, но ещё и говорит, было ли что маскировать. */
export function findSecrets(text) {
  let value = String(text ?? "");
  let redacted = false;

  const mask = (replacement) => {
    redacted = true;
    return replacement;
  };

  value = value.replace(PRIVATE_KEY, () => mask("<private key скрыт>"));
  value = value.replace(BOT_TOKEN, (_match, id) => mask(`${id}:<redacted>`));
  value = value.replace(API_KEY, () => mask("sk-<redacted>"));
  value = value.replace(BASE64_RUN, (candidate) => {
    const digits = (candidate.match(/\d/g) ?? []).length;
    const segments = candidate.split("/");
    // Путь узнаём по структуре сегментов: слово в CamelCase/нижнем регистре,
    // короткая аббревиатура из заглавных или число (дата). Base64 так не
    // выглядит: в его сегментах заглавные буквы стоят в середине слова, а доля
    // цифр ничего не решает — в /Projects/2026/11/03 их много.
    // Сегмент пути — слово (CamelCase с заглавной, нижний регистр, короткая
    // аббревиатура или число), но не «случайная» base64-строка: у той внутри
    // слова много переходов нижний→верхний регистр, а длина обычно ≥ 10.
    const looksRandom = (part) => part.length >= 10
      && /[a-z]/.test(part) && /[A-Z]/.test(part) && /\d/.test(part)
      && (part.match(/[a-z][A-Z]/g) ?? []).length >= 2;
    const pathSegment = (part) => part.length <= 40
      && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)
      && !looksRandom(part);
    const looksLikePath = candidate.length <= 200 && segments.every(pathSegment);
    if (!(/[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && digits > 0) || looksLikePath) return candidate;
    return mask("<redacted-base64>");
  });
  value = value.replace(HEX_RUN, (candidate) => (/\d/.test(candidate) && /^[0-9A-Fa-f]+$/.test(candidate)
    ? mask("<redacted-hex>")
    : candidate));

  return { text: value, redacted };
}

// --- состояние на диске ----------------------------------------------------

/**
 * Минимальное состояние для очереди и «осиротевших» вопросов.
 *
 * Пока задача 005 в ревью, здесь своя атомарная запись (tmp → rename, chmod 600);
 * интерфейс совпадает с `store.js` 005 (`read`/`write`/`update`), поэтому при
 * слиянии достаточно передать его сюда вместо файла.
 */
export function createJsonState({ file, now = () => Date.now(), logger = noop } = {}) {
  const empty = () => ({ version: 1, pending: [], questions: [] });

  function read() {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return empty();
    }
    try {
      const parsed = JSON.parse(text);
      return {
        ...empty(),
        ...parsed,
        pending: Array.isArray(parsed?.pending) ? parsed.pending : [],
        questions: Array.isArray(parsed?.questions) ? parsed.questions : [],
      };
    } catch (error) {
      logger(`состояние: битый JSON ${file} (${error?.message ?? error}) — работаю с пустым`);
      return empty();
    }
  }

  function write(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* уже нет */
      }
      throw error;
    }
    return state;
  }

  function update(mutator) {
    const state = read();
    const result = mutator(state);
    return write(result === undefined ? state : result);
  }

  return { file, read, write, update };
}

// --- журнал ----------------------------------------------------------------

/**
 * `log.jsonl` без секретов: записи — только служебные поля, значения проходят
 * через `redact`, тела вопросов не пишутся. Ротация по размеру (`.1`).
 */
export function createJournalLog({ file, maxBytes = 512 * 1024, now = () => Date.now(), logger = noop } = {}) {
  function append(entry) {
    const line = JSON.stringify(redactEntry({ at: now(), ...entry }));
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      rotateIfNeeded(file, maxBytes, line);
      fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        /* не критично */
      }
      return true;
    } catch (error) {
      logger(`журнал: запись не удалась (${error?.message ?? error})`);
      return false;
    }
  }

  function rotateIfNeeded(target, limit, incoming) {
    let size = 0;
    try {
      size = fs.statSync(target).size;
    } catch {
      return;
    }
    if (size + incoming.length + 1 <= limit) return;
    try {
      fs.renameSync(target, `${target}.1`);
    } catch (error) {
      logger(`журнал: ротация не удалась (${error?.message ?? error})`);
    }
  }

  return { file, append };
}

/** Все строковые значения — через redact; тела вопросов в журнал не идут. */
function redactEntry(entry) {
  const result = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === "body" || key === "question" || key === "text") continue;
    if (typeof value === "string") result[key] = redact(value);
    else if (value !== undefined) result[key] = value;
  }
  return result;
}

// --- основной модуль -------------------------------------------------------

/**
 * @param {object} options
 * @param {object} [options.transport] — транспорт (004); нужны `sendQuestion`,
 *   `closeQuestion`, по возможности `editQuestion`.
 * @param {object} [options.state] — `{read, write, update}` (005/локальный).
 * @param {string} [options.stateFile] — путь состояния, если `state` не передан.
 * @param {string} [options.logFile] — путь журнала.
 * @param {object} [options.sessionController] — для поздних ответов (`prompt`).
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {Function} [options.setInterval] — таймер (в тестах подменяется).
 * @param {"abort"|"empty"|"default-first"} [options.onExpire]
 * @param {"warn"|"strict"} [options.redactMode]
 */
export function createReliability({
  transport = null,
  state = null,
  stateFile,
  logFile,
  sessionController = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setInterval: setIntervalImpl = setInterval,
  logger = noop,
  onExpire = "abort",
  redactMode = "warn",
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  ttlMs = DEFAULT_TTL_MS,
  reminderMs = REMINDER_MS,
  repushMs = REPUSH_MS,
  backoffBaseMs = 500,
  backoffMaxMs = 30_000,
  logMaxBytes = 512 * 1024,
  tickIntervalMs = 15_000,
  notifyTimeoutMs = 2_000,
  setTimeout: setTimeoutImpl = setTimeout,
} = {}) {
  if (!ON_EXPIRE_VALUES.includes(onExpire)) {
    throw new TypeError(`reliability: onExpire должен быть одним из ${ON_EXPIRE_VALUES.join(", ")}`);
  }
  if (!REDACT_MODES.includes(redactMode)) {
    throw new TypeError(`reliability: redactMode должен быть одним из ${REDACT_MODES.join(", ")}`);
  }

  const paths = defaultPaths();
  const store = state ?? createJsonState({ file: stateFile ?? paths.state, now, logger });
  const journal = createJournalLog({ file: logFile ?? paths.log, maxBytes: logMaxBytes, now, logger });

  /** Вопросы под TTL-сторожем: shortId → запись наблюдения. */
  const watched = new Map();
  let timer = null;

  // --- доставка ------------------------------------------------------------

  /** Положить недоставленный вопрос в состояние (для повтора/отчёта). */
  /** Состояние в нашей форме: у 005 remoteStore нет ключа `questions`. */
  function normalizeState(current) {
    const state = current !== null && typeof current === "object" ? current : {};
    return {
      ...state,
      version: state.version ?? 1,
      pending: Array.isArray(state.pending) ? state.pending : [],
      questions: Array.isArray(state.questions) ? state.questions : [],
    };
  }

  function enqueuePending(question, chatId) {
    try {
      // В очередь — уже замаскированная копия: секрет не должен лежать на диске.
      const safe = prepareQuestion(question);
      store.update((raw) => {
        const current = normalizeState(raw);
        const exists = current.pending.some((item) => item.shortId === question.shortId);
        if (!exists) {
          current.pending.push({
            shortId: question.shortId,
            questionId: question.questionId ?? null,
            sessionId: question.sessionId ?? null,
            chatId: chatId ?? null,
            body: safe.body ?? "",
            title: safe.title ?? null,
            detail: safe.detail ?? null,
            options: Array.isArray(safe.options) ? safe.options : [],
            createdAt: now(),
          });
        }
        return current;
      });
    } catch (error) {
      logger(`очередь: вопрос ${question.shortId} не сохранился (${error?.message ?? error})`);
    }
  }

  /** Гонка отправки с дедлайном и сигналом: зависший send не держит handler. */
  function raceSend(question, target, { deadline, signal }) {
    return new Promise((resolve, reject) => {
      // Свой контроллер: дедлайн тоже должен отменять саму отправку, а не только
      // гонку — иначе зависший send доедет после того, как вопрос отдан в GUI.
      const controller = new AbortController();
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        fn(value);
      };
      const remaining = Math.max(0, deadline - now());
      const timer = setTimeoutImpl(() => {
        controller.abort();
        finish(reject, Object.assign(new Error("доставка не уложилась в timeout"), { name: "DeliveryTimeout" }));
      }, remaining);
      const onAbort = () => {
        controller.abort();
        finish(reject, abortError("доставка отменена"));
      };
      if (signal?.aborted === true) onAbort();
      signal?.addEventListener?.("abort", onAbort, { once: true });
      const opts = target === undefined ? { signal: controller.signal } : { ...target, signal: controller.signal };
      Promise.resolve(channel().sendQuestion(question, opts)).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  /**
   * Тело вопроса перед отправкой: `warn` — маскируем секреты и отправляем,
   * `strict` — тело не отправляем вовсе («вопрос скрыт»).
   *
   * Маскируем **все** исходящие поля: body, title, detail и метки вариантов —
   * иначе секрет в заголовке уехал бы в мессенджер при любом режиме.
   */
  function prepareQuestion(question) {
    const fields = [];
    for (const key of ["body", "title", "detail"]) {
      if (typeof question?.[key] === "string") fields.push([key, question[key]]);
    }
    const labels = (Array.isArray(question?.options) ? question.options : [])
      .map((option, index) => [index, typeof option?.label === "string" ? option.label : ""]);
    const hits = [
      ...fields.map(([key, value]) => ({ key, value, secrets: findSecrets(value) })).filter((item) => item.secrets.redacted),
      ...labels.map(([index, value]) => ({ index, value, secrets: findSecrets(value) })).filter((item) => item.secrets.redacted),
    ];
    if (hits.length === 0) return question;

    const copy = Object.assign(Object.create(Object.getPrototypeOf(question)), question);
    if (redactMode === "strict") {
      for (const [key] of fields) copy[key] = "вопрос скрыт: в тексте были секреты";
      copy.options = Array.isArray(question.options)
        ? question.options.map((option) => ({ ...option, label: "вариант скрыт" }))
        : [];
      journal.append({ event: "question-hidden", shortId: question.shortId, fields: hits.length });
    } else {
      for (const { key, secrets } of hits.filter((item) => item.key !== undefined)) copy[key] = secrets.text;
      if (hits.some((item) => item.index !== undefined)) {
        copy.options = question.options.map((option, index) => {
          const hit = hits.find((item) => item.index === index);
          return hit === undefined ? option : { ...option, label: hit.secrets.text };
        });
      }
      journal.append({ event: "question-redacted", shortId: question.shortId, fields: hits.length });
    }
    return copy;
  }

  /**
   * Доставить вопрос с повторами; по истечении `connectTimeoutMs` — `'give-up'`.
   *
   * Это та точка, где ответчик (002) решает отдать вопрос GUI: ему достаточно
   * на `'give-up'` вернуть `next()`.
   */
  /** Живой транспорт: у фасада (005) внутри, у обычного сервиса — он сам. */
  function channel() {
    if (transport === null || transport === undefined) return null;
    if (transport.__isTransportFacade === true) return transport.current ?? null;
    return transport;
  }

  async function deliver({ question, chatId, signal } = {}) {
    if (question === null || typeof question !== "object") return "give-up";
    if (typeof channel()?.sendQuestion !== "function") {
      // Отправлять некуда: не врём «delivered», сразу отдаём вопрос GUI.
      journal.append({ event: "give-up", shortId: question.shortId, reason: "no-transport" });
      return "give-up";
    }
    const deadline = now() + connectTimeoutMs;
    // Фактический чат: явный аргумент или свойство транспорта (004 его отдаёт).
    const resolvedChatId = chatId ?? channel()?.chatId ?? null;
    const target = resolvedChatId === null ? undefined : { chatId: resolvedChatId };

    const outgoing = prepareQuestion(question);

    for (let attempt = 1; ; attempt += 1) {
      if (signal?.aborted) return "aborted";
      try {
        // Отправка может зависнуть: гоним её с дедлайном и сигналом, иначе
        // handler ждал бы вечно, а вопрос после аборта всё равно уехал бы.
        const sentValue = await raceSend(outgoing, target, { deadline, signal });
        rememberOpen(question, { messageId: sentValue?.messageId, chatId: resolvedChatId });
        journal.append({ event: "delivered", shortId: question.shortId, attempt });
        return "delivered";
      } catch (error) {
        if (error?.name === "AbortError") return "aborted";
        const retryAfter = Number(error?.retryAfterMs ?? 0);
        const backoff = Math.min(backoffMaxMs, backoffBaseMs * 2 ** (attempt - 1));
        const wait = retryAfter > 0 ? retryAfter : backoff;
        const remaining = deadline - now();
        journal.append({
          event: "delivery-failed",
          shortId: question.shortId,
          attempt,
          retryInMs: wait,
          reason: error?.code ?? error?.name ?? "error",
        });
        if (remaining <= 0) {
          enqueuePending(question, chatId);
          journal.append({ event: "give-up", shortId: question.shortId, attempts: attempt });
          return "give-up";
        }
        await sleep(Math.min(wait, remaining));
        if (now() >= deadline) {
          enqueuePending(question, chatId);
          journal.append({ event: "give-up", shortId: question.shortId, attempts: attempt });
          return "give-up";
        }
      }
    }
  }

  /** Запомнить открытый вопрос в состоянии: после рестарта его надо снять. */
  function rememberOpen(question, { sessionId = null, messageId, chatId } = {}) {
    try {
      store.update((raw) => {
        const current = normalizeState(raw);
        const exists = current.questions.some((item) => item.shortId === question.shortId);
        if (!exists) {
          current.questions.push({
            shortId: question.shortId,
            questionId: question.questionId ?? null,
            sessionId: sessionId ?? question.sessionId ?? null,
            chatId: chatId ?? question.chatId ?? null,
            messageId: messageId ?? null,
            createdAt: now(),
          });
        } else {
          const entry = current.questions.find((item) => item.shortId === question.shortId);
          if (entry !== undefined) {
            if (messageId !== undefined && entry.messageId === null) entry.messageId = messageId;
            if (chatId !== undefined && chatId !== null && entry.chatId === null) entry.chatId = chatId;
          }
        }
        return current;
      });
    } catch (error) {
      logger(`состояние: открытый вопрос ${question.shortId} не сохранён (${error?.message ?? error})`);
    }
  }

  /** Убрать вопрос из открытых (ответили/сняли). */
  function forgetOpen(shortId) {
    try {
      store.update((raw) => {
        const current = normalizeState(raw);
        current.questions = current.questions.filter((item) => item.shortId !== shortId);
        return current;
      });
    } catch (error) {
      logger(`состояние: открытый вопрос ${shortId} не снят (${error?.message ?? error})`);
    }
  }

  /** Снять недоставленный вопрос из очереди (например, его забрал GUI). */
  function dropPending(shortId) {
    try {
      store.update((current) => {
        current.pending = current.pending.filter((item) => item.shortId !== shortId);
        return current;
      });
      return true;
    } catch (error) {
      logger(`очередь: ${shortId} не снят (${error?.message ?? error})`);
      return false;
    }
  }

  function pendingList() {
    try {
      return store.read().pending;
    } catch {
      return [];
    }
  }

  // --- рестарт -------------------------------------------------------------

  /**
   * Снять «осиротевшие» вопросы после перезапуска.
   *
   * Ничего не «оживляем»: вопрос живёт в памяти процесса, после рестарта
   * отвечать в него некому. Статус — `cancelled`, сообщение правится
   * «сессия перезапущена, вопрос снят» (если правка не удалась — просто лог).
   */
  async function recoverOrphans({ reason = "сессия перезапущена, вопрос снят" } = {}) {
    const current = normalizeState(store.read());
    const orphans = [...current.pending, ...current.questions];
    let cancelled = 0;
    let failed = 0;

    for (const orphan of orphans) {
      try {
        const live = channel();
        const question = { shortId: orphan.shortId, questionId: orphan.questionId ?? orphan.shortId };
        if (orphan.messageId !== null && orphan.messageId !== undefined && typeof live?.editMessage === "function") {
          // Реальное сообщение прошлого процесса: правим текст по chatId/messageId.
          await live.editMessage({ chatId: orphan.chatId, messageId: orphan.messageId }, reason);
          if (typeof live.clearButtons === "function") {
            await live.clearButtons({ chatId: orphan.chatId, messageId: orphan.messageId });
          }
        } else if (typeof live?.closeQuestion === "function") {
          await live.closeQuestion(question, "restarted");
        }
        cancelled += 1;
        journal.append({ event: "orphan-cancelled", shortId: orphan.shortId });
      } catch (error) {
        failed += 1;
        logger(`рестарт: вопрос ${orphan.shortId} не снят (${error?.message ?? error})`);
        journal.append({ event: "orphan-failed", shortId: orphan.shortId });
      }
    }

    try {
      store.update((raw) => {
        const next = normalizeState(raw);
        next.pending = [];
        next.questions = [];
        return next;
      });
    } catch (error) {
      logger(`рестарт: состояние не очищено (${error?.message ?? error})`);
    }

    return { cancelled, failed };
  }

  // --- уведомления ---------------------------------------------------------

  /**
   * Напоминание/итог: правим сообщение, если транспорт умеет, иначе — короткое
   * новое сообщение (карточка это разрешает при `caps.editAfterAnswer === false`).
   */
  async function notify(question, text) {
    // Правку проверяем по результату, а не по наличию метода: фасад 005 есть
    // всегда, но если за ним нет живого канала, правка «успешно» ничего не делает.
    if (typeof transport?.editQuestion === "function") {
      try {
        const edited = await transport.editQuestion(question, text);
        // Только явный `true`: фасад без живого канала возвращает undefined,
        // и это не повод считать напоминание доставленным.
        if (edited === true) return "edited";
        logger(`уведомление ${question.shortId}: транспорт не смог править сообщение`);
      } catch (error) {
        logger(`уведомление ${question.shortId}: правка не удалась (${error?.message ?? error})`);
      }
    }
    // Новое сообщение вместо правки разрешено только там, где правка невозможна
    // по возможностям транспорта (caps.editAfterAnswer === false).
    const caps = transport?.caps ?? {};
    if (caps.editAfterAnswer === false && typeof transport?.sendQuestion === "function") {
      try {
        await transport.sendQuestion({
          shortId: randomUUID().slice(0, 8),
          questionId: question.questionId ?? question.shortId,
          body: text,
          options: [],
          multiSelect: false,
          allowFreeText: false,
        });
        return "sent";
      } catch (error) {
        logger(`уведомление ${question.shortId}: не отправлено (${error?.message ?? error})`);
      }
    }
    return "dropped";
  }

  // --- TTL -----------------------------------------------------------------

  /** Поставить вопрос под TTL-сторож. `onExpire(info)` — как разблокировать ожидание. */
  function watch(question, { sessionId = null, onExpire: onExpireHook = null, ttlMs: questionTtlMs = ttlMs } = {}) {
    if (question?.shortId === undefined) return false;
    rememberOpen(question, { sessionId: sessionId ?? question.sessionId ?? null });
    watched.set(question.shortId, {
      question,
      sessionId: sessionId ?? question.sessionId ?? null,
      expiresAt: Number.isFinite(question.expiresAt) ? question.expiresAt : now() + questionTtlMs,
      onExpire: typeof onExpireHook === "function" ? onExpireHook : null,
      remindedAt: null,
      lastPushAt: null,
    });
    return true;
  }

  /** Убрать вопрос из-под сторожа (ответили, сняли вручную). */
  function unwatch(shortIdOrList) {
    const ids = Array.isArray(shortIdOrList)
      ? shortIdOrList.map((item) => (typeof item === "string" ? item : item?.shortId)).filter((id) => typeof id === "string")
      : [shortIdOrList];
    let removed = false;
    for (const id of ids) {
      forgetOpen(id);
      removed = watched.delete(id) || removed;
    }
    return removed;
  }

  /** Один проход сторожа: напоминания и истечения. Возвращает счётчики. */
  async function tick() {
    const result = { reminded: 0, expired: 0 };
    for (const [shortId, item] of [...watched.entries()]) {
      const question = item.question;
      if (question?.isOpen !== true) {
        watched.delete(shortId);
        forgetOpen(shortId);
        continue;
      }

      if (now() >= item.expiresAt) {
        watched.delete(shortId);
        forgetOpen(shortId);
        question.expire?.(now());
        // §7.3: по TTL сообщение помечается «⌛ ждёт ответа», и только потом
        // снимаются кнопки. Silent-close сам текст не меняет.
        try {
          await withTimeout(Promise.resolve(transport?.editQuestion?.(question, "⌛ ждёт ответа")), notifyTimeoutMs);
        } catch (error) {
          logger(`TTL: пометка вопроса ${shortId} не удалась (${error?.message ?? error})`);
        }
        try {
          // Зависшая правка не должна блокировать сторож: ограничиваем время.
          await withTimeout(Promise.resolve(transport?.closeQuestion?.(question, "expired")), notifyTimeoutMs);
        } catch (error) {
          logger(`TTL: кнопки вопроса ${shortId} не снялись (${error?.message ?? error})`);
        }
        const resolved = resolveExpiry(question);
        journal.append({ event: "expired", shortId, outcome: onExpire });
        result.expired += 1;
        if (item.onExpire !== null) {
          try {
            item.onExpire(resolved);
          } catch (error) {
            logger(`TTL: исход истечения ${shortId} не применён (${error?.message ?? error})`);
          }
        }
        continue;
      }

      const reminderAt = item.expiresAt - reminderMs;
      if (now() >= reminderAt) {
        const due = item.lastPushAt === null || now() - item.lastPushAt >= repushMs;
        if (due) {
          const pushed = await withTimeout(notify(question, "⏳ осталось 5 минут"), notifyTimeoutMs)
            .catch(() => "dropped");
          item.lastPushAt = now();
          if (pushed !== "dropped") result.reminded += 1;
          journal.append({ event: "reminder", shortId, transport: pushed });
        }
      }
    }
    return result;
  }

  /** Ограничить ожидание: сторож не должен висеть на чужой правке. */
  function withTimeout(promise, ms) {
    return new Promise((resolve) => {
      const timer = setTimeoutImpl(() => resolve("timeout"), ms);
      timer?.unref?.();
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          logger(`TTL: операция не удалась (${error?.message ?? error})`);
          resolve("failed");
        },
      );
    });
  }

  /** Как разблокировать сессию при истечении — по конфигу. */
  function resolveExpiry(question) {
    const answerId = question.questionId ?? question.shortId;
    if (onExpire === "empty") {
      return { kind: "answer", answer: { id: answerId, selected: [], custom: "(нет ответа)" } };
    }
    if (onExpire === "default-first") {
      const label = Array.isArray(question.options) && question.options.length > 0
        ? question.options[0].label
        : null;
      return {
        kind: "answer",
        answer: label === null
          ? { id: answerId, selected: [], custom: "(нет ответа)" }
          : { id: answerId, selected: [label] },
      };
    }
    return { kind: "abort", error: abortError("вопрос истёк по TTL") };
  }

  /** Поднять сторож (`setInterval(...).unref()`); повторный вызов безопасен. */
  function start() {
    if (timer !== null) return;
    timer = setIntervalImpl(() => {
      void tick().catch((error) => logger(`TTL: тик упал (${error?.message ?? error})`));
    }, tickIntervalMs);
    timer?.unref?.();
  }

  /** Остановить сторож. */
  function stop() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  // --- поздний ответ -------------------------------------------------------

  /**
   * Ответ, пришедший после публикации/снятия вопроса.
   *
   * Открытый вопрос принимает ответ как обычно. Снятый — уходит в сессию
   * сообщением `steer` (`sessionController.prompt`): вернуть tool-result уже
   * нельзя, а модель должна увидеть ответ человека. Нет сессии/сервиса — ответ
   * отбрасывается с записью в журнал.
   *
   * @returns {"accepted"|"steered"|"dropped"}
   */
  async function applyLateAnswer({ question, answer, sessionId, text } = {}) {
    if (question?.isOpen === true) {
      if (typeof question.accept === "function" && question.accept(
        { selected: Array.isArray(answer?.selected) ? answer.selected : [], ...(answer?.custom === undefined ? {} : { custom: answer.custom }) },
        { answeredBy: answer?.answeredBy, now: now() },
      )) {
        journal.append({ event: "late-answer", shortId: question.shortId, outcome: "accepted" });
        return "accepted";
      }
      return "dropped";
    }

    const id = sessionId ?? question?.sessionId ?? null;
    const prompt = sessionController?.prompt;
    if (typeof prompt !== "function" || id === null || id === undefined) {
      journal.append({ event: "late-answer", shortId: question?.shortId, outcome: "dropped" });
      return "dropped";
    }
    const rawBody = (typeof text === "string" && text !== "" ? text : null) ?? [
      `Ответ человека на вопрос ${question?.shortId ?? "?"}`,
      ...(Array.isArray(answer?.selected) ? answer.selected : []),
      ...(answer?.custom === undefined ? [] : [answer.custom]),
    ].join(": ");
    const body = redact(rawBody);
    try {
      await prompt.call(sessionController, {
        requestId: randomUUID(),
        sessionId: id,
        mode: "steer",
        content: [{ type: "text", text: `Ответ человека: ${body}` }],
      }, new AbortController().signal);
      journal.append({ event: "late-answer", shortId: question?.shortId, outcome: "steered" });
      return "steered";
    } catch (error) {
      logger(`поздний ответ: steer не удался (${error?.message ?? error})`);
      journal.append({ event: "late-answer", shortId: question?.shortId, outcome: "dropped" });
      return "dropped";
    }
  }

  // --- doctor --------------------------------------------------------------

  /** Состояние для `/remote doctor`: очередь, сторож, журнал, секреты. */
  async function healthCheck() {
    const transportHealth = typeof transport?.healthCheck === "function"
      ? await Promise.resolve(transport.healthCheck()).catch((error) => ({ ok: false, detail: String(error?.message ?? error) }))
      : { ok: false, detail: "транспорт не подключён" };
    return {
      ok: transportHealth?.ok === true,
      transport: transportHealth,
      pending: pendingList().length,
      watching: watched.size,
      ttl: { onExpire, reminderMs, ttlMs, repushMs },
      redactMode,
      log: journal.file,
      state: store.file ?? stateFile ?? null,
    };
  }

  return {
    deliver,
    dropPending,
    pendingList,
    recoverOrphans,
    notify,
    watch,
    unwatch,
    tick,
    start,
    stop,
    applyLateAnswer,
    healthCheck,
    journal,
    store,
    redact,
  };
}
