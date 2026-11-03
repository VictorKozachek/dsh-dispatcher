package dev.dsh.remote.domain.model

import kotlinx.serialization.Serializable

/**
 * `DeviceCreateRequest`: строгий запрос (`additionalProperties: false`), поэтому в теле
 * ровно эти поля. `version` не отправляем — в схеме он необязателен, а версия протокола
 * едет обязательным заголовком `X-Relay-Version`.
 */
@Serializable
data class DeviceCreateRequest(
    val platform: String,
    val publicKey: String,
    val label: String? = null,
) {
    companion object {
        const val PLATFORM_ANDROID = "android"
    }
}

@Serializable
data class Device(
    val deviceId: String,
    val platform: String,
    val createdAt: String,
    val pushToken: String? = null,
    val label: String? = null,
)

/**
 * `PairRequest`: подтверждение привязки по одноразовому коду из плагина (TTL 10 минут).
 * Тело строгое — лишнее поле релей отвергает `400 bad-request`.
 */
@Serializable
data class PairRequest(
    val pairCode: String,
    val deviceId: String,
)

@Serializable
data class PairResponse(
    val deviceToken: String,
    val device: Device,
    val confirmedAt: String? = null,
)
