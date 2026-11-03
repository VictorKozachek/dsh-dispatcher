package dev.dsh.remote.domain.model

import kotlinx.serialization.Serializable

/**
 * `AnswerRequest` (открытый режим): `selected` — **id вариантов**, не подписи;
 * `custom` — свободный текст. `idempotencyKey` фиксируется при постановке в очередь
 * и переиспользуется на каждом повторе (§4 контракта).
 */
@Serializable
data class AnswerRequest(
    val questionId: String,
    val answeredAt: String,
    val idempotencyKey: String,
    val selected: List<String>,
    val custom: String? = null,
)

@Serializable
data class Answer(
    val questionId: String,
    val answeredAt: String? = null,
    val idempotencyKey: String? = null,
    val selected: List<String>,
    val custom: String? = null,
)

/** Тело ошибки релея (§5 контракта): незнакомый `code` трактуем как `internal`. */
@Serializable
data class RelayErrorBody(
    val error: RelayError,
)

@Serializable
data class RelayError(
    val code: String,
    val message: String,
    val retryable: Boolean = false,
    val details: kotlinx.serialization.json.JsonElement? = null,
)
