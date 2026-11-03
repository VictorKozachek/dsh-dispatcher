/**
 * Домен подтверждения (`approval/request`): модель `RemoteApproval` и три исхода,
 * которые понимает DSH.
 *
 * Зачем отдельная модель, а не `RemoteQuestion`: у вопроса ответ — свободная форма
 * (варианты/текст), у подтверждения — **закрытый словарь** исходов
 * (`allowed-once | rejected | cancelled | unavailable`), и «Разрешить навсегда»
 * сознательно отсутствует. Но раскладка сообщения та же, что у вопроса (006):
 * шапка «воркспейс · задача · роль · время · до дедлайна», тело и кнопки, поэтому
 * модель повторяет поля `RemoteQuestion` и помечена `kind: "approval"` — так
 * транспорт, store и роутинг работают без ветвлений.
 *
 * Контракт DSH (`@deepseek-ai/dsh-user-approval` v0.2.1-rc.5,
 * `packages/interaction/user-approval/src/index.ts`):
 *   - `ApprovalRequestEvent {agent, toolName, callId?, reason?, displayReason?, signal?}`;
 *   - waterfall `approval/request`; слушатель возвращает исход или `next()`;
 *   - `approval.request()` требует открытый ход (turn) и пишет пару
 *     `approval/asked` + `approval/decided` в журнал сессии;
 *   - политика `never` решается сервисом ДО waterfall, до слушателей дело не доходит;
 *   - исключение слушателя = `unavailable` (fail closed), поэтому бросать нельзя:
 *     «нет ответа» должно быть осознанным исходом.
 */

import { randomBytes, randomUUID } from "node:crypto";

const noopLog = () => {};

/** Статусы подтверждения. `pending` — создано, но ещё не доставлено. */
export const APPROVAL_STATUS = Object.freeze({
  pending: "pending",
  open: "open",
  decided: "decided",
  cancelled: "cancelled",
});

/** Закрытый словарь исходов DSH. Другие значения сервис нормализует в `unavailable`. */
export const APPROVAL_OUTCOME = Object.freeze({
  allowedOnce: "allowed-once",
  rejected: "rejected",
  cancelled: "cancelled",
  unavailable: "unavailable",
});

/**
 * Кнопки решения. «Разрешить навсегда» нет и не будет: это отдельная политика
 * безопасности (спека 004, «вне скоупа»), а не UX.
 */
export const APPROVAL_ACTIONS = Object.freeze([
  { id: "o1", label: "Разрешить один раз", outcome: APPROVAL_OUTCOME.allowedOnce },
  { id: "o2", label: "Отклонить", outcome: APPROVAL_OUTCOME.rejected },
  { id: "o3", label: "Не отвечать", outcome: APPROVAL_OUTCOME.unavailable },
]);

/** Заголовок сообщения: по нему человек понимает, что это не вопрос, а опасное действие. */
export const APPROVAL_TITLE = "Подтверждение действия";

/** Сколько живёт сообщение по умолчанию (TTL пока только показывается в шапке). */
export const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Исход кнопки по её короткому id (`o1`/`o2`/`o3`); неизвестная — `null`. */
export function outcomeOfOption(optionId) {
  return APPROVAL_ACTIONS.find((action) => action.id === optionId)?.outcome ?? null;
}

/** Текст, которым заменяется сообщение после решения (и виден в мессенджере). */
export function outcomeSummary(outcome) {
  switch (outcome) {
    case APPROVAL_OUTCOME.allowedOnce:
      return "Разрешено один раз";
    case APPROVAL_OUTCOME.rejected:
      return "Отклонено";
    case APPROVAL_OUTCOME.unavailable:
      return "Решение не принято (не отвечать)";
    case APPROVAL_OUTCOME.cancelled:
      return "Снято";
    default:
      return "Решение принято";
  }
}

/**
 * Подтверждение действия, ушедшее в канал.
 *
 * Инварианты:
 *   - решается ровно один раз: повторное нажатие возвращает `false` и пишет строку
 *     в лог (человек мог нажать дважды, пока сообщение редактировалось);
 *   - `toolName` обязателен: без него непонятно, что именно разрешают;
 *   - исход — только из `APPROVAL_OUTCOME`.
 */
