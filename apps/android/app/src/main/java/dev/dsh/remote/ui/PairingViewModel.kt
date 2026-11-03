package dev.dsh.remote.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.dsh.remote.domain.RelaySettings
import dev.dsh.remote.domain.SettingsStore
import dev.dsh.remote.storage.DeviceKeyProvider
import dev.dsh.remote.transport.HttpRelayTransport
import dev.dsh.remote.transport.RelayException
import dev.dsh.remote.transport.RelayTransport
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Привязка: адрес релея + одноразовый код из плагина (`POST /v1/pairing`), затем
 * регистрация устройства (`POST /v1/devices`) и подтверждение (`POST /v1/pair`).
 *
 * Токен сохраняется в `EncryptedSharedPreferences`; наружу он не выходит.
 */
class PairingViewModel(
    private val transport: RelayTransport,
    private val settings: SettingsStore,
    private val deviceKeys: DeviceKeyProvider,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : ViewModel() {

    enum class Error {
        INVALID_URL,
        INVALID_CODE,
        NETWORK,
        CODE_EXPIRED,
        CODE_USED,
        UNKNOWN,
    }

    data class State(
        val relayUrl: String = "",
        val pairCode: String = "",
        val busy: Boolean = false,
        val error: Error? = null,
        val paired: Boolean = false,
    )

    private val _state = MutableStateFlow(State(relayUrl = settings.snapshot().relayUrl))
    val state: StateFlow<State> = _state.asStateFlow()

    fun onRelayUrlChange(value: String) {
        _state.value = _state.value.copy(relayUrl = value, error = null)
    }

    /** Код — ровно 6 цифр (§3: `pairCode` живёт 10 минут и одноразовый). */
    fun onPairCodeChange(value: String) {
        _state.value = _state.value.copy(pairCode = value.filter(Char::isDigit).take(PAIR_CODE_LENGTH), error = null)
    }

    fun startPairing() {
        val current = _state.value
        if (current.busy) return

        val normalizedUrl = runCatching { HttpRelayTransport.normalizeBaseUrl(current.relayUrl) }.getOrNull()
        if (normalizedUrl == null) {
            _state.value = current.copy(error = Error.INVALID_URL)
            return
        }
        if (current.pairCode.length != PAIR_CODE_LENGTH) {
            _state.value = current.copy(error = Error.INVALID_CODE)
            return
        }

        _state.value = current.copy(busy = true, error = null)
        viewModelScope.launch(ioDispatcher) {
            try {
                val publicKey = deviceKeys.publicKeyBase64()
                val device = transport.registerDevice(publicKey = publicKey, label = DEVICE_LABEL)
                val paired = transport.pair(pairCode = current.pairCode, deviceId = device.deviceId)
                val stored = RelaySettings(
                    relayUrl = normalizedUrl,
                    deviceId = device.deviceId,
                    deviceToken = paired.deviceToken,
                )
                settings.write(stored)
                _state.value = _state.value.copy(busy = false, paired = true)
            } catch (e: RelayException) {
                _state.value = _state.value.copy(busy = false, error = e.toPairingError())
            } catch (e: Exception) {
                _state.value = _state.value.copy(busy = false, error = Error.UNKNOWN)
            }
        }
    }

    private fun RelayException.toPairingError(): Error = when (kind) {
        RelayException.Kind.Network,
        RelayException.Kind.Server,
        RelayException.Kind.RateLimited,
        -> Error.NETWORK

        RelayException.Kind.NotFound,
        RelayException.Kind.Expired,
        RelayException.Kind.UnsupportedVersion,
        -> Error.CODE_EXPIRED

        RelayException.Kind.Conflict,
        RelayException.Kind.Forbidden,
        -> Error.CODE_USED

        else -> Error.UNKNOWN
    }

    companion object {
        const val PAIR_CODE_LENGTH = 6
        const val DEVICE_LABEL = "Android"
    }
}
