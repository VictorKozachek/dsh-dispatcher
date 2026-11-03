package dev.dsh.remote.domain

import kotlinx.coroutines.flow.Flow

/**
 * Настройки приложения: адрес релея, привязка и курсор пагинации.
 * Токен устройства — секрет, поэтому реальная реализация хранит его
 * в `EncryptedSharedPreferences` (ключ в Android Keystore), а не в открытом файле.
 */
data class RelaySettings(
    val relayUrl: String = "",
    val deviceId: String? = null,
    val deviceToken: String? = null,
    val cursorSince: String? = null,
    val cursorSinceId: String? = null,
) {
    val isPaired: Boolean get() = relayUrl.isNotBlank() && !deviceToken.isNullOrBlank()
}

interface SettingsStore {
    /** Синхронный снимок — для провайдеров адреса/токена в транспорте. */
    fun snapshot(): RelaySettings

    fun observe(): Flow<RelaySettings>

    suspend fun write(settings: RelaySettings)
}
