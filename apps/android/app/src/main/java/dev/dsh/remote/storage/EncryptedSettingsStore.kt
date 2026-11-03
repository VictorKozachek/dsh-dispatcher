package dev.dsh.remote.storage

import android.content.Context
import dev.dsh.remote.domain.RelaySettings
import dev.dsh.remote.domain.SettingsStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.onStart
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Настройки в [KeystoreSecretStore]: мастер-ключ в Android Keystore, поэтому
 * `deviceToken` не лежит в открытом виде (критерий «сохранение токена»).
 *
 * Загрузка ленивая: чтение Keystore делает дисковый I/O, его нельзя звать в
 * конструкторе `Application` на главном потоке.
 */
class EncryptedSettingsStore(context: Context) : SettingsStore {

    private val secrets = KeystoreSecretStore(context, FILE_NAME)
    private val loaded = AtomicBoolean(false)
    private val state = MutableStateFlow(RelaySettings())

    override fun snapshot(): RelaySettings {
        ensureLoaded()
        return state.value
    }

    override fun observe(): Flow<RelaySettings> = state.asStateFlow().onStart { ensureLoaded() }

    override suspend fun write(settings: RelaySettings) {
        ensureLoaded()
        secrets.write(KEY_RELAY_URL, settings.relayUrl)
        secrets.write(KEY_DEVICE_ID, settings.deviceId)
        secrets.write(KEY_DEVICE_TOKEN, settings.deviceToken)
        secrets.write(KEY_CURSOR_SINCE, settings.cursorSince)
        secrets.write(KEY_CURSOR_SINCE_ID, settings.cursorSinceId)
        state.value = settings
    }

    private fun ensureLoaded() {
        if (!loaded.compareAndSet(false, true)) return
        state.value = RelaySettings(
            relayUrl = secrets.read(KEY_RELAY_URL).orEmpty(),
            deviceId = secrets.read(KEY_DEVICE_ID),
            deviceToken = secrets.read(KEY_DEVICE_TOKEN),
            cursorSince = secrets.read(KEY_CURSOR_SINCE),
            cursorSinceId = secrets.read(KEY_CURSOR_SINCE_ID),
        )
    }

    private companion object {
        const val FILE_NAME = "relay_settings"
        const val KEY_RELAY_URL = "relay_url"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_DEVICE_TOKEN = "device_token"
        const val KEY_CURSOR_SINCE = "cursor_since"
        const val KEY_CURSOR_SINCE_ID = "cursor_since_id"
    }
}
