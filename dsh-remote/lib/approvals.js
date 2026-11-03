/**
 * Ответчик waterfall'а `approval/request`: подтверждение действия уходит человеку
 * в канал, его решение возвращается в DSH тем же закрытым исходом.
 *
 * Как это работает по шагам:
 *   1. `attach(ctx)` вешает слушатель с `{ prepend: true }` — ровно как у вопросов:
 *      без этого наш слушатель оказался бы внутри цепочки и вызывался бы только
 *      после `next()` из GUI, то есть никогда (`docs/research/waterfall-order.md`).
 *      Политику `never` сервис DSH решает **до** waterfall — до нас такой запрос не
 *      доходит, и это правильно: детерминированный отказ важнее любых слушателей.
 *   2. Слушатель спрашивает реестр режима. Выключен — `return next()`: подтверждение
 *      рисует GUI, поведение DSH не меняется.
 *   3. Включён — создаётся `RemoteApproval` (`kind: "approval"`), уходит в канал с
 *      тремя кнопками: «Разрешить один раз» (`allowed-once`), «Отклонить»
 *      (`rejected`), «Не отвечать» (`unavailable`). Слушатель ждёт ответа и
 *      возвращает исход. «Разрешить навсегда» нет: это отдельная политика.
 *   4. `request.signal` абортнут — сообщение закрывается («снято»), возвращаем
 *      `cancelled`. Поздний ответ после аборта игнорируется: DSH уже снял запрос.
 *   5. Доставка не удалась ни в один канал (или канал не умеет кнопки/ответы) —
 *      `next()`: подтверждение достаётся GUI, как у вопросов. Бросать исключение
 *      нельзя: сервис DSH превратит его в `unavailable`, и человек в GUI не увидит
 *      запрос вообще.
 *
 * Исходы возвращаются **ровно** значениями DSH (`allowed-once`, `rejected`,
 * `cancelled`, `unavailable`): чужое значение сервис нормализует в `unavailable`,
 * но полагаться на это не надо — иначе fail-closed политика превращается в лотерею.
 */

import { createBroker } from "./broker.js";
import {
  APPROVAL_OUTCOME,
  RemoteApproval,
  outcomeOfOption,
  outcomeSummary,
} from "./domain/approval.js";
import { resolveContext } from "./present.js";

const noopLog = () => {};

/** Имя waterfall'а DSH для подтверждений. */
export const APPROVAL_REQUEST_EVENT = "approval/request";

/**
 * Создать ответчик подтверждений.
 *
 * @param {object} options
 * @param {object|null} [options.transport] — транспорт мессенджера (контракт вопроса).
 * @param {object[]|null} [options.transports] — несколько каналов (012-подобная гонка).
 * @param {object} options.registry — реестр режима (`domain/registry.js`).
 * @param {(message: string) => void} [options.log]
 * @param {() => number} [options.now]
 * @param {number} [options.ttlMs] — сколько показывать в дедлайне (политика — 025).
 * @param {Function|null} [options.deliver] — доставка через reliability (008).
 * @param {Function|null} [options.deliverFor] — доставка на конкретный канал.
 * @param {Function|null} [options.channelOf] — канал проекта (015).
 * @param {object|null} [options.audit] — журнал решений (`lib/audit.js`, задача 026).
 */
