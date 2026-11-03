package dev.dsh.remote.ui

import dev.dsh.remote.FakeRelayTransport
import dev.dsh.remote.InMemorySettingsStore
import dev.dsh.remote.MainDispatcherRule
import dev.dsh.remote.storage.DeviceKeyProvider
import dev.dsh.remote.transport.RelayException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Привязка: валидация ввода, сохранение токена и честные ошибки. */
@OptIn(ExperimentalCoroutinesApi::class)
class PairingViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private val transport = FakeRelayTransport()
    private val settings = InMemorySettingsStore()
    private val deviceKeys = object : DeviceKeyProvider {
        override fun publicKeyBase64(): String = "base64:test-key"
    }

    @Test
    fun `успешная привязка сохраняет токен и адрес`() = runTest(mainDispatcherRule.dispatcher) {
        val viewModel = viewModel()

        viewModel.onRelayUrlChange("relay.example.com/")
        viewModel.onPairCodeChange("123456")
        viewModel.startPairing()
        advanceUntilIdle()

        val stored = settings.snapshot()
        assertEquals("https://relay.example.com", stored.relayUrl)
        assertEquals("device-1", stored.deviceId)
        assertEquals("dt_test_token", stored.deviceToken)
        assertTrue(viewModel.state.value.paired)
        assertFalse(viewModel.state.value.busy)
        assertEquals(listOf("base64:test-key"), transport.registeredPublicKeys)
    }

    @Test
    fun `короткий код не уходит в сеть`() = runTest(mainDispatcherRule.dispatcher) {
        val viewModel = viewModel()
        viewModel.onRelayUrlChange("relay.example.com")
        viewModel.onPairCodeChange("123")

        viewModel.startPairing()
        advanceUntilIdle()

        assertEquals(PairingViewModel.Error.INVALID_CODE, viewModel.state.value.error)
        assertTrue("сеть не трогаем", transport.registeredPublicKeys.isEmpty())
        assertNull(settings.snapshot().deviceToken)
    }

    @Test
    fun `пустой адрес отвергается`() = runTest(mainDispatcherRule.dispatcher) {
        val viewModel = viewModel()
        viewModel.onPairCodeChange("123456")

        viewModel.startPairing()
        advanceUntilIdle()

        assertEquals(PairingViewModel.Error.INVALID_URL, viewModel.state.value.error)
        assertTrue(transport.registeredPublicKeys.isEmpty())
    }

    @Test
    fun `буквы в коде отбрасываются`() = runTest(mainDispatcherRule.dispatcher) {
        val viewModel = viewModel()

        viewModel.onPairCodeChange("12a34b56789")

        assertEquals("123456", viewModel.state.value.pairCode)
    }

    @Test
    fun `сетевая ошибка показывается человеку`() = runTest(mainDispatcherRule.dispatcher) {
        transport.registerError = RelayException(RelayException.Kind.Network, "нет сети")
        val viewModel = viewModel()
        viewModel.onRelayUrlChange("https://relay.example.com")
        viewModel.onPairCodeChange("123456")

        viewModel.startPairing()
        advanceUntilIdle()

        assertEquals(PairingViewModel.Error.NETWORK, viewModel.state.value.error)
        assertNull(settings.snapshot().deviceToken)
    }

    @Test
    fun `просроченный код показывается как недействительный`() = runTest(mainDispatcherRule.dispatcher) {
        transport.pairError = RelayException(RelayException.Kind.NotFound, "код не найден")
        val viewModel = viewModel()
        viewModel.onRelayUrlChange("https://relay.example.com")
        viewModel.onPairCodeChange("123456")

        viewModel.startPairing()
        advanceUntilIdle()

        assertEquals(PairingViewModel.Error.CODE_EXPIRED, viewModel.state.value.error)
    }

    private fun viewModel() = PairingViewModel(
        transport = transport,
        settings = settings,
        deviceKeys = deviceKeys,
        ioDispatcher = mainDispatcherRule.dispatcher,
    )
}
