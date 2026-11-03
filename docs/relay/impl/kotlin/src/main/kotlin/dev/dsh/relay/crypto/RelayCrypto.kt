package dev.dsh.relay.crypto

import java.io.ByteArrayOutputStream
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * E2E-шифрование тела вопроса — эталонная реализация на Kotlin/JVM.
 *
 * Повторяет `dsh-remote/lib/crypto.js` (задача 021) и проверяется теми же векторами
 * из `docs/relay/test-vectors.json`. Клиенты (Android 019 / iOS 020) переносят этот
 * код в `apps/`, меняя только хранение ключа (Android Keystore).
 *
 * Схема описана в `docs/relay/CRYPTO.md`:
 *   S  = X25519(own_private, peer_public)
 *   Kq = HKDF-SHA256(S, salt = "dsh-relay-e2e-v1", info = "question|" + keyId)
 *   Ka = HKDF-SHA256(S, salt = "dsh-relay-e2e-v1", info = "answer|"   + keyId)
 *
 * Шифрование — ChaCha20-Poly1305 (на проводе `xchacha20poly1305`, nonce 12 байт по
 * контракту) или AES-256-GCM; открытие выбирает алгоритм из конверта.
 */
object RelayCrypto {

    const val CRYPTO_VERSION = "dsh-relay-e2e-v1"
    const val ALG_CHACHA20_POLY1305 = "xchacha20poly1305"
    const val ALG_AES_256_GCM = "aes256gcm"
    const val DEFAULT_ALG = ALG_CHACHA20_POLY1305
    val SUPPORTED_ALGS = listOf(ALG_CHACHA20_POLY1305, ALG_AES_256_GCM)

    const val PUBLIC_KEY_PREFIX = "base64:"
    const val KEY_ID_PREFIX = "dpk-"

    const val NONCE_BYTES = 12
    const val TAG_BYTES = 16
    const val MAX_PLAIN_BYTES = 48 * 1024
    const val MAX_ENC_CHARS = 64 * 1024

    private val PKCS8_X25519_PREFIX = hex("302e020100300506032b656e04220420")
    private val SPKI_X25519_PREFIX = hex("302a300506032b656e032100")

    /** Ошибка криптослоя: `code` совпадает с кодами JS-реализации. */
    class CryptoException(val code: String, message: String) : Exception(message)

    data class KeyPair(val privateKey: String, val publicKey: String)

    data class Envelope(
        val enc: String,
        val nonce: String,
        val keyId: String,
        val alg: String,
        val plainSize: Int,
    )

    data class QuestionMeta(
        val id: String,
        val shortId: String,
        val createdAt: String,
        val expiresAt: String,
    )

    data class AnswerMeta(
        val questionId: String,
        val answeredAt: String,
        val idempotencyKey: String,
    )

    /** Сгенерировать пару ключей: приватный — base64url, публичный — формат провода. */
    fun generateKeyPair(): KeyPair {
        val generator = KeyPairGenerator.getInstance("X25519")
        val pair = generator.generateKeyPair()
        val privateRaw = stripPrefix(pair.private.encoded, PKCS8_X25519_PREFIX)
        val publicRaw = stripPrefix(pair.public.encoded, SPKI_X25519_PREFIX)
        return KeyPair(
            privateKey = Base64.getUrlEncoder().withoutPadding().encodeToString(privateRaw),
            publicKey = PUBLIC_KEY_PREFIX + Base64.getEncoder().encodeToString(publicRaw),
        )
    }

    /** `keyId` — отпечаток публичного ключа устройства (одинаков на обеих сторонах). */
    fun keyIdFor(publicKey: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(rawPublicKey(publicKey))
        val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(digest)
        return KEY_ID_PREFIX + encoded.take(16)
    }

    /** AAD вопроса: связывает конверт с id/shortId/таймстампами. */
    fun questionAad(meta: QuestionMeta, keyId: String, alg: String): String =
        "$CRYPTO_VERSION|question|${meta.id}|${meta.shortId}|${meta.createdAt}|${meta.expiresAt}|$keyId|$alg"

    /** AAD ответа: вопрос, время ответа и ключ идемпотентности. */
    fun answerAad(meta: AnswerMeta, keyId: String, alg: String): String =
        "$CRYPTO_VERSION|answer|${meta.questionId}|${meta.answeredAt}|${meta.idempotencyKey}|$keyId|$alg"

