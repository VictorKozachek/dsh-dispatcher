package dev.dsh.remote.core

import java.util.Base64
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceKeysTest {

    @Test
    fun `публичный ключ в формате контракта`() {
        val material = DeviceKeys.generate()

        assertTrue(
            "ожидали префикс base64:, получили ${material.publicKeyBase64.take(16)}",
            material.publicKeyBase64.startsWith(DeviceKeys.PUBLIC_KEY_PREFIX),
        )
        val der = Base64.getDecoder().decode(material.publicKeyBase64.removePrefix(DeviceKeys.PUBLIC_KEY_PREFIX))
        assertTrue("публичный ключ пустой", der.isNotEmpty())
        assertTrue("приватный ключ пустой", material.privateKeyBase64.isNotBlank())
        assertTrue("неизвестный алгоритм: ${material.algorithm}", material.algorithm in setOf("X25519", "EC-P256"))
    }

    @Test
    fun `каждая регистрация устройства даёт новый ключ`() {
        assertNotEquals(DeviceKeys.generate().publicKeyBase64, DeviceKeys.generate().publicKeyBase64)
    }

    @Test
    fun `метка времени релея разбирается и форматируется обратно`() {
        val instant = java.time.Instant.parse("2026-11-03T18:00:05Z")
        val text = Timestamps.format(instant)
        assertTrue("формат не RFC 3339: $text", text.endsWith("Z"))
        assertTrue(Timestamps.parse(text) == instant)
        assertTrue(Timestamps.parse("не дата") == null)
    }
}
