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

import { createQuestion } from "./domain/question.js";

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
export function createAnswerer({ transport, registry, log = noopLog, now = Date.now } = {}) {
  /** Открытые вопросы по короткому id: ждём ответа транспорта. */
  const pending = new Map();
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
  async function closeQuestions(questions, reason, attempted = null) {
    for (const question of questions) {
      pending.delete(question.shortId);
      // Уже отвеченный или закрытый вопрос второй раз не закрываем: сообщение в
      // мессенджере и так снято, а лишний closeQuestion — ложный сигнал транспорту.
      if (!question.cancel(reason, now())) continue;
      if (attempted !== null && !attempted.has(question)) continue;
      try {
        await transport?.closeQuestion?.(question, reason);
      } catch (error) {
        log(`вопрос ${question.shortId}: закрыть сообщение не удалось (${error?.message ?? error})`);
      }
    }
  }

  /** Ответ транспорта: разнести по ожидающим вопросам и разбудить слушатель. */
  function onTransportAnswer(event) {
    const normalized = normalizeAnswerEvent(event);
    if (normalized === null) {
      log("ответ транспорта: событие без shortId — игнор");
      return;
    }
    const entry = pending.get(normalized.shortId);
    if (entry === undefined) {
      log(`ответ на ${normalized.shortId}: вопроса нет (уже отвечен или закрыт) — игнор`);
      return;
    }
    const parsed = choiceFor(entry.question, normalized);
    if (parsed.error !== undefined) {
      log(`ответ на ${normalized.shortId} отклонён: ${parsed.error}`);
      return;
    }
    if (!entry.question.accept(parsed.choice, { answeredBy: normalized.answeredBy, now: now() })) return;
    pending.delete(normalized.shortId);
    entry.resolve(entry.question);
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

    const sessionId = typeof request?.agent?.id === "string" ? request.agent.id : null;
    const workspace = workspaceOf(sessionId);
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
    if (typeof transport?.sendQuestion !== "function") {
      log("вопрос: транспорт не умеет sendQuestion — отдаю GUI (next)");
      return next();
    }

    const questions = [];
    try {
      for (const item of items) {
        questions.push(createQuestion(item, { sessionId, workspace, now: now(), log }));
      }
    } catch (error) {
      log(`вопрос: разобрать запрос не удалось (${error?.message ?? error}) — отдаю GUI`);
      return next();
    }

    // Ожидание ответа: по промису на вопрос, ключ — короткий id для кнопок.
    // `catch`-заглушка вешается сразу: если вопрос снимают (аборт, ошибка
    // отправки), промис остаётся неразрешённым, но не должен шуметь как
    // необработанный отказ.
    const waiting = [];
    for (const question of questions) {
      question.markOpen(now());
      const waited = new Promise((resolve, reject) => {
        pending.set(question.shortId, { question, resolve, reject });
      });
      waited.catch(() => {});
      waiting.push(waited);
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

    try {
      try {
        for (const question of questions) {
          attempted.add(question);
          await Promise.race([transport.sendQuestion(question), aborted]);
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

      try {
        await Promise.race([Promise.all(waiting), aborted]);
      } catch (error) {
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

    for (const question of questions) pending.delete(question.shortId);
    log(`вопросов ${questions.length}: ответ получен (${decision.scope})`);
    return { answers: questions.map((question) => question.toAnswer()) };
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
    if (typeof transport?.onAnswer !== "function") {
      log("ответчик не подписан: у транспорта нет onAnswer — вопрос уходит в GUI");
      return () => {};
    }

    let offAnswer = null;
    let offRequest = null;
    try {
      offAnswer = transport.onAnswer(onTransportAnswer);
    } catch (error) {
      log(`ответчик не подписан: транспорт не отдал onAnswer (${error?.message ?? error})`);
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
      try {
        if (typeof offAnswer === "function") offAnswer();
      } catch (error) {
        log(`ответчик: отписка от ответов не удалась (${error?.message ?? error})`);
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
      entry.question.cancel(reason, now());
      try {
        const closing = transport?.closeQuestion?.(entry.question, reason);
        if (closing !== null && typeof closing?.then === "function") closing.catch(() => {});
      } catch (error) {
        log(`вопрос ${entry.question.shortId}: закрыть сообщение не удалось (${error?.message ?? error})`);
      }
      entry.reject(abortError(reason));
    }
    pending.clear();
  }

  return { attach, handler, dispose };
}