    /** Криптослой одной пары «плагин ↔ устройство». */
    class E2e(
        privateKey: String,
        peerPublicKey: String,
        devicePublicKey: String = peerPublicKey,
        val alg: String = DEFAULT_ALG,
        keyIdOverride: String? = null,
    ) {
        val keyId: String

        private val questionKey: ByteArray
        private val answerKey: ByteArray

        init {
            requireAlg(alg)
            val shared = sharedSecret(privateKey, peerPublicKey)
            keyId = if (!keyIdOverride.isNullOrEmpty()) keyIdOverride else keyIdFor(devicePublicKey)
            questionKey = hkdfSha256(shared, CRYPTO_VERSION.toByteArray(), "question|$keyId".toByteArray())
            answerKey = hkdfSha256(shared, CRYPTO_VERSION.toByteArray(), "answer|$keyId".toByteArray())
        }

        fun sealQuestion(plaintext: String, meta: QuestionMeta, nonce: ByteArray? = null): Envelope {
            validatePlaintext(plaintext, kind = "question")
            val nonceBytes = nonce ?: randomNonce()
            val aad = questionAad(meta, keyId, alg)
            return seal(alg, questionKey, nonceBytes, aad, plaintext)
        }

        fun openQuestion(envelope: Envelope, meta: QuestionMeta): String {
            val parsed = validateEnvelope(envelope)
            requireKeyId(parsed)
            val aad = questionAad(meta, parsed.keyId, parsed.alg)
            return open(parsed, questionKey, aad)
        }

        fun sealAnswer(plaintext: String, meta: AnswerMeta, nonce: ByteArray? = null): Envelope {
            validatePlaintext(plaintext, kind = "answer")
            val nonceBytes = nonce ?: randomNonce()
            val aad = answerAad(meta, keyId, alg)
            return seal(alg, answerKey, nonceBytes, aad, plaintext)
        }

        fun openAnswer(envelope: Envelope, meta: AnswerMeta): String {
            val parsed = validateEnvelope(envelope)
            requireKeyId(parsed)
            val aad = answerAad(meta, parsed.keyId, parsed.alg)
            return open(parsed, answerKey, aad)
        }

        private fun requireKeyId(parsed: Envelope) {
            if (parsed.keyId != keyId) {
                throw CryptoException(
                    "key-mismatch",
                    "конверт зашифрован для другого ключа: ${parsed.keyId} ≠ $keyId",
                )
            }
        }

        private fun seal(alg: String, key: ByteArray, nonce: ByteArray, aad: String, plaintext: String): Envelope {
            val plainBytes = plaintext.toByteArray(Charsets.UTF_8)
            if (plainBytes.size > MAX_PLAIN_BYTES) {
                throw CryptoException("payload-too-large", "открытый текст больше $MAX_PLAIN_BYTES байт")
            }
            val sealed = aeadEncrypt(alg, key, nonce, aad.toByteArray(Charsets.UTF_8), plainBytes)
            return Envelope(
                enc = Base64.getEncoder().encodeToString(sealed),
                nonce = Base64.getEncoder().encodeToString(nonce),
                keyId = keyId,
                alg = alg,
                plainSize = plainBytes.size,
            )
        }

        private fun open(parsed: Envelope, key: ByteArray, aad: String): String {
            val plainBytes = aeadDecrypt(parsed, key, aad.toByteArray(Charsets.UTF_8))
            if (plainBytes.size != parsed.plainSize) {
                throw CryptoException(
                    "bad-envelope",
                    "plainSize не совпал с расшифрованным телом: ${plainBytes.size} ≠ ${parsed.plainSize}",
                )
            }
            return String(plainBytes, Charsets.UTF_8)
        }
    }

    /** Проверка конверта по контракту 016/023 — до расшифровки. */
    fun validateEnvelope(envelope: Envelope): Envelope {
        requireAlg(envelope.alg)
        if (envelope.keyId.length !in 4..64) {
            throw CryptoException("bad-envelope", "keyId: ожидалось 4..64 символа")
        }
        val nonce = decodeBase64(envelope.nonce)
        if (nonce.size != NONCE_BYTES) {
            throw CryptoException("bad-envelope", "nonce: ровно $NONCE_BYTES байт (${nonce.size})")
        }
        if (envelope.enc.length > MAX_ENC_CHARS) {
            throw CryptoException("payload-too-large", "enc: не больше $MAX_ENC_CHARS символов base64")
        }
        val enc = decodeBase64(envelope.enc)
        if (enc.size < TAG_BYTES + 1) {
            throw CryptoException("bad-envelope", "enc: пустой конверт")
        }
        if (envelope.plainSize < 0 || envelope.plainSize > MAX_PLAIN_BYTES) {
            throw CryptoException("bad-envelope", "plainSize: ожидалось 0..$MAX_PLAIN_BYTES")
        }
        return envelope
    }

    private fun validatePlaintext(plaintext: String, kind: String) {
        val bytes = plaintext.toByteArray(Charsets.UTF_8)
        if (bytes.size > MAX_PLAIN_BYTES) {
            throw CryptoException("payload-too-large", "открытый текст больше $MAX_PLAIN_BYTES байт")
        }
        val json = try {
            org.json.JSONObject(plaintext)
        } catch (error: org.json.JSONException) {
            throw CryptoException("bad-plaintext", "открытый текст должен быть JSON-объектом")
        }
        if (kind == "question") {
            val body = json.optString("body", "")
            if (body.isBlank()) {
                throw CryptoException("bad-plaintext", "тело вопроса: нужен непустой body")
            }
        } else {
            val selected = json.optJSONArray("selected")
            val custom = json.optString("custom", "")
            if ((selected == null || selected.length() == 0) && custom.isBlank()) {
                throw CryptoException("bad-plaintext", "тело ответа: нужен выбранный вариант или текст")
            }
        }
    }

