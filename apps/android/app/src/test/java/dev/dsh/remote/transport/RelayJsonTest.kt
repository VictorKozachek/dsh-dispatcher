package dev.dsh.remote.transport

import dev.dsh.remote.domain.model.AnswerRequest
import dev.dsh.remote.domain.model.DeviceCreateRequest
import dev.dsh.remote.domain.model.Question
import dev.dsh.remote.domain.model.RelayErrorBody
import dev.dsh.remote.domain.model.RelayEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Сериализация протокола: строгие запросы и аддитивные ответы (§1, §4 контракта). */
class RelayJsonTest {

    @Test
    fun `незнакомые поля ответа игнорируются`() {
        val json = """
            {"id":"q-1","shortId":"a1b2c3d4","createdAt":"2026-11-03T18:00:00Z",
             "expiresAt":"2026-11-03T18:30:00Z","body":"Да?","options":[],
             "serverTags":["new-in-minor"],"nextVersionHint":2}
        """.trimIndent()

        val question = RelayJson.decodeFromString(Question.serializer(), json)

        assertEquals("q-1", question.id)
        assertEquals("a1b2c3d4", question.shortId)
    }

    @Test
    fun `строгий запрос регистрации не содержит null-полей`() {
        val text = RelayJson.encodeToString(
            DeviceCreateRequest.serializer(),
            DeviceCreateRequest(platform = "android", publicKey = "base64:abc"),
        )

        assertEquals("""{"platform":"android","publicKey":"base64:abc"}""", text)
    }

    @Test
    fun `selected уходит даже пустым массивом`() {
        // Открытый режим answer требует поле selected, поэтому у него нет default:
        // ответ «только текстом» всё равно обязан послать selected: [].
        val text = RelayJson.encodeToString(
            AnswerRequest.serializer(),
            AnswerRequest(
                questionId = "q-1",
                answeredAt = "2026-11-03T18:05:00Z",
                idempotencyKey = "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718",
                selected = emptyList(),
                custom = "свой ответ",
            ),
        )

        assertTrue(text, text.contains("\"selected\":[]"))
        assertTrue(text, text.contains("\"custom\":\"свой ответ\""))
        assertFalse("version необязателен и не шлётся", text.contains("\"version\""))
    }

    @Test
    fun `null custom не сериализуется`() {
        val text = RelayJson.encodeToString(
            AnswerRequest.serializer(),
            AnswerRequest(
                questionId = "q-1",
                answeredAt = "2026-11-03T18:05:00Z",
                idempotencyKey = "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718",
                selected = listOf("o1"),
            ),
        )

        assertFalse(text, text.contains("custom"))
    }

    @Test
    fun `незнакомый код ошибки разбирается без падения`() {
        val body = RelayJson.decodeFromString(
            RelayErrorBody.serializer(),
            """{"error":{"code":"future-code","message":"что-то новое"}}""",
        )

        assertEquals("future-code", body.error.code)
        assertFalse(body.error.retryable)
        assertNull(body.error.details)
    }

    @Test
    fun `незнакомый тип события разбирается и остаётся неизвестным`() {
        val event = RelayJson.decodeFromString(
            RelayEvent.serializer(),
            """{"type":"future.event","at":"2026-11-03T18:00:00Z","payload":{"x":1}}""",
        )

        assertEquals("future.event", event.type)
        assertFalse(event.isKnown())
    }

    @Test
    fun `известные типы событий распознаются`() {
        val event = RelayJson.decodeFromString(
            RelayEvent.serializer(),
            """{"type":"question.answered","at":"2026-11-03T18:00:00Z","questionId":"q-1"}""",
        )

        assertTrue(event.isKnown())
        assertEquals("q-1", event.questionId)
    }
}
