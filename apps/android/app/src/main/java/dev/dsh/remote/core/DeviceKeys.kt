package dev.dsh.remote.core

import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * Ключи устройства для e2e (задача 021). MVP отправляет релею публичный ключ при
 * регистрации устройства (`DeviceCreateRequest.publicKey`), приватный ключ
 * остаётся на устройстве в зашифрованных настройках и пока не используется:
 * шифрование тела вопроса — отдельная задача 021.
 *
 * Алгоритм выбирается по возможностям платформы: X25519 есть в JDK/Android 33+,
 * иначе EC P-256 — это осознанное ограничение MVP, зафиксированное в README.
 */
object DeviceKeys {

    data class Material(
        val publicKeyBase64: String,
        val privateKeyBase64: String,
        val algorithm: String,
    )

    fun generate(): Material {
        val encoder = Base64.getEncoder()
        val x25519 = runCatching {
            val generator = KeyPairGenerator.getInstance("X25519")
            val pair = generator.generateKeyPair()
            Material(
                publicKeyBase64 = PUBLIC_KEY_PREFIX + encoder.encodeToString(pair.public.encoded),
                privateKeyBase64 = encoder.encodeToString(pair.private.encoded),
                algorithm = "X25519",
            )
        }.getOrNull()
        if (x25519 != null) return x25519

        val generator = KeyPairGenerator.getInstance("EC")
        generator.initialize(ECGenParameterSpec("secp256r1"))
        val pair = generator.generateKeyPair()
        return Material(
            publicKeyBase64 = PUBLIC_KEY_PREFIX + encoder.encodeToString(pair.public.encoded),
            privateKeyBase64 = encoder.encodeToString(pair.private.encoded),
            algorithm = "EC-P256",
        )
    }

    /** Префикс из примеров контракта: `base64:<…>` (см. `docs/relay/examples/device-create.request.json`). */
    const val PUBLIC_KEY_PREFIX = "base64:"
}