    private fun requireAlg(alg: String) {
        if (alg !in SUPPORTED_ALGS) {
            throw CryptoException("unsupported-alg", "alg: поддерживаются $SUPPORTED_ALGS, получено $alg")
        }
    }

    private fun rawPublicKey(publicKey: String): ByteArray {
        val text = publicKey.removePrefix(PUBLIC_KEY_PREFIX)
        if (text.isEmpty()) throw CryptoException("bad-key", "пустой публичный ключ устройства")
        val raw = decodeBase64(text)
        if (raw.size != 32) {
            throw CryptoException("bad-key", "публичный ключ X25519 должен быть 32 байта, а не ${raw.size}")
        }
        return raw
    }

    private fun sharedSecret(privateKeyBase64Url: String, peerPublicKey: String): ByteArray {
        val raw = try {
            Base64.getUrlDecoder().decode(privateKeyBase64Url)
        } catch (error: IllegalArgumentException) {
            throw CryptoException("bad-key", "приватный ключ должен быть base64url")
        }
        if (raw.size != 32) {
            throw CryptoException("bad-key", "приватный ключ X25519 должен быть 32 байта, а не ${raw.size}")
        }
        val keyFactory = KeyFactory.getInstance("X25519")
        val privateKey: PrivateKey = keyFactory.generatePrivate(
            PKCS8EncodedKeySpec(PKCS8_X25519_PREFIX + raw),
        )
        val publicKey: PublicKey = keyFactory.generatePublic(
            X509EncodedKeySpec(SPKI_X25519_PREFIX + rawPublicKey(peerPublicKey)),
        )
        val agreement = KeyAgreement.getInstance("X25519")
        agreement.init(privateKey)
        agreement.doPhase(publicKey, true)
        return agreement.generateSecret()
    }

    private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int = 32): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(if (salt.isEmpty()) ByteArray(32) else salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val output = ByteArrayOutputStream()
        var block = ByteArray(0)
        var counter: Byte = 1
        while (output.size() < length) {
            mac.update(block)
            mac.update(info)
            mac.update(counter)
            block = mac.doFinal()
            output.write(block)
            counter = (counter + 1).toByte()
        }
        return output.toByteArray().copyOf(length)
    }

    private fun aeadEncrypt(alg: String, key: ByteArray, nonce: ByteArray, aad: ByteArray, plain: ByteArray): ByteArray {
        val cipher = cipherFor(alg)
        cipher.init(
            Cipher.ENCRYPT_MODE,
            secretKeyFor(alg, key),
            if (alg == ALG_AES_256_GCM) GCMParameterSpec(TAG_BITS, nonce) else IvParameterSpec(nonce),
        )
        cipher.updateAAD(aad)
        return cipher.doFinal(plain)
    }

    private fun aeadDecrypt(envelope: Envelope, key: ByteArray, aad: ByteArray): ByteArray {
        val sealed = decodeBase64(envelope.enc)
        if (sealed.size < TAG_BYTES + 1) {
            throw CryptoException("decrypt-failed", "конверт короче тега аутентификации")
        }
        val cipher = cipherFor(envelope.alg)
        cipher.init(
            Cipher.DECRYPT_MODE,
            secretKeyFor(envelope.alg, key),
            if (envelope.alg == ALG_AES_256_GCM) {
                GCMParameterSpec(TAG_BITS, decodeBase64(envelope.nonce))
            } else {
                IvParameterSpec(decodeBase64(envelope.nonce))
            },
        )
        cipher.updateAAD(aad)
        return try {
            cipher.doFinal(sealed)
        } catch (error: Exception) {
            throw CryptoException(
                "decrypt-failed",
                "конверт повреждён или подменён: тег не сошёлся (AAD и nonce проверены)",
            )
        }
    }

    private fun cipherFor(alg: String): Cipher =
        Cipher.getInstance(if (alg == ALG_AES_256_GCM) "AES/GCM/NoPadding" else "ChaCha20-Poly1305")

    private fun secretKeyFor(alg: String, key: ByteArray): SecretKeySpec =
        SecretKeySpec(key, if (alg == ALG_AES_256_GCM) "AES" else "ChaCha20")

    private fun randomNonce(): ByteArray {
        val nonce = ByteArray(NONCE_BYTES)
        java.security.SecureRandom().nextBytes(nonce)
        return nonce
    }

    private fun decodeBase64(text: String): ByteArray = try {
        Base64.getDecoder().decode(text)
    } catch (error: IllegalArgumentException) {
        throw CryptoException("bad-envelope", "base64 не декодируется")
    }

    private fun stripPrefix(encoded: ByteArray, prefix: ByteArray): ByteArray {
        require(encoded.size >= prefix.size) { "неожиданный формат ключа" }
        return encoded.copyOfRange(prefix.size, encoded.size)
    }

    private fun hex(value: String): ByteArray {
        val bytes = ByteArray(value.length / 2)
        for (index in bytes.indices) {
            bytes[index] = value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
        return bytes
    }

    private const val TAG_BITS = 128
}
