package dev.dsh.remote.domain

import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable

/** Жизненный цикл ответа в оффлайн-очереди. */
@Serializable
enum class OutboxState {
    /** Лежит на устройстве и ещё не подтверждена релеем. */
    PENDING,

    /** Релей подтвердил (201 или 200 при повторе с тем же ключом). */
    SENT,

    /** Ответ не будет отправлен: 409/410/400 — постоянная ошибка. */
    REJECTED,
}

/**
 * Ответ в оффлайн-очереди. `idempotencyKey` создаётся один раз при постановке в
 * очередь, поэтому повтор после падения сети или рестарта приложения не создаёт
 * второй ответ (§4 контракта: идемпотентность по ключу).
 */
@Serializable
data class OutboxEntry(
    val idempotencyKey: String,
    val questionId: String,
    val questionTitle: String? = null,
    val questionShortId: String? = null,
    val workspace: String? = null,
    val selected: List<String> = emptyList(),
    val custom: String? = null,
    val answeredAt: String,
    val state: OutboxState = OutboxState.PENDING,
    val attempts: Int = 0,
    val lastError: String? = null,
) {
    /** Тело запроса по контракту: только поля схемы `AnswerRequest`. */
    fun toAnswerRequest(): dev.dsh.remote.domain.model.AnswerRequest =
        dev.dsh.remote.domain.model.AnswerRequest(
            questionId = questionId,
            answeredAt = answeredAt,
            idempotencyKey = idempotencyKey,
            selected = selected,
            custom = custom,
        )
}

/**
 * Очередь ответов на устройстве. Ответ пишется сюда **до** сетевого вызова:
 * иначе оффлайн-ответ человека терялся бы, а это главный сценарий задачи.
 */
interface AnswerStore {
    fun observe(): Flow<List<OutboxEntry>>

    suspend fun entries(): List<OutboxEntry>

    suspend fun pending(): List<OutboxEntry>

    suspend fun put(entry: OutboxEntry)

    suspend fun update(entry: OutboxEntry)
}
