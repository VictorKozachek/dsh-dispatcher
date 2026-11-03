/**
 * Ответчик waterfall'а `user-questions/request`: вопрос человека уходит в
 * транспорт (мессенджер), ответ возвращается в ту же сессию результатом
 * инструмента `ask_user_question`.
 *
 * Как это работает по шагам:
 *   1. `attach(ctx)` вешает слушатель с `{ prepend: true }`. Мост `api-remotes`,
 *      который отдаёт вопрос браузеру, регистрируется раньше любого плагина
 *      профиля; без `prepend` наш слушатель оказался бы «внутри» цепочки и
 *      вызывался бы только после `next()` из GUI, то есть никогда
 *      (см. `docs/research/waterfall-order.md`).
 *   2. Слушатель спрашивает реестр режима. Выключен — `return next()`: вопрос
 *      рисует GUI, поведение DSH не меняется.
 *   3. Включён — создаются `RemoteQuestion`, уходят в `transport.sendQuestion`,
 *      а слушатель ждёт ответ **без таймаута** (TTL, напоминания и протухание —
 *      задача 008). Ответы приходят событием `transport.onAnswer` и разносятся по
 *      вопросам коротким `shortId`; забрали вопрос — `next()` не зовём.
 *   4. `request.signal` абортнут — сообщения закрываются (`closeQuestion`),
 *      вопросы получают статус `cancelled`, а промис **отклоняется**: DSH
 *      превратит это в `ASK_ABORTED` (`UserQuestionService.ask`). Глотать ошибку
 *      нельзя — иначе инструмент «ответится» отменой молча.
 *
 * Ответ на один вопрос принимается ровно один раз: второе нажатие кнопки
 * находит вопрос уже закрытым и просто пишет строку в лог.
 *
 * Контракт транспорта, который использует ответчик (реализация — задача 003):
 *   - `sendQuestion(question)` → Promise<void> | void — доставить сообщение;
 *   - `closeQuestion(question, reason)` → снять кнопки/пометить сообщение;
 *   - `onAnswer(handler)` → функция отписки; `handler({ shortId, optionIds, text, answeredBy })`.
 * Терпимость к форме события (см. `normalizeAnswerEvent`) — чтобы транспорт мог
 * прислать один `optionId` или `custom` вместо `text`, не ломая ответчик.
 */

import { randomUUID } from "node:crypto";

import { ANSWERED_ELSEWHERE, createBroker } from "./broker.js";
import { createQuestion } from "./domain/question.js";
import { FREE_TEXT_OPTION, MORE_OPTION, resolveContext } from "./present.js";

const noopLog = () => {};

