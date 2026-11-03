package dev.dsh.remote.domain.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * Событие потока `GET /v1/events` (WebSocket). `type` — открытый набор: незнакомый тип
 * клиент игнорирует (COMPATIBILITY §4), поэтому разбор не падает на новых событиях.
 */
@Serializable
data class RelayEvent(
    val type: String,
    val at: String? = null,
    val questionId: String? = null,
    val payload: JsonElement? = null,
) {
    companion object {
        const val QUESTION_CREATED = "question.created"
        const val QUESTION_ANSWERED = "question.answered"
        const val QUESTION_EXPIRED = "question.expired"
        const val PAIRING_CONFIRMED = "pairing.confirmed"
        const val DEVICE_REVOKED = "device.revoked"
        const val HEARTBEAT = "heartbeat"
    }
}