export class RemoteApproval {
  /**
   * @param {object} request — `ApprovalRequestEvent` из DSH.
   * @param {object} [context] — `sessionId`, `workspace`, `role`, `taskId`,
   *   `now` (мс epoch), `ttlMs`, `log`.
   */
  constructor(request, context = {}) {
    if (request === null || typeof request !== "object") {
      throw new TypeError("подтверждение должно быть объектом ApprovalRequestEvent");
    }
    if (typeof request.toolName !== "string" || request.toolName === "") {
      throw new TypeError("у подтверждения нет toolName: непонятно, что разрешать");
    }

    const now = typeof context.now === "number" ? context.now : Date.now();
    const ttlMs = Number.isFinite(context.ttlMs) && context.ttlMs > 0 ? context.ttlMs : DEFAULT_TTL_MS;
    const log = typeof context.log === "function" ? context.log : noopLog;

    /** Тип записи: транспорт и store различают вопросы и подтверждения. */
    this.kind = "approval";
    /** Собственный id (uuid) — для реестра плагина. */
    this.id = randomUUID();
    /** Короткий id для `callback_data` кнопок (8 hex). */
    this.shortId = randomBytes(4).toString("hex");
    this.sessionId = context.sessionId ?? null;
    this.workspace = context.workspace ?? null;
    this.role = context.role ?? null;
    this.taskId = context.taskId ?? null;
    /** 015: канал проекта (`chatId` + опциональный `threadId` топика). */
    this.chatId = context.chatId ?? null;
    this.threadId = context.threadId ?? null;

    /** Инструмент, который просит разрешение (Bash, Write, …). */
    this.toolName = request.toolName;
    /** id вызова инструмента, если DSH его дал (для сопоставления с журналом). */
    this.callId = typeof request.callId === "string" && request.callId !== "" ? request.callId : null;
    /** Причина в терминах журнала DSH. */
    this.reason = typeof request.reason === "string" && request.reason !== "" ? request.reason : null;
    /** Локализованный текст причины (показываем человеку, если он есть). */
    this.displayReason =
      typeof request.displayReason === "string" && request.displayReason !== "" ? request.displayReason : null;

    this.title = APPROVAL_TITLE;
    /** Тело сообщения: инструмент и причина — то, по чему человек принимает решение. */
    this.body = renderBody(this);
    /** callId — второй строкой: помогает искать то же действие в журнале сессии. */
    this.detail = this.callId === null ? null : `callId: ${this.callId}`;
    this.options = APPROVAL_ACTIONS.map((action) => ({ id: action.id, label: action.label }));
    this.multiSelect = false;
    /** Свободного ответа у подтверждения нет: только три кнопки. */
    this.allowFreeText = false;
    this.createdAt = now;
    this.expiresAt = now + ttlMs;
    this.status = APPROVAL_STATUS.pending;
    /** Куда доставлено: по записи на канал (контракт брокера 012). */
    this.deliveries = [];
    /** Итоговый исход (`null`, пока не решено). */
    this.outcome = null;
    this.decidedAt = null;

    this._log = log;
  }

  /** Доставка в канал: тот же контракт, что у вопроса (брокер 012). */
  addDelivery(delivery) {
    if (delivery === null || typeof delivery !== "object") return;
    this.deliveries.push({
      transport: String(delivery.transport ?? ""),
      messageId: delivery.messageId ?? null,
      chatId: delivery.chatId ?? null,
    });
  }

  /**
   * Зафиксировать решение. Возвращает `false`, если подтверждение уже решено или
   * снято, — повтор не переигрывает решение.
   *
   * @param {string} outcome — одно из `APPROVAL_OUTCOME`.
   * @param {number} [at] — мс epoch решения.
   */
  decide(outcome, at = Date.now()) {
    if (!Object.values(APPROVAL_OUTCOME).includes(outcome)) {
      this._log(`подтверждение ${this.shortId}: неизвестный исход ${outcome} — игнорирую`);
      return false;
    }
    if (this.status === APPROVAL_STATUS.decided || this.status === APPROVAL_STATUS.cancelled) {
      this._log(`подтверждение ${this.shortId}: уже решено (${this.status}) — повтор игнорирую`);
      return false;
    }
    this.status = APPROVAL_STATUS.decided;
    this.outcome = outcome;
    this.decidedAt = at;
    return true;
  }

  /** Снять подтверждение без решения (аборт запроса, выгрузка плагина). */
  cancel(reason = "cancelled", at = Date.now()) {
    if (this.status === APPROVAL_STATUS.cancelled) return false;
    this.status = APPROVAL_STATUS.cancelled;
    this.outcome = APPROVAL_OUTCOME.cancelled;
    this.decidedAt = at;
    this._log(`подтверждение ${this.shortId}: снято (${reason})`);
    return true;
  }
}

/**
 * Тело сообщения: инструмент и причина. Причина — `displayReason` (человеческий
 * текст), иначе `reason` (термины журнала).
 */
function renderBody(approval) {
  const lines = [`Инструмент: ${approval.toolName}`];
  const reason = approval.displayReason ?? approval.reason;
  if (reason !== null) lines.push(`Причина: ${reason}`);
  return lines.join("\n");
}
