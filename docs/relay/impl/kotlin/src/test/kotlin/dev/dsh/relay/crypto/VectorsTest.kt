package dev.dsh.relay.crypto

import java.io.File
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Общие векторы e2e: тот же `docs/relay/test-vectors.json`, что читают JS и Swift.
 *
 * Тест проверяет байтовую совместимость: шифрование с заданным nonce должно дать
 * ровно тот конверт, что в векторе, а расшифровка — ровно тот канонический
 * открытый текст.
 */
class VectorsTest {

    private val vectors: JSONObject = JSONObject(
        File("../../test-vectors.json").readText(Charsets.UTF_8),
    )

    private val devicePrivate: String = vectors.getJSONObject("keys").getJSONObject("device").getString("privateKey")
    private val devicePublic: String = vectors.getJSONObject("keys").getJSONObject("device").getString("publicKey")
    private val pluginPrivate: String = vectors.getJSONObject("keys").getJSONObject("plugin").getString("privateKey")
    private val pluginPublic: String = vectors.getJSONObject("keys").getJSONObject("plugin").getString("publicKey")

    @Test
    fun `файл векторов и keyId`() {
        assertEquals(1, vectors.getInt("version"))
        assertEquals(RelayCrypto.CRYPTO_VERSION, vectors.getString("cryptoVersion"))
        assertEquals(vectors.getString("keyId"), RelayCrypto.keyIdFor(devicePublic))
        assertTrue(vectors.getJSONArray("valid").length() >= 5)
        assertTrue(vectors.getJSONArray("invalid").length() >= 4)
    }

    @Test
    fun `валидные векторы совпадают байт в байт`() {
        val valid = vectors.getJSONArray("valid")
        for (index in 0 until valid.length()) {
            val vector = valid.getJSONObject(index)
            val name = vector.getString("name")
            val kind = vector.getString("kind")
            val alg = vector.getString("alg")
            val nonce = Base64.getDecoder().decode(vector.getString("nonce"))
            val plaintext = vector.getString("plaintextCanonical")
            val envelope = vector.getJSONObject("envelope")

            val sealer = if (kind == "question") {
                RelayCrypto.E2e(pluginPrivate, devicePublic, devicePublic, alg)
            } else {
                RelayCrypto.E2e(devicePrivate, pluginPublic, devicePublic, alg)
            }
            val opener = if (kind == "question") {
                RelayCrypto.E2e(devicePrivate, pluginPublic, devicePublic)
            } else {
                RelayCrypto.E2e(pluginPrivate, devicePublic, devicePublic)
            }

            val sealed = if (kind == "question") {
                sealer.sealQuestion(plaintext, questionMeta(vector.getJSONObject("meta")), nonce)
            } else {
                sealer.sealAnswer(plaintext, answerMeta(vector.getJSONObject("meta")), nonce)
            }

            assertEquals("$name: enc", envelope.getString("enc"), sealed.enc)
            assertEquals("$name: nonce", envelope.getString("nonce"), sealed.nonce)
            assertEquals("$name: keyId", envelope.getString("keyId"), sealed.keyId)
            assertEquals("$name: alg", envelope.getString("alg"), sealed.alg)
            assertEquals("$name: plainSize", envelope.getInt("plainSize"), sealed.plainSize)

            val opened = if (kind == "question") {
                opener.openQuestion(sealed, questionMeta(vector.getJSONObject("meta")))
            } else {
                opener.openAnswer(sealed, answerMeta(vector.getJSONObject("meta")))
            }
            assertEquals("$name: расшифровка", plaintext, opened)
        }
    }

    @Test
    fun `невалидные векторы падают с кодом, а не молча`() {
        val invalid = vectors.getJSONArray("invalid")
        for (index in 0 until invalid.length()) {
            val vector = invalid.getJSONObject(index)
            val name = vector.getString("name")
            val kind = vector.getString("kind")
            val envelope = envelope(vector.getJSONObject("envelope"))
            val meta = vector.getJSONObject("meta")
            val expected = vector.getString("error")

            val opener = if (kind == "question") {
                RelayCrypto.E2e(devicePrivate, pluginPublic, devicePublic)
            } else {
                RelayCrypto.E2e(pluginPrivate, devicePublic, devicePublic)
            }

            val error = assertThrows(name, RelayCrypto.CryptoException::class.java) {
                if (kind == "question") {
                    opener.openQuestion(envelope, questionMeta(meta))
                } else {
                    opener.openAnswer(envelope, answerMeta(meta))
                }
            }
            assertEquals("$name: код ошибки", expected, error.code)
        }
    }

