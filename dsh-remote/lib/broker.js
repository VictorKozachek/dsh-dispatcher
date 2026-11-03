/**
 * Брокер каналов (задача 012): один вопрос — несколько транспортов, первый ответ
 * побеждает.
 *
 * Ответчик не должен знать про конкретные платформы: он получает список
 * транспортов, публикует вопрос во все и ждёт первый ответ. Проигравшие каналы
 * закрываются с пометкой «Отвечено в другом канале» — сообщение правится, кнопки
 * снимаются, чтобы человек не нажал второй раз.
 *
 * Правила:
 *   - ошибка одного канала не блокирует второй: если доставили хотя бы в один,
 *     вопрос живой (`anyDelivered`);
 *   - не доставили ни в один — вызывающий решает отдать вопрос в GUI (`next()`);
 *   - доставки пишутся в модель вопроса (`question.deliveries`), чтобы закрытие
 *     прошло по всем каналам, а не только по победителю.
 *
 * Сеть, часы и таймеры сюда не входят: транспорт приходит готовым (004/011).
 */

/** Пометка для проигравшего канала: и текст, и «тихая» причина закрытия. */
export const ANSWERED_ELSEWHERE = "answered-elsewhere";

/** Текст пометки для человека. */
export const ANSWERED_ELSEWHERE_TEXT = "Отвечено в другом канале";

/**
 * Создать брокер над списком транспортов.
 *
 * @param {object} options
 * @param {object[]} options.transports — реализации `QuestionTransport`.
 * @param {((transport: object) => ((arg: {question: object, signal?: AbortSignal}) => any))|null} [options.deliverFor]
 *   Обёртка доставки на канал (например, reliability 008); по умолчанию —
 *   `transport.sendQuestion`.
 * @param {(message: string) => void} [options.log]
 * @returns {{transports: object[], publish: Function, closeAll: Function, transportOf: Function}}
 */
export function createBroker({ transports = [], deliverFor = null, log = () => {} } = {}) {
  const channels = (Array.isArray(transports) ? transports : [])
    .filter((transport) => transport !== null && typeof transport === "object" && typeof transport.id === "string");

  /** Найти канал по id. */
  function transportOf(id) {
    const found = channels.find((transport) => transport.id === id) ?? null;
    return found;
  }

  /** Доставка в один канал: результат нормализуем к `{ok, messageId, chatId}`. */
  async function deliverOne(transport, question, { signal } = {}) {
    const deliver = typeof deliverFor === "function" ? deliverFor(transport) : null;
    let token;
    try {
      const outcome = typeof deliver === "function"
        ? await deliver({ question, signal })
        : await transport.sendQuestion(question);
      // `deliver` из 008 возвращает строку; прямой sendQuestion — `{messageId}`,
      // `undefined` или `"give-up"`.
      if (outcome === "give-up" || outcome === "aborted" || outcome === false) {
        return { ok: false, reason: String(outcome) };
      }
      token = typeof outcome === "object" && outcome !== null ? outcome : {};
      return { ok: true, messageId: token.messageId ?? null, chatId: transport.chatId ?? null };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * Опубликовать вопрос во все каналы.
   *
   * @param {object} question — модель вопроса (у неё будут `deliveries`).
   * @param {{signal?: AbortSignal}} [options]
   * @returns {{delivered: object[], failed: object[], anyDelivered: boolean, allFailed: boolean}}
   */
  async function publish(question, { signal } = {}) {
    if (question === null || typeof question !== "object") throw new TypeError("broker: нужен вопрос");
    const results = await Promise.all(
      channels.map(async (transport) => {
        if (signal?.aborted === true) return { transport, ok: false, reason: "aborted" };
        const result = await deliverOne(transport, question, { signal });
        if (!result.ok) {
          log(`broker: канал ${transport.id} не доставил вопрос ${question.shortId}`
            + `${result.reason === undefined ? "" : ` (${result.reason})`}`);
          return { transport, ...result };
        }
        question.addDelivery({ transport: transport.id, messageId: result.messageId, chatId: result.chatId });
        return { transport, ok: true };
      }),
    );
    const delivered = results.filter((result) => result.ok).map((result) => result.transport);
    const failed = results.filter((result) => !result.ok);
    return { delivered, failed, anyDelivered: delivered.length > 0, allFailed: delivered.length === 0 };
  }

  /**
   * Закрыть вопрос во всех каналах.
   *
   * Победитель получает человеческую сводку (`summary`), остальные — пометку
   * «Отвечено в другом канале»: текст правится, кнопки снимаются. Ошибка одного
   * канала не мешает закрыть остальные.
   *
   * @param {object} question
   * @param {{winner?: object|null, summary?: string}} [options]
   */
  async function closeAll(question, { winner = null, summary = "" } = {}) {
    for (const delivery of question?.deliveries ?? []) {
      const transport = transportOf(delivery.transport);
      if (transport === null) continue;
      const isWinner = winner !== null && typeof winner.id === "string" && winner.id === delivery.transport;
      try {
        // Без победителя (аборт/недоставка/истечение) закрываем все каналы одной
        // причиной: это не гонка ответов, и пометка «в другом канале» соврёт.
        if (isWinner || winner === null) {
          await transport.closeQuestion?.(question, summary);
          continue;
        }
        // Проигравший: сначала текст пометки, потом снятие кнопок тихой причиной.
        await transport.editQuestion?.(question, ANSWERED_ELSEWHERE_TEXT);
        await transport.closeQuestion?.(question, ANSWERED_ELSEWHERE);
        log(`broker: канал ${delivery.transport} закрыт — ответ пришёл в ${winner?.id ?? "другой канал"}`);
      } catch (error) {
        log(`broker: канал ${delivery.transport} не закрылся (${error?.message ?? error})`);
      }
    }
  }

  return { transports: channels, publish, closeAll, transportOf };
}
