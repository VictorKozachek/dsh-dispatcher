package dev.dsh.remote.transport

import kotlinx.serialization.json.Json

/** Константы протокола релея v1 — см. `docs/relay/PROTOCOL.md`. */
object RelayProtocol {
    const val VERSION: Int = 1
    const val VERSION_HEADER: String = "X-Relay-Version"
    const val AUTHORIZATION_HEADER: String = "Authorization"

    const val PATH_DEVICES: String = "/v1/devices"
    const val PATH_PAIR: String = "/v1/pair"
    const val PATH_QUESTIONS: String = "/v1/questions"
    const val PATH_ANSWERS: String = "/v1/answers"
    const val PATH_EVENTS: String = "/v1/events"
    const val PATH_HEARTBEAT: String = "/v1/heartbeat"

    const val DEFAULT_PAGE_LIMIT: Int = 50
    const val MAX_LONG_POLL_SECONDS: Int = 25
}

/**
 * JSON протокола: ответы релея аддитивны — незнакомые поля молча игнорируем
 * (COMPATIBILITY §4), а запросы строгие — null-поля с дефолтами не сериализуем,
 * чтобы не получить `400 bad-request` за лишнее поле.
 */
val RelayJson: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = false
    isLenient = false
    coerceInputValues = false
}