    @Test
    fun `round-trip обоих алгоритмов`() {
        for (alg in RelayCrypto.SUPPORTED_ALGS) {
            val plugin = RelayCrypto.E2e(pluginPrivate, devicePublic, devicePublic, alg)
            val device = RelayCrypto.E2e(devicePrivate, pluginPublic, devicePublic, alg)

            val question = plugin.sealQuestion(
                """{"body":"Продолжать?","options":[{"id":"o1","label":"Да"}]}""",
                RelayCrypto.QuestionMeta("q-1", "a1b2c3d4", "2026-11-03T18:00:00Z", "2026-11-03T18:30:00Z"),
            )
            assertEquals(alg, question.alg)
            assertEquals(
                """{"body":"Продолжать?","options":[{"id":"o1","label":"Да"}]}""",
                device.openQuestion(question, RelayCrypto.QuestionMeta("q-1", "a1b2c3d4", "2026-11-03T18:00:00Z", "2026-11-03T18:30:00Z")),
            )

            val answer = device.sealAnswer(
                """{"custom":"ок"}""",
                RelayCrypto.AnswerMeta("q-1", "2026-11-03T18:05:00Z", "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718"),
            )
            assertEquals(
                """{"custom":"ок"}""",
                plugin.openAnswer(answer, RelayCrypto.AnswerMeta("q-1", "2026-11-03T18:05:00Z", "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718")),
            )
        }
    }

    @Test
    fun `ключ устройства — формат и стабильный keyId`() {
        val first = RelayCrypto.generateKeyPair()
        val second = RelayCrypto.generateKeyPair()

        assertEquals(32, Base64.getUrlDecoder().decode(first.privateKey).size)
        assertTrue(first.publicKey.startsWith("base64:"))
        assertEquals(32, Base64.getDecoder().decode(first.publicKey.removePrefix("base64:")).size)
        assertEquals(RelayCrypto.keyIdFor(first.publicKey), RelayCrypto.keyIdFor(first.publicKey))
        assertNotEquals(RelayCrypto.keyIdFor(first.publicKey), RelayCrypto.keyIdFor(second.publicKey))
    }

    @Test
    fun `чужой вопрос не расшифровывается`() {
        val other = RelayCrypto.generateKeyPair()
        val plugin = RelayCrypto.E2e(pluginPrivate, other.publicKey, other.publicKey)
        val device = RelayCrypto.E2e(devicePrivate, pluginPublic, devicePublic)
        val meta = RelayCrypto.QuestionMeta("q-1", "a1b2c3d4", "2026-11-03T18:00:00Z", "2026-11-03T18:30:00Z")

        val envelope = plugin.sealQuestion("""{"body":"Продолжать?"}""", meta)
        val error = assertThrows(RelayCrypto.CryptoException::class.java) {
            device.openQuestion(envelope, meta)
        }
        assertEquals("key-mismatch", error.code)
    }

    private fun questionMeta(json: JSONObject) = RelayCrypto.QuestionMeta(
        id = json.getString("id"),
        shortId = json.getString("shortId"),
        createdAt = json.getString("createdAt"),
        expiresAt = json.getString("expiresAt"),
    )

    private fun answerMeta(json: JSONObject) = RelayCrypto.AnswerMeta(
        questionId = json.getString("questionId"),
        answeredAt = json.getString("answeredAt"),
        idempotencyKey = json.getString("idempotencyKey"),
    )

    private fun envelope(json: JSONObject) = RelayCrypto.Envelope(
        enc = json.optString("enc"),
        nonce = json.optString("nonce"),
        keyId = json.optString("keyId"),
        alg = json.optString("alg"),
        plainSize = json.optInt("plainSize", -1),
    )

    @Suppress("unused")
    private fun arraySize(array: JSONArray): Int = array.length()
}