export function createApprovals({
  transport = null,
  transports = null,
  registry,
  log = noopLog,
  now = Date.now,
  ttlMs = undefined,
  deliver = null,
  deliverFor = null,
  channelOf = null,
  audit = null,
} = {}) {
  /** Счётчики решений — для `/remote status` (026). */
  const stats = { claimed: 0, allowed: 0, rejected: 0, unavailable: 0, cancelled: 0 };

  const channels = (Array.isArray(transports) && transports.length > 0 ? transports : (transport === null ? [] : [transport]))
    .filter((item) => item !== null && typeof item === "object");
  const useBroker = channels.length > 1;
  const broker = useBroker ? createBroker({ transports: channels, deliverFor, log }) : null;
  const primary = channels[0] ?? null;
  /** Каналы, умеющие сообщить ответ: без них подтверждение брать нельзя. */
  const subscribable = channels.filter((item) => typeof item.onAnswer === "function");

  /** Открытые подтверждения: `shortId → {approval, resolve, settled}`. */
  const pending = new Map();
  /** Закрытые подтверждения: поздний ответ логируем, но исход не меняем (027). */
  const recentlyClosed = new Map();
  /** Номер в очереди подтверждений (027): «#1, #2…» для человека и журнала. */
  let queueCounter = 0;
  /** Сообщения, уже закрытые: повторное закрытие — ложный сигнал транспорту. */
  const closed = new Set();
  /** Контекст плагина: из него берём cwd сессии для scope и шапки. */
  let context = null;
  let disposed = false;
  let offAnswers = [];
  let offRequest = null;

  const workspaces = new Map();
  function workspaceOf(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return null;
    if (workspaces.has(sessionId)) return workspaces.get(sessionId);
    let cwd = null;
    try {
      const sessions = context?.get?.("sessions");
      const session = sessions?.get?.(sessionId);
      cwd = typeof session?.header?.cwd === "string" && session.header.cwd !== "" ? session.header.cwd : null;
    } catch {
      cwd = null;
    }
    workspaces.set(sessionId, cwd);
    return cwd;
  }

  /** Канал проекта (015): свой чат/топик на транспорт; ошибка — общий канал. */
  function channelFor(workspace, transportId) {
    if (typeof channelOf !== "function") return { chatId: null, threadId: null };
    try {
      const resolved = channelOf(workspace, transportId) ?? {};
      return { chatId: resolved.chatId ?? null, threadId: resolved.threadId ?? null };
    } catch (error) {
      log(`подтверждение: канал проекта не определён (${error?.message ?? error})`);
      return { chatId: null, threadId: null };
    }
  }

  /** Параметры отправки с учётом канала проекта (015). */
  const sendOptionsFor = (approval) => ({
    ...(approval.chatId === null || approval.chatId === undefined ? {} : { chatId: approval.chatId }),
    ...(approval.threadId === null || approval.threadId === undefined ? {} : { threadId: approval.threadId }),
  });

  /**
   * Доставить подтверждение: один канал — прямой путь, несколько — брокер (012).
   *
   * Каналы проекта (015) считаются **на каждый транспорт**: `channelFor`
   * пересчитывается по id транспорта в брокере, иначе телеграм-чата уехал бы в
   * MAX. `deliver` (008) получает те же адреса, что и прямой `sendQuestion`.
   *
   * Reliability (008) в подтверждения намеренно не подключаем: решение
   * одноразовое и срочное, повторная отправка спутала бы человека вторым
   * сообщением. Поэтому `deliver` — только если его передал вызывающий, а
   * результат (`give-up`/`aborted`/`false`) трактуется как «не доставили».
   */
  async function publish(approval, signal) {
    if (useBroker) {
      const publication = await broker.publish(approval, {
        signal,
        chatId: approval.chatId ?? undefined,
        threadId: approval.threadId ?? undefined,
        channelFor: (transportId) => channelFor(approval.workspace, transportId),
      });
      return { anyDelivered: publication.anyDelivered, winner: publication.delivered[0] ?? null };
    }
    const outcome = typeof deliver === "function"
      ? await deliver({ question: approval, signal, ...sendOptionsFor(approval) })
      : await primary.sendQuestion(approval, sendOptionsFor(approval));
    if (outcome === "give-up" || outcome === "aborted" || outcome === false) {
      return { anyDelivered: false, reason: String(outcome) };
    }
    return { anyDelivered: true, winner: primary };
  }

  /** Закрыть сообщение по всем каналам ровно один раз. */
  async function closeMessage(approval, summary, winner = null) {
    if (closed.has(approval.shortId)) return;
    closed.add(approval.shortId);
    try {
      if (useBroker) {
        await broker.closeAll(approval, { winner, summary });
      } else {
        await primary?.closeQuestion?.(approval, summary);
      }
    } catch (error) {
      log(`подтверждение ${approval.shortId}: закрыть сообщение не удалось (${error?.message ?? error})`);
    }
  }

  /** Выдать исход ожидающему слушателю: ровно один раз. */
  function settle(entry, outcome) {
    if (entry.settled) return;
    recentlyClosed.set(entry.approval.shortId, {
      approval: entry.approval,
      outcome,
      at: now(),
    });
    if (recentlyClosed.size > 100) {
      const oldest = recentlyClosed.keys().next().value;
      recentlyClosed.delete(oldest);
    }
    entry.settled = true;
    pending.delete(entry.approval.shortId);
    entry.resolve(outcome);
  }

  /**
   * Ответ транспорта: найти подтверждение по `shortId` и вернуть исход.
   *
   * Свободный текст у подтверждений не принимается: решение — только кнопка.
   * Неизвестная кнопка не роняет ожидание: сообщение остаётся с кнопками.
   */
  /**
   * Подсказка «решение — кнопкой»: свободный текст не считается ответом (027).
   * Шлём её через тот канал, откуда пришёл текст: в мультиканале человек пишет
   * в MAX, и просьба нажать кнопку должна прийти туда же, а не в primary.
   */
  async function sendHint(approval, sourceTransport = null) {
    const transport = sourceTransport ?? primary;
    if (typeof transport?.sendQuestion !== "function") return;
    const delivery = Array.isArray(approval.deliveries)
      ? approval.deliveries.find((item) => item.transport === transport.id)
      : undefined;
    const chatId = delivery?.chatId ?? approval.chatId ?? null;
    const threadId = approval.threadId ?? null;
    try {
      await transport.sendQuestion(
        {
          kind: "approval-hint",
          shortId: `h${approval.shortId}`.slice(0, 8),
          title: "Подтверждение действия",
          body: "Решение принимается кнопкой: «Разрешить один раз» или «Отклонить». "
            + "Свободный текст не считается ответом.",
          options: [],
          multiSelect: false,
          allowFreeText: false,
          chatId,
          threadId,
        },
        {
          ...(chatId === null ? {} : { chatId }),
          ...(threadId === null ? {} : { threadId }),
        },
      );
    } catch (error) {
      log(`подтверждение ${approval.shortId}: подсказку отправить не удалось (${error?.message ?? error})`);
    }
  }

  function onTransportAnswer(event, sourceTransport = null) {
    if (event === null || typeof event !== "object") return;
    const shortId = typeof event.shortId === "string" ? event.shortId : "";
    const entry = pending.get(shortId);
    if (entry === undefined) {
      const closedApproval = recentlyClosed.get(shortId);
      if (closedApproval !== undefined) {
        // Поздний ответ на закрытое подтверждение (таймаут/аборт/решено в GUI):
        // исход уже принят, ответ только журналируем (027).
        log(`подтверждение ${shortId}: уже закрыто (${closedApproval.outcome}) — поздний ответ игнорирую`);
      } else {
        log(`подтверждение ${shortId || "(без shortId)"}: ответа никто не ждёт — игнорирую`);
      }
      return;
    }
    // Подтверждение решается только кнопкой: свободный текст — не ответ (027).
    const text = typeof event.text === "string" ? event.text.trim() : "";
    const hasOption = Array.isArray(event.optionIds)
      ? event.optionIds.length > 0
      : Array.isArray(event.optionId)
        ? event.optionId.length > 0
        : typeof event.optionId === "string" && event.optionId !== "";
    if (!hasOption) {
      if (text !== "") {
        log(`подтверждение ${shortId}: свободный текст не считается ответом — прошу нажать кнопку`);
        void sendHint(entry.approval, sourceTransport);
      } else {
        log(`подтверждение ${shortId}: ответ без кнопки — игнорирую`);
      }
      return;
    }

    const optionIds = Array.isArray(event.optionIds)
      ? event.optionIds
      : Array.isArray(event.optionId)
        ? event.optionId
        : typeof event.optionId === "string"
          ? [event.optionId]
          : [];
    const outcome = outcomeOfOption(optionIds[0]);
    if (outcome === null) {
      log(`подтверждение ${shortId}: неизвестная кнопка ${String(optionIds[0])} — игнорирую`);
      return;
    }
    if (!entry.approval.decide(outcome, now())) return;
    // 027: запомнить канал-победитель — проигравший закроется пометкой.
    entry.approval.answeredVia = sourceTransport?.id ?? entry.approval.answeredVia ?? null;
    statsFor(outcome);
    record(entry.approval, {
      outcome,
      decision: "remote",
      channel: sourceTransport?.id ?? null,
      chatId: typeof event.chatId === "string" || typeof event.chatId === "number" ? String(event.chatId) : entry.approval.chatId,
      answeredBy: typeof event.answeredBy === "string" && event.answeredBy !== "" ? event.answeredBy : null,
    });
    void closeMessage(entry.approval, outcomeSummary(outcome), sourceTransport);
    settle(entry, outcome);
  }

  /**
   * Записать решение в журнал (026).
   *
   * Пишем только метаданные: id подтверждения, инструмент, исход, канал, кто/где
   * и сколько ждали. `reason`/`displayReason` не пишем — это может быть текст
   * команды, а журналу тела не нужны. `decision`: `remote` — человек ответил
   * кнопкой, `gui` — отдали GUI (доставка не удалась), `timeout` — снято без
   * ответа (аборт запроса; TTL-политика — задача 025).
   */
  function record(approval, { outcome, decision, channel = null, chatId = null, answeredBy = null }) {
    if (audit === null) return;
    audit.append({
      kind: "approval",
      questionId: approval.id,
      toolName: approval.toolName,
      callId: approval.callId ?? undefined,
      outcome,
      channel: channel ?? undefined,
      chatId: chatId ?? undefined,
      answeredBy: answeredBy ?? undefined,
      sessionId: approval.sessionId ?? undefined,
      workspace: approval.workspace ?? undefined,
      waitedMs: Math.max(0, now() - approval.createdAt),
      decision,
    });
  }

  function statsFor(outcome) {
    if (outcome === APPROVAL_OUTCOME.allowedOnce) stats.allowed += 1;
    else if (outcome === APPROVAL_OUTCOME.rejected) stats.rejected += 1;
    else if (outcome === APPROVAL_OUTCOME.unavailable) stats.unavailable += 1;
    else if (outcome === APPROVAL_OUTCOME.cancelled) stats.cancelled += 1;
  }

  /** Маркировка (006): роль и задача сессии. Ошибки чтения не мешают подтверждению. */
  function marksOf(sessionId) {
    try {
      const resolved = resolveContext({ sessionId, ctx: context, log });
      return { role: resolved?.role ?? null, taskId: resolved?.taskId ?? null };
    } catch (error) {
      log(`подтверждение: контекст сессии не прочитан (${error?.message ?? error})`);
      return { role: null, taskId: null };
    }
  }

  async function handler(request, next) {
    const toolName = typeof request?.toolName === "string" ? request.toolName : "";
    if (toolName === "") {
      log("подтверждение без toolName — не наш запрос, отдаю GUI (next)");
      return next();
    }

    const sessionId = typeof request?.agent?.id === "string" ? request.agent.id : null;
    const workspace = workspaceOf(sessionId);
    let decision = { enabled: false, scope: null };
    try {
      decision = registry?.resolve?.({ sessionId, workspace }) ?? decision;
    } catch (error) {
      log(`реестр режима: ${error?.message ?? error} — считаю режим выключенным`);
    }
    if (!decision.enabled) {
      // Выключенный режим не логируем: плагин не забирает запрос, и журнал не
      // должен собирать инструменты действий, которые удалённо не подтверждали.
      log(`подтверждение ${toolName} (${sessionId ?? "без агента"}): режим выключен — отдаю GUI (next)`);
      return next();
    }

    // Модель создаём ДО проверок транспорта: иначе «отдано GUI» и «снято по
    // аборту» не попадали бы в журнал (а карточка 026 требует каждое решение).
    const marks = marksOf(sessionId);
    const channel = channelFor(workspace, primary?.id ?? null);
    const queueNumber = ++queueCounter;
    const approval = new RemoteApproval(request, {
      sessionId,
      workspace,
      role: marks.role,
      taskId: marks.taskId,
      queueNumber,
      chatId: channel.chatId,
      threadId: channel.threadId,
      now: now(),
      ...(Number.isFinite(ttlMs) ? { ttlMs } : {}),
      log,
    });

    if (request?.signal?.aborted === true) {
      approval.cancel("aborted", now());
      stats.cancelled += 1;
      record(approval, { outcome: APPROVAL_OUTCOME.cancelled, decision: "timeout" });
      return APPROVAL_OUTCOME.cancelled;
    }
    if (typeof deliver !== "function" && !useBroker && typeof primary?.sendQuestion !== "function") {
      approval.cancel("no-transport", now());
      record(approval, { outcome: APPROVAL_OUTCOME.unavailable, decision: "gui" });
      log("подтверждение: транспорт не умеет sendQuestion — отдаю GUI (next)");
      return next();
    }
    if (subscribable.length === 0) {
      approval.cancel("no-onanswer", now());
      record(approval, { outcome: APPROVAL_OUTCOME.unavailable, decision: "gui" });
      log("подтверждение: транспорт не умеет onAnswer — отдаю GUI (next)");
      return next();
    }

    /** Ожидание решения + гонка с абортом запроса. */
    const outcome = await new Promise((resolve) => {
      const entry = { approval, resolve, settled: false, delivered: false };
      pending.set(approval.shortId, entry);

      const onAbort = () => {
        if (entry.settled) return;
        approval.cancel("aborted", now());
        stats.cancelled += 1;
        record(approval, {
          outcome: APPROVAL_OUTCOME.cancelled,
          decision: "timeout",
          channel: entry.channelId ?? null,
        });
        // Сообщение могло ещё не уйти: закрывать нечего, но если доставка уже
        // началась — снимем кнопки, как только она завершится (ниже, в then).
        if (entry.delivered) {
          void closeMessage(approval, outcomeSummary(APPROVAL_OUTCOME.cancelled));
        }
        settle(entry, APPROVAL_OUTCOME.cancelled);
      };
      if (typeof request?.signal?.addEventListener === "function") {
        request.signal.addEventListener("abort", onAbort, { once: true });
      }

      const finish = (value) => {
        if (typeof request?.signal?.removeEventListener === "function") {
          request.signal.removeEventListener("abort", onAbort);
        }
        resolve(value);
      };
      entry.resolve = finish;

      const failToGui = () => {
        if (entry.settled) return;
        approval.cancel("delivery-failed", now());
        record(approval, {
          outcome: APPROVAL_OUTCOME.unavailable,
          decision: "gui",
          channel: entry.channelId ?? null,
        });
        settle(entry, "next");
      };

      let publication;
      try {
        publication = publish(approval, request?.signal);
      } catch (error) {
        log(`подтверждение ${approval.shortId}: отправить не удалось (${error?.message ?? error})`);
        failToGui();
        return;
      }
      void publication.then((result) => {
        if (result?.anyDelivered !== true) {
          log(`подтверждение ${approval.shortId}: ни один канал не доставил — отдаю GUI (next)`);
          failToGui();
          return;
        }
        entry.delivered = true;
        entry.channelId = result?.winner?.id ?? primary?.id ?? null;
        approval.markOpen();
        stats.claimed += 1;
        // Аборт мог выиграть гонку, пока сообщение доставлялось: снимаем его сразу,
        // чтобы у человека не осталась живая кнопка на уже снятый запрос.
        if (entry.settled) {
          void closeMessage(approval, outcomeSummary(APPROVAL_OUTCOME.cancelled));
        }
      }).catch((error) => {
        log(`подтверждение ${approval.shortId}: доставка упала (${error?.message ?? error})`);
        failToGui();
      });
    });

    if (outcome === "next") return next();
    return outcome;
  }

  function attach(ctx) {
    context = ctx ?? null;
    if (disposed) {
      log("ответчик подтверждений: плагин уже выгружен — подписка не нужна");
      return () => {};
    }
    if (subscribable.length === 0) {
      log("ответчик подтверждений не подписан: ни у одного транспорта нет onAnswer — подтверждения уйдут в GUI");
      return () => {};
    }
    try {
      // 027: канал передаётся в обработчик — победитель закрывается ответом,
      // проигравшие — пометкой «отвечено в другом канале».
      offAnswers = subscribable.map((channel) => channel.onAnswer((event) => onTransportAnswer(event, channel)));
    } catch (error) {
      log(`ответчик подтверждений не подписан: транспорт не отдал onAnswer (${error?.message ?? error})`);
      for (const off of offAnswers) {
        try {
          off?.();
        } catch {
          /* уже отписан */
        }
      }
      offAnswers = [];
      return () => {};
    }
    try {
      offRequest = ctx?.on?.(APPROVAL_REQUEST_EVENT, handler, { prepend: true });
      log("ответчик подтверждений подписан на approval/request (prepend)");
    } catch (error) {
      log(`ответчик подтверждений не подписан на approval/request: ${error?.message ?? error}`);
    }

    return function detach() {
      try {
        if (typeof offRequest === "function") offRequest();
      } catch (error) {
        log(`ответчик подтверждений: отписка не удалась (${error?.message ?? error})`);
      }
      for (const off of offAnswers) {
        try {
          off?.();
        } catch (error) {
          log(`ответчик подтверждений: отписка от ответов не удалась (${error?.message ?? error})`);
        }
      }
      dispose("detached");
    };
  }

  /** Выгрузка плагина: открытые подтверждения снимаются и отвечаются `cancelled`. */
  function dispose(reason = "disposed") {
    disposed = true;
    for (const entry of [...pending.values()]) {
      if (!entry.approval.cancel(reason, now())) continue;
      stats.cancelled += 1;
      record(entry.approval, {
        outcome: APPROVAL_OUTCOME.cancelled,
        decision: "timeout",
        channel: entry.channelId ?? null,
      });
      void closeMessage(entry.approval, outcomeSummary(APPROVAL_OUTCOME.cancelled));
      settle(entry, APPROVAL_OUTCOME.cancelled);
    }
    pending.clear();
  }

  return { attach, handler, dispose, stats, pending };
}
