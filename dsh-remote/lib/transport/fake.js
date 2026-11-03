/**
 * `fake`-транспорт: мессенджер для тестов.
 *
 * На нём проверяется всё, что выше транспорта (ответчик, домен, очередь), и
 * именно им задачи 004/007/008 доказывают поведение без сети. Поэтому `fake`
 * реализует **тот же контракт**, что Telegram (см. `./base.js`), и проходит
 * `checkTransport` — иначе он перестал бы быть доказательством.
 *
 * Что он умеет сверх контракта:
 *   - `answer(shortId, optionId)` / `answerText(shortId, text)` — «человек нажал
 *     кнопку»: событие уходит подписчикам `onAnswer` в форме `TransportAnswer`;
 *   - `closeAll(summary)` — закрыть все незакрытые сообщения;
 *   - `failNext(times)` — следующие `times` отправок падают (недоступный
 *     мессенджер, 429, обрыв);
 *   - `messages` / `closed` / `answers` / `calls` — что отправлено, что закрыто,
 *     что «ответил человек» и сколько раз что вызвали;
 *   - `caps` перекрываются при создании: тесты проверяют поведение на узком
 *     лимите (`maxText`, `maxOptions`) без настоящего мессенджера.
 */

import {
  DEFAULT_CAPS,
  callbackData,
  checkTransport,
  chrome,
} from "./base.js";

/**
 * @param {object} [options]
 * @param {Partial<typeof DEFAULT_CAPS>} [options.caps] — возможности мессенджера.
 * @param {number} [options.buttonsPerRow] — раскладка кнопок (по умолчанию 2).
 * @param {() => number} [options.now] — часы, в тестах подменяются.
 */
export function createFakeTransport(options = {}) {
  const caps = { ...DEFAULT_CAPS, ...(options.caps ?? {}) };
  const perRow = Number.isFinite(options.buttonsPerRow) ? options.buttonsPerRow : 2;
  const now = typeof options.now === "function" ? options.now : Date.now;

  const messages = [];
  const closed = [];
  const answers = [];
  const subscribers = new Set();
  const calls = { start: 0, stop: 0, send: 0, close: 0, health: 0, answer: 0 };
  let failures = 0;
  let started = false;
  let messageSeq = 0;

  /** Событие «человек ответил»: всем подписчикам, в форме TransportAnswer. */
  function emit(event) {
    calls.answer += 1;
    const delivered = { ...event, answeredBy: event.answeredBy ?? "fake-user", at: now() };
    answers.push(delivered);
    for (const handler of [...subscribers]) {
      try {
        handler(delivered);
      } catch {
        /* подписчик отвечает за свои ошибки: транспорт их не глотает и не роняет */
      }
    }
    return delivered;
  }

  const transport = {
    id: "fake",
    caps,

    async start() {
      calls.start += 1;
      started = true;
    },

    async stop() {
      calls.stop += 1;
      started = false;
    },

    /**
     * Отправка вопроса: запоминает сообщение и рисует кнопки так, как это сделал
     * бы мессенджер, — вариантами из `question.options` и `callback_data`
     * `q:<shortId>:<optionId>`.
     */
    async sendQuestion(question, sendOptions = {}) {
      calls.send += 1;
      if (failures > 0) {
        failures -= 1;
        throw new Error("fake: транспорт недоступен");
      }
      const available = Array.isArray(question?.options) ? question.options : [];
      const shown = available.slice(0, Math.max(0, caps.maxOptions));
      const rows = caps.inlineButtons
        ? chrome(shown, perRow).map((row) => row.map((option) => ({
          text: option.label,
          callback_data: callbackData(question.shortId, option.id),
        })))
        : [];

      const message = {
        id: `m${++messageSeq}`,
        shortId: question?.shortId ?? null,
        chatId: sendOptions?.chatId ?? null,
        text: question?.body ?? "",
        title: question?.title ?? null,
        rows,
        closed: false,
        question,
        sentAt: now(),
      };
      messages.push(message);
      return { messageId: message.id };
    },

    /** Закрытие: кнопки снимаются, при `caps.editAfterAnswer` сообщение правится. */
    async closeQuestion(question, summary = "") {
      calls.close += 1;
      const message = messages.find(
        (item) => item.shortId === question?.shortId && item.closed === false,
      );
      if (message === undefined) return;
      message.closed = true;
      message.rows = [];
      message.summary = String(summary ?? "");
      message.closedAt = now();
      if (caps.editAfterAnswer && message.summary !== "") {
        message.text = `${message.text}\n\n${message.summary}`;
        message.edited = true;
      }
      closed.push(message);
    },

    /** Подписка на ответы. Возвращает отписку, как настоящий транспорт. */
    onAnswer(handler) {
      if (typeof handler !== "function") throw new TypeError("fake: onAnswer ждёт функцию");
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },

    healthCheck() {
      calls.health += 1;
      return {
        ok: failures === 0,
        detail: failures === 0 ? "fake готов" : `fake: запланировано падений ${failures}`,
      };
    },

    // --- только для тестов -------------------------------------------------

    /** «Человек нажал кнопку варианта». */
    answer(shortId, optionId) {
      return emit({ shortId, optionIds: [optionId] });
    },

    /** «Человек написал свободный ответ». */
    answerText(shortId, text) {
      return emit({ shortId, text });
    },

    /** Закрыть все незакрытые сообщения. */
    async closeAll(summary = "закрыто") {
      for (const message of [...messages]) {
        if (message.closed) continue;
        await transport.closeQuestion(message.question, summary);
      }
    },

    /** Следующие `times` отправок упадут — проверка деградации ответчика. */
    failNext(times = 1) {
      failures = Math.max(0, Math.floor(Number(times) || 0));
      return transport;
    },

    get messages() {
      return messages;
    },
    get closed() {
      return closed;
    },
    get answers() {
      return answers;
    },
    get calls() {
      return calls;
    },
    get started() {
      return started;
    },
    get subscribers() {
      return subscribers.size;
    },
  };

  return transport;
}

export { checkTransport };