/** Ошибка «вопрос снят»: DSH по аборту `signal` превращает её в `ASK_ABORTED`. */
function abortError(cause) {
  const error = new Error("удалённый вопрос снят: запрос абортнут");
  error.name = "AbortError";
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * Событие ответа транспорта → один вид.
 *
 * Основная форма: `{ shortId, optionIds: string[], text?, answeredBy? }`.
 * Принимаем и `optionId` (одна кнопка), и `custom` вместо `text`: транспорт
 * пишется отдельной задачей, и разъезжаться на синонимах ему незачем.
 */
function normalizeAnswerEvent(event) {
  if (event === null || typeof event !== "object") return null;
  if (typeof event.shortId !== "string" || event.shortId === "") return null;

  const raw = Array.isArray(event.optionIds)
    ? event.optionIds
    : Array.isArray(event.optionId)
      ? event.optionId
      : typeof event.optionId === "string"
        ? [event.optionId]
        : [];
  const optionIds = raw.filter((id) => typeof id === "string" && id !== "");
  const text = typeof event.text === "string"
    ? event.text
    : typeof event.custom === "string"
      ? event.custom
      : "";

  return {
    shortId: event.shortId,
    optionIds,
    text,
    answeredBy: typeof event.answeredBy === "string" ? event.answeredBy : undefined,
  };
}

/**
 * Ответ транспорта в терминах домена: `optionIds` → метки вариантов.
 *
 * Одиночный вопрос + свободный текст: текст заменяет выбор — так же поступает
 * GUI DSH (`packages/client/ui-user-questions/src/client/QuestionComposer.tsx:219`),
 * иначе в ответ уехало бы два взаимоисключающих значения.
 */
function choiceFor(question, event) {
  // Служебные кнопки представления (006): «Другой ответ…» ждёт свободный текст
  // (его принесёт следующее сообщение), «Показать ещё» — раскрытие вариантов.
  // Это не ответ, поэтому вопрос остаётся открытым и не получает ошибку.
  if (event.optionIds.length === 1 && event.optionIds[0] === FREE_TEXT_OPTION) return { awaitingText: true };
  if (event.optionIds.length === 1 && event.optionIds[0] === MORE_OPTION) return { showMore: true };

  const labels = new Map(question.options.map((option) => [option.id, option.label]));
  const selected = [];
  for (const id of event.optionIds) {
    const label = labels.get(id);
    if (label === undefined) return { error: `неизвестный вариант ${id}` };
    if (!selected.includes(label)) selected.push(label);
  }

  const custom = event.text.trim();
  if (selected.length === 0 && custom === "") return { error: "пустой ответ" };

  return {
    choice: {
      selected: question.multiSelect || custom === "" ? selected : [],
      ...(custom === "" ? {} : { custom }),
    },
  };
}

/** Сводка ответа для правки сообщения: выбранные варианты и/или текст. */
function answerSummary(question) {
  const selected = Array.isArray(question?.answer?.selected) ? question.answer.selected : [];
  const custom = typeof question?.answer?.custom === "string" ? question.answer.custom : "";
  const parts = [...selected, ...(custom === "" ? [] : [custom])];
  return parts.join(", ");
}

/**
 * Ответчик.
 *
 * @param {object} options
 * @param {object} options.transport — транспорт мессенджера (контракт в шапке файла).
 * @param {object} options.registry — реестр режима (`domain/registry.js`).
 * @param {(message: string) => void} [options.log] — лог плагина.
 * @param {() => number} [options.now] — часы (мс epoch), в тестах подменяются.
 * @returns {{attach: (ctx: object) => () => void, handler: Function, dispose: (reason?: string) => void}}
 */
export function createAnswerer({
  transport = null,
  transports = null,
  registry,
  log = noopLog,
  now = Date.now,
  deliver = null,
  deliverFor = null,
  reliability = null,
  /** 015: канал проекта по воркспейсу: `(workspace) => {chatId, threadId, source}`. */
  channelOf = null,
  /** Гибридный режим (013): `{enabled, waitMs}` или функция, отдающая его. */
  hybrid = null,
  /** 013: доставка позднего ответа; по умолчанию `sessionController.prompt`. */
  steer = null,
  /** 013: таймеры инжектируются, тесты не ждут реальные 20 секунд. */
  setTimeout: setTimeoutImpl = setTimeout,
  clearTimeout: clearTimeoutImpl = clearTimeout,
} = {}) {
  /** Счётчики гибрида для журнала и `/remote status`. */
  const stats = { hybridHanded: 0, hybridPhoneAnswers: 0 };

  /** Текущая конфигурация гибрида: функция вызывается на каждый вопрос. */
  function hybridConfig() {
    let value = hybrid;
    if (typeof value === "function") {
      try {
        value = value();
      } catch (error) {
        log(`гибрид: конфиг не прочитан (${error?.message ?? error})`);
        value = null;
      }
    }
    if (value === null || typeof value !== "object") return { enabled: false, waitMs: 20_000 };
    return {
      enabled: value.enabled === true,
      waitMs: Number.isFinite(value.waitMs) && value.waitMs > 0 ? Math.floor(value.waitMs) : 20_000,
    };
  }

  /** Отправить поздний ответ в сессию как уточнение (`steer`). */
  async function steerLateAnswer(question, normalized, signal) {
    const text = normalized.text !== undefined && normalized.text !== ""
      ? normalized.text
      : (question.answer?.selected ?? []).join(", ");
    const body = `ответ человека на вопрос ${question.questionId ?? question.shortId} из мессенджера: ${text}`;
    if (typeof steer === "function") {
      await steer({ question, text: body, sessionId: question.sessionId, signal });
      return;
    }
    const controller = context?.get?.("sessionController");
    if (controller === null || controller === undefined || typeof controller.prompt !== "function") {
      throw new Error("sessionController недоступен");
    }
    // Контракт DSH: prompt(request, signal); requestId — новый uuid, signal —
    // свежий контроллер (сигнал исходного запроса после next() уже может быть
    // aborted, как в 008 applyLateAnswer).
    await controller.prompt({
      requestId: randomUUID(),
      sessionId: question.sessionId,
      mode: "steer",
      content: [{ type: "text", text: body }],
    }, new AbortController().signal);
  }
  /**
   * Каналы (012): один транспорт — прежний путь, несколько — брокер с гонкой.
   * Ответчик не знает платформ: только список реализаций контракта.
   */
  const channels = (Array.isArray(transports) && transports.length > 0 ? transports : (transport === null ? [] : [transport]))
    .filter((item) => item !== null && typeof item === "object");
  const useBroker = channels.length > 1;
  const broker = useBroker ? createBroker({ transports: channels, deliverFor, log }) : null;
  const primary = channels[0] ?? null;
  /**
   * Доставка вопроса: по умолчанию — транспорт, но 008 подставляет сюда
   * `reliability.deliver` с повторами. Сигнал `'give-up'` означает «за
   * `connectTimeoutMs` не доставили» — тогда вопрос достаётся GUI через `next()`.
   */
  /** Параметры отправки с учётом канала проекта (015). */
  const sendOptionsFor = (question) => ({
    ...(question.chatId === null || question.chatId === undefined ? {} : { chatId: question.chatId }),
    ...(question.threadId === null || question.threadId === undefined ? {} : { threadId: question.threadId }),
  });

  const sendOne = typeof deliver === "function"
    // У доставки через reliability сигнал есть (она умеет отменять отправку).
    ? async (question, signal) => deliver({ question, signal, ...sendOptionsFor(question) })
    // Прямой транспорт исторически сигнал не отменяет: аборт ждёт завершения
    // sendMessage и закрывает сообщение по факту (тест 004).
    : async (question) => primary.sendQuestion(question, sendOptionsFor(question));

  /**
   * Доставить вопрос во все каналы (012). Возвращает `true`, если доставили
   * хотя бы в один: ошибка одного канала не должна блокировать второй.
   */
  async function publishAll(question, signal) {
    const publication = await broker.publish(question, {
      signal,
      chatId: question.chatId ?? undefined,
      threadId: question.threadId ?? undefined,
    });
    return publication;
  }
  /** Открытые вопросы по короткому id: ждём ответа транспорта. */
  const pending = new Map();
  /** Метка «вопрос ушёл в GUI»: гонка ожиданий завершается этим значением. */
  const HYBRID_GUI = Symbol("hybrid-gui");
  /** Таймеры гибрида по shortId: ответ на один вопрос не снимает чужие. */
  const hybridTimers = new Map();
  /** Все вопросы этой пачки: поздний ответ проигравшего канала ищем здесь. */
  const known = new Map();
  /** Контекст плагина: из него берём cwd сессии для scope воркспейса. */
  let context = null;
  let disposed = false;

  /**
   * cwd сессии — для выбора scope «воркспейс». Маркировка шапки — задача 006.
   *
   * `ctx.sessions.get(id)` отдаёт `Session`, и рабочий каталог лежит в
   * `session.header.cwd` (так же его читает agent-instructions): поля `cwd` или
   * `workspace` сверху нет, поэтому читать их — молча получить null.
   */
  function workspaceOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return null;
    try {
      const sessions = context?.get?.("sessions");
      const session = sessions?.get?.(sessionId);
      const cwd = session?.header?.cwd;
      return typeof cwd === "string" && cwd !== "" ? cwd : null;
    } catch {
      return null;
    }
  }

  /**
   * Снять вопросы: статус `cancelled` и закрытие сообщений (best effort).
   *
   * `attempted` — для каких вопросов отправка уже началась: у неотправленных
   * закрывать нечего, им достаточно статуса (аборт во время отправки, ошибка
   * доставки). Начатая отправка могла дойти до сервера, поэтому её закрываем.
   */
  /** Вопросы, снятые недавно: их поздние ответы уходят в сессию как `steer`. */
  const recentlyClosed = new Map();
  const rememberClosed = (question) => {
    recentlyClosed.set(question.shortId, question);
    if (recentlyClosed.size > 50) {
      const oldest = recentlyClosed.keys().next().value;
      recentlyClosed.delete(oldest);
    }
  };

  async function closeQuestions(questions, reason, attempted = null) {
    for (const question of questions) {
      pending.delete(question.shortId);
      rememberClosed(question);
      reliability?.unwatch?.(question.shortId);
      // Уже отвеченный или закрытый вопрос второй раз не закрываем: сообщение в
      // мессенджере и так снято, а лишний closeQuestion — ложный сигнал транспорту.
      if (!question.cancel(reason, now())) continue;
      if (attempted !== null && !attempted.has(question)) continue;
      try {
        if (useBroker && (question.deliveries?.length ?? 0) > 0) {
          // 012: в мультиканале одиночный `transport` — пустой фасад, поэтому
          // закрываем через брокер, иначе сообщения остаются с кнопками.
          await broker.closeAll(question, { winner: null, summary: reason });
        } else {
          await primary?.closeQuestion?.(question, reason);
        }
      } catch (error) {
        log(`вопрос ${question.shortId}: закрыть сообщение не удалось (${error?.message ?? error})`);
      }
    }
  }

  /** Правка сообщения после ответа: в фоне, ошибка не мешает ответу. */
  async function closeMessage(question) {
    try {
      if (useBroker && (question.deliveries?.length ?? 0) > 0) {
        const winner = broker.transportOf(question.answeredVia ?? "");
        await broker.closeAll(question, { winner, summary: answerSummary(question) });
        return;
      }
      await primary?.closeQuestion?.(question, answerSummary(question));
    } catch (error) {
      log(`вопрос ${question.shortId}: закрыть сообщение не удалось (${error?.message ?? error})`);
    }
  }

  /**
   * Ответ транспорта: разнести по ожидающим вопросам, разбудить слушатель и
   * поправить сообщение в мессенджере.
   *
   * Слушатель будим **до** правки: медленный (или зависший) editMessageText не
   * должен задерживать ответ сессии. Правка — украшение, ответ — смысл.
   */
  /** Доставить поздний (гибридный) ответ; при сбое — пометить и не закрывать. */
  async function settleLate(entry, normalized) {
    try {
      await steerLateAnswer(entry.question, normalized, entry.signal);
    } catch (error) {
      entry.steerFailed = true;
      log(`гибрид: поздний ответ ${entry.question.shortId} не доставлен в сессию (${error?.message ?? error}) — сообщение не закрываю`);
      return;
    }
    pending.delete(entry.question.shortId);
    reliability?.unwatch?.(entry.question.shortId);
    stats.hybridPhoneAnswers += 1;
    log(`гибрид: ответ на ${entry.question.shortId} из мессенджера доставлен steer-ом`);
    void closeMessage(entry.question);
  }

  function onTransportAnswer(event, sourceTransport = null) {
    const normalized = normalizeAnswerEvent(event);
    if (normalized === null) {
      log("ответ транспорта: событие без shortId — игнор");
      return;
    }
    const entry = pending.get(normalized.shortId);
    if (entry !== undefined && entry.hybridGui === true) {
      // Вопрос уже показан в GUI: ответ из мессенджера — не результат
      // инструмента, а уточнение к сессии. Принимаем один раз и шлём steer.
      if (entry.steerFailed === true && entry.lateAnswer !== undefined) {
        void settleLate(entry, entry.lateAnswer);
        return;
      }
      const lateParsed = choiceFor(entry.question, normalized);
      if (lateParsed.error !== undefined || lateParsed.awaitingText === true || lateParsed.showMore === true) return;
      if (!entry.question.accept(lateParsed.choice, { answeredBy: normalized.answeredBy, now: now() })) return;
      // Гибридный поздний ответ тоже знает свой канал: по нему closeAll
      // определяет победителя и закрывает остальные пометкой.
      entry.question.answeredVia = sourceTransport?.id ?? entry.question.answeredVia ?? null;
      entry.lateAnswer = normalized;
      log(`гибрид: ответ на ${normalized.shortId} пришёл из мессенджера после ухода в GUI — отправляю steer`);
      // Сначала доставляем steer, и только потом закрываем сообщение: если
      // доставка упала, вопрос не должен выглядеть отвеченным/потерянным.
      void settleLate(entry, normalized);
      return;
    }
    if (entry === undefined) {
      const knownQuestion = known.get(normalized.shortId);
      if (knownQuestion !== undefined && knownQuestion.status === "answered") {
        // Ответ из канала, который проиграл гонку: решение уже принято.
        log(`ответ на ${normalized.shortId} из канала ${sourceTransport?.id ?? "?"} проигнорирован:`
          + ` вопрос уже отвечен в ${knownQuestion.answeredVia ?? "другом канале"}`);
        return;
      }
      // Поздний ответ: вопрос уже снят (TTL/аборт/перезапуск). Это не игнор —
      // карточка требует, чтобы ответ дошёл до сессии через `steer`.
      const closedQuestion = recentlyClosed.get(normalized.shortId);
      if (closedQuestion === undefined || typeof reliability?.applyLateAnswer !== "function") {
        log(`ответ на ${normalized.shortId}: вопроса нет (уже отвечен или закрыт) — игнор`);
        return;
      }
      const labels = new Map((closedQuestion.options ?? []).map((option) => [option.id, option.label]));
      const selected = normalized.optionIds.map((id) => labels.get(id)).filter((label) => label !== undefined);
      const answer = { selected, ...(normalized.text === "" ? {} : { custom: normalized.text }) };
      void Promise.resolve(reliability.applyLateAnswer({ question: closedQuestion, answer, text: normalized.text }))
        .then((outcome) => log(`поздний ответ ${normalized.shortId}: ${outcome}`))
        .catch((error) => log(`поздний ответ ${normalized.shortId}: не доставлен (${error?.message ?? error})`));
      return;
    }
    const parsed = choiceFor(entry.question, normalized);
    if (parsed.awaitingText === true) {
      log(`вопрос ${normalized.shortId}: «Другой ответ…» — ждём свободный текст`);
      return;
    }
    if (parsed.showMore === true) {
      log(`вопрос ${normalized.shortId}: «Показать ещё» — раскрытие вариантов пока не поддержано транспортом`);
      return;
    }
    if (parsed.error !== undefined) {
      log(`ответ на ${normalized.shortId} отклонён: ${parsed.error}`);
      return;
    }
    if (!entry.question.accept(parsed.choice, { answeredBy: normalized.answeredBy, now: now() })) return;
    entry.question.answeredVia = sourceTransport?.id ?? entry.question.answeredVia ?? null;
    pending.delete(normalized.shortId);
    reliability?.unwatch?.(normalized.shortId);
    if (entry.hybridTimer !== null && entry.hybridTimer !== undefined) {
      try {
        clearTimeoutImpl(entry.hybridTimer);
      } catch {
        /* таймер уже сработал */
      }
      hybridTimers.delete(normalized.shortId);
      entry.hybridTimer = null;
    }
    entry.resolve(entry.question);
    void closeMessage(entry.question);
  }

  /**
   * Слушатель waterfall'а.
   *
   * `next()` зовём только в двух случаях: режим выключен (поведение DSH не
   * меняется) и транспорт не смог доставить вопрос. После доставки в мессенджер
   * `next()` не зовём никогда: кадр, ушедший в GUI, из плагина не снять.
   */
  async function handler(request, next) {
    const items = Array.isArray(request?.questions) ? request.questions : [];
    if (items.length === 0) return next(); // пустой запрос — ошибка ядра, не наша
    if (request?.signal?.aborted) throw abortError();

    if (useBroker && channels.some((item) => typeof item.sendQuestion !== "function" && typeof deliverFor !== "function")) {
      log("ответчик: не все каналы умеют sendQuestion — отдаю GUI");
      return next();
    }
    const sessionId = typeof request?.agent?.id === "string" ? request.agent.id : null;
    const workspace = workspaceOf(sessionId);
    // Маркировка (006): роль и задача, которую ведёт эта сессия. Ошибки чтения
    // контекста не должны мешать вопросу — тогда просто без задачи.
    let questionContext = { role: null, taskId: null };
    try {
      const resolved = resolveContext({ sessionId, ctx: context, log });
      questionContext = { role: resolved.role ?? null, taskId: resolved.taskId ?? null };
    } catch (error) {
      log(`вопрос: контекст сессии не прочитан (${error?.message ?? error})`);
    }
    let decision = { enabled: false, scope: null };
    try {
      decision = registry?.resolve?.({ sessionId, workspace }) ?? decision;
    } catch (error) {
      log(`реестр режима: ${error?.message ?? error} — считаю режим выключенным`);
    }
    if (!decision.enabled) {
      log(`вопрос ${sessionId ?? "(без агента)"}: режим выключен — отдаю GUI (next)`);
      return next();
    }
    if (typeof deliver !== "function" && !useBroker && typeof primary?.sendQuestion !== "function") {
      log("вопрос: транспорт не умеет sendQuestion — отдаю GUI (next)");
      return next();
    }

    const questions = [];
    try {
      for (const item of items) {
        // 015: канал проекта — свой чат/топик; нет канала — общий чат привязки.
        let questionChannel = { chatId: null, threadId: null };
        if (typeof channelOf === "function") {
          try {
            const resolved = channelOf(workspace) ?? {};
            questionChannel = {
              chatId: resolved.chatId ?? null,
              threadId: resolved.threadId ?? null,
            };
            if (resolved.source === "default" && workspace !== null) {
              log(`вопрос: у проекта ${workspace} нет своего канала — иду в общий чат`);
            }
          } catch (error) {
            log(`вопрос: канал проекта не определён (${error?.message ?? error})`);
          }
        }
        const created = createQuestion(item, {
          sessionId,
          workspace,
          role: questionContext.role,
          taskId: questionContext.taskId,
          chatId: questionChannel.chatId,
          threadId: questionChannel.threadId,
          now: now(),
          log,
        });
        known.set(created.shortId, created);
        if (known.size > 200) known.delete(known.keys().next().value);
        questions.push(created);
      }
    } catch (error) {
      log(`вопрос: разобрать запрос не удалось (${error?.message ?? error}) — отдаю GUI`);
      return next();
    }

    /** Ответы, которыми TTL закрыл вопрос (empty/default-first). */
    const expiredAnswers = new Map();

    // Ожидание ответа: по промису на вопрос, ключ — короткий id для кнопок.
    // `catch`-заглушка вешается сразу: если вопрос снимают (аборт, ошибка
    // отправки), промис остаётся неразрешённым, но не должен шуметь как
    // необработанный отказ.
    const waiting = [];
    for (const question of questions) {
      question.markOpen(now());
      const waited = new Promise((resolve, reject) => {
        pending.set(question.shortId, { question, resolve, reject, signal: request?.signal ?? null });
      });
      waited.catch(() => {});
      waiting.push(waited);

      // TTL-сторож (008): по истечении вопрос получает исход из конфига. Abort
      // отклоняет ожидание (DSH получит ASK_ABORTED), empty/default-first
      // отдают ответ — иначе сессия ждала бы вечно: таймаута в DSH нет.
      reliability?.watch?.(question, {
        sessionId: question.sessionId,
        onExpire: (info) => {
          const entry = pending.get(question.shortId);
          if (entry === undefined) return;
          pending.delete(question.shortId);
          rememberClosed(question);
          if (info?.kind === "abort") {
            entry.reject(info.error ?? abortError("вопрос истёк по TTL"));
            return;
          }
          expiredAnswers.set(question.shortId, info.answer);
          entry.resolve(question);
        },
      });
    }

    // Аборт слушаем ДО отправки: иначе аборт во время sendQuestion оставил бы
    // handler ждать зависший send (а если send после аборта бросит — мы бы ушли в
    // send-failed и позвали next(), вместо ASK_ABORTED).
    let onAbort = null;
    const aborted = new Promise((_, reject) => {
      const fail = () => reject(abortError());
      if (request?.signal === undefined) return;
      if (request.signal.aborted) {
        fail();
        return;
      }
      if (typeof request.signal.addEventListener !== "function") return;
      onAbort = fail;
      request.signal.addEventListener("abort", fail, { once: true });
    });
    /** Гонка с отменой не должна оставлять необработанный отказ. */
    aborted.catch(() => {});

    /** Для каких вопросов отправка началась: у неотправленного закрывать нечего. */
    const attempted = new Set();

    /**
     * Гибрид (013): если ответа нет `waitMs`, отдаём вопрос в GUI через `next()`.
     * Таймер на каждый вопрос: ответ на один не снимает чужие.
     */
    const hybridState = hybridConfig();
    let guiResolver = null;
    let guiRequested = false;
    const guiRace = new Promise((resolve) => {
      guiResolver = resolve;
    });
    const cleanupHybrid = () => {
      for (const [shortId, timer] of hybridTimers.entries()) {
        try {
          clearTimeoutImpl(timer);
        } catch {
          /* таймер уже сработал */
        }
        hybridTimers.delete(shortId);
      }
    };

    function armHybrid() {
      if (hybridState.enabled !== true) return;
      for (const question of questions) {
        const timer = setTimeoutImpl(() => {
          hybridTimers.delete(question.shortId);
          const waitingEntry = pending.get(question.shortId);
          if (waitingEntry === undefined) return; // уже ответили
          waitingEntry.hybridTimer = null;
          const stillOpen = questions.filter((item) => pending.has(item.shortId));
          const anyAnswered = questions.some((item) => item.status === "answered");
          if (anyAnswered) {
            // Пачка уже частично отвечена: DSH вернул бы GUI весь запрос вместе
            // с отвеченным вопросом, поэтому GUI не зовём — вопрос остаётся
            // обычным ожиданием, его ответ идёт в результат, не в steer.
            log(`гибрид: вопрос ${question.shortId} остался в мессенджере — пачка уже частично отвечена, GUI не зовём`);
            return;
          }
          if (guiRequested) return; // next() уже звали
          waitingEntry.hybridGui = true;
          // Метрика — по числу вопросов, отданных в GUI, а не по числу таймеров.
          stats.hybridHanded += stillOpen.length;
          for (const item of stillOpen) {
            const itemEntry = pending.get(item.shortId);
            if (itemEntry !== undefined) itemEntry.hybridGui = true;
          }
          log(`гибрид: ответа нет ${hybridState.waitMs} мс — отдаю вопросы в GUI (${stillOpen.length})`);
          guiResolver?.(HYBRID_GUI);
        }, hybridState.waitMs);
        timer?.unref?.();
        hybridTimers.set(question.shortId, timer);
        const waitingEntry = pending.get(question.shortId);
        if (waitingEntry !== undefined) waitingEntry.hybridTimer = timer;
      }
    }

    try {
      try {
        for (const question of questions) {
          attempted.add(question);
          if (useBroker) {
            const publication = await Promise.race([publishAll(question, request?.signal), aborted]);
            if (!publication.anyDelivered) {
              // Ни один канал не принял вопрос — он достаётся GUI, как в 008.
              log(`вопрос ${question.shortId}: ни один канал не доставил — отдаю GUI (next)`);
              await closeQuestions(questions, "undelivered", attempted);
              return next();
            }
            // 012: доставки переживают рестарт (state.questions[].deliveries).
            reliability?.noteDeliveries?.(question);
            continue;
          }
          const outcome = await Promise.race([sendOne(question, request?.signal), aborted]);
          if (outcome === "give-up") {
            // Недоставка за отведённое время: вопрос достаётся GUI, сессия не висит.
            log(`вопрос ${question.shortId}: не доставлен — отдаю GUI (next)`);
            await closeQuestions(questions, "undelivered", attempted);
            return next();
          }
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          await closeQuestions(questions, "aborted", attempted);
          throw error;
        }
        log(`вопрос: доставить не удалось (${error?.message ?? error}) — снимаю и отдаю GUI`);
        await closeQuestions(questions, "send-failed", attempted);
        return next();
      }

      armHybrid();
      try {
        const outcome = await Promise.race([Promise.all(waiting), aborted, guiRace]);
        if (outcome === HYBRID_GUI || guiRequested) {
          cleanupHybrid();
          return next();
        }
      } catch (error) {
        cleanupHybrid();
        if (error?.name === "AbortError") {
          await closeQuestions(questions, "aborted", attempted);
          throw error;
        }
        log(`вопрос: ожидание ответа сорвалось (${error?.message ?? error}) — отдаю GUI`);
        await closeQuestions(questions, "failed", attempted);
        return next();
      }
    } finally {
      if (onAbort !== null) {
        try {
          request.signal.removeEventListener("abort", onAbort);
        } catch {
          /* сигнал мог быть уже снят вместе с запросом */
        }
      }
    }

    cleanupHybrid();
    for (const question of questions) pending.delete(question.shortId);
    reliability?.unwatch?.(questions.map((question) => question.shortId));
    log(`вопросов ${questions.length}: ответ получен (${decision.scope})`);
    return {
      answers: questions.map((question) => expiredAnswers.get(question.shortId) ?? question.toAnswer()),
    };
  }

  /**
   * Подписать ответчик на контекст плагина: слушатель waterfall'а + ответы
   * транспорта. Возвращает функцию отписки (её отдаём в `deps.onDispose`).
   */
  function attach(ctx) {
    context = ctx ?? null;
    if (disposed) {
      log("ответчик: плагин уже выгружен — подписка не нужна");
      return () => {};
    }
    const subscribable = channels.filter((item) => typeof item.onAnswer === "function");
    if (subscribable.length === 0) {
      log("ответчик не подписан: ни у одного транспорта нет onAnswer — вопрос уходит в GUI");
      return () => {};
    }

    let offAnswers = [];
    let offRequest = null;
    try {
      offAnswers = subscribable.map((channel) => channel.onAnswer((event) => onTransportAnswer(event, channel)));
    } catch (error) {
      log(`ответчик не подписан: транспорт не отдал onAnswer (${error?.message ?? error})`);
      for (const off of offAnswers) {
        try {
          off?.();
        } catch {
          /* уже отписан */
        }
      }
      return () => {};
    }
    try {
      offRequest = ctx?.on?.("user-questions/request", handler, { prepend: true });
      log("ответчик подписан на user-questions/request (prepend)");
    } catch (error) {
      log(`ответчик не подписан на вопрос: ${error?.message ?? error}`);
    }

    return function detach() {
      try {
        if (typeof offRequest === "function") offRequest();
      } catch (error) {
        log(`ответчик: отписка от вопроса не удалась (${error?.message ?? error})`);
      }
      for (const off of offAnswers) {
        try {
          off?.();
        } catch (error) {
          log(`ответчик: отписка от ответов не удалась (${error?.message ?? error})`);
        }
      }
      dispose("detached");
    };
  }

  /**
   * Выгрузка плагина: открытые вопросы снимаются, их ожидания отклоняются —
   * висящих промисов не остаётся.
   */
  function dispose(reason = "disposed") {
    disposed = true;
    for (const entry of pending.values()) {
      const question = entry.question;
      question.cancel(reason, now());
      try {
        // 012: в мультиканале закрываем все доставки через брокер (одиночный
        // `transport` — пустой фасад, и кнопки остались бы в обоих каналах).
        const closing = useBroker && (question.deliveries?.length ?? 0) > 0
          ? broker.closeAll(question, { winner: null, summary: reason })
          : primary?.closeQuestion?.(question, reason);
        if (closing !== null && typeof closing?.then === "function") closing.catch(() => {});
      } catch (error) {
        log(`вопрос ${question.shortId}: закрыть сообщение не удалось (${error?.message ?? error})`);
      }
      entry.reject(abortError(reason));
    }
    pending.clear();
  }

  return { attach, handler, dispose, stats };
}
