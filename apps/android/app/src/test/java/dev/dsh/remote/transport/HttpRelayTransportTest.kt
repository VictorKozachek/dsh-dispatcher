package dev.dsh.remote.transport

import dev.dsh.remote.core.BackoffPolicy
import dev.dsh.remote.domain.model.AnswerRequest
import dev.dsh.remote.domain.model.QuestionCursor
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * Транспорт против настоящего HTTP-сервера (MockWebServer): проверяем то, что
 * важнее парсинга, — заголовки протокола, тело строгих запросов и правила ретраев.
 */
class HttpRelayTransportTest {

    private lateinit var server: MockWebServer
    private lateinit var transport: HttpRelayTransport

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        transport = HttpRelayTransport(
            baseUrl = server.url("/").toString(),
            retryPolicy = RetryPolicy(maxAttempts = 3, backoff = BackoffPolicy.deterministic(initialMs = 1, maxMs = 1)),
            sleeper = { },
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `регистрация устройства шлёт версию протокола и строгое тело`() = runBlocking {
        server.enqueue(
            jsonResponse(
                code = 201,
                body = """{"deviceId":"device-1","platform":"android","createdAt":"2026-11-03T18:00:00Z"}""",
            ),
        )

        val device = transport.registerDevice(publicKey = "base64:abc", label = "Android")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/devices", request.path)
        assertEquals("1", request.getHeader(RelayProtocol.VERSION_HEADER))
        assertNull("у /v1/devices нет Bearer", request.getHeader(RelayProtocol.AUTHORIZATION_HEADER))
        val body = request.body.readUtf8()
        assertTrue(body, body.contains("\"platform\":\"android\""))
        assertTrue(body, body.contains("\"publicKey\":\"base64:abc\""))
        assertFalse("null-поля не должны попадать в строгую схему: $body", body.contains("pushToken"))
        assertEquals("device-1", device.deviceId)
    }

    @Test
    fun `привязка по коду возвращает токен устройства`() = runBlocking {
        server.enqueue(
            jsonResponse(
                code = 200,
                body = """{"deviceToken":"dt_0123456789","device":{"deviceId":"device-1","platform":"android","createdAt":"2026-11-03T18:00:00Z"},"confirmedAt":"2026-11-03T18:00:05Z"}""",
            ),
        )

        val response = transport.pair(pairCode = "042817", deviceId = "device-1")

        val request = server.takeRequest()
        assertEquals("/v1/pair", request.path)
        assertNull(request.getHeader(RelayProtocol.AUTHORIZATION_HEADER))
        val body = request.body.readUtf8()
        assertTrue(body, body.contains("\"pairCode\":\"042817\""))
        assertTrue(body, body.contains("\"deviceId\":\"device-1\""))
        assertEquals("dt_0123456789", response.deviceToken)
        assertEquals("device-1", response.device.deviceId)
    }

    @Test
    fun `список вопросов идёт с курсором и ограничением long-poll`() = runBlocking {
        server.enqueue(
            jsonResponse(
                code = 200,
                body = """{"questions":[{"id":"q-1","createdAt":"2026-11-03T18:00:00Z","expiresAt":"2026-11-03T18:30:00Z","body":"Да?","options":[],"serverTags":["new"]}],"nextSince":"2026-11-03T18:00:01Z","nextId":"q-1"}""",
            ),
        )

        val page = transport.listQuestions(
            token = "dt_test",
            cursor = QuestionCursor(since = "2026-11-03T18:00:00Z", sinceId = "q-0"),
            limit = 25,
            waitSeconds = 40,
        )

        val request = server.takeRequest()
        assertEquals("Bearer dt_test", request.getHeader(RelayProtocol.AUTHORIZATION_HEADER))
        val url = requireNotNull(request.requestUrl)
        assertEquals("/v1/questions", url.encodedPath)
        assertEquals("2026-11-03T18:00:00Z", url.queryParameter("since"))
        assertEquals("q-0", url.queryParameter("sinceId"))
        assertEquals("25", url.queryParameter("limit"))
        // wait клампится контрактом: 0..25 секунд.
        assertEquals("25", url.queryParameter("wait"))
        assertEquals(1, page.questions.size)
        assertEquals("q-1", page.questions.single().id)
        assertEquals("2026-11-03T18:00:01Z", page.nextSince)
        assertEquals("q-1", page.nextId)
    }

    @Test
    fun `ответ повторяется на 5xx с тем же ключом идемпотентности`() = runBlocking {
        server.enqueue(
            jsonResponse(
                code = 500,
                body = """{"error":{"code":"internal","message":"boom","retryable":true}}""",
            ),
        )
        server.enqueue(
            jsonResponse(
                code = 201,
                body = """{"questionId":"q-1","selected":["o1"],"answeredAt":"2026-11-03T18:05:00Z","idempotencyKey":"3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718"}""",
            ),
        )

        val answer = transport.submitAnswer(
            token = "dt_test",
            answer = AnswerRequest(
                questionId = "q-1",
                answeredAt = "2026-11-03T18:05:00Z",
                idempotencyKey = "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718",
                selected = listOf("o1"),
            ),
        )

        assertEquals(2, server.requestCount)
        val first = server.takeRequest()
        val second = server.takeRequest()
        assertEquals("Bearer dt_test", second.getHeader(RelayProtocol.AUTHORIZATION_HEADER))
        assertEquals(first.body.readUtf8(), second.body.readUtf8())
        assertEquals("q-1", answer.questionId)
    }

    @Test
    fun `конфликт 409 не повторяется`() = runBlocking {
        server.enqueue(
            jsonResponse(
                code = 409,
                body = """{"error":{"code":"conflict","message":"вопрос уже отвечен","retryable":false}}""",
            ),
        )

        try {
            transport.submitAnswer(
                token = "dt_test",
                answer = AnswerRequest(
                    questionId = "q-1",
                    answeredAt = "2026-11-03T18:05:00Z",
                    idempotencyKey = "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718",
                    selected = listOf("o1"),
                ),
            )
            fail("ожидали RelayException")
        } catch (e: RelayException) {
            assertEquals(RelayException.Kind.Conflict, e.kind)
            assertFalse(e.retryable)
            assertEquals(409, e.httpStatus)
        }
        assertEquals("4xx кроме 429 не повторяем", 1, server.requestCount)
    }

    @Test
    fun `истёкший вопрос маппится в expired`() = runBlocking {
        server.enqueue(
            jsonResponse(
                code = 410,
                body = """{"error":{"code":"expired","message":"вопрос истёк","retryable":false}}""",
            ),
        )

        try {
            transport.submitAnswer(
                token = "dt_test",
                answer = AnswerRequest(
                    questionId = "q-expired",
                    answeredAt = "2026-11-03T18:05:00Z",
                    idempotencyKey = "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60719",
                    selected = listOf("o1"),
                ),
            )
            fail("ожидали RelayException")
        } catch (e: RelayException) {
            assertEquals(RelayException.Kind.Expired, e.kind)
            assertEquals("expired", e.errorCode)
        }
    }

    @Test
    fun `429 отдаёт Retry-After для решения о повторе`() = runBlocking {
        server.enqueue(
            jsonResponse(
                code = 429,
                body = """{"error":{"code":"rate-limited","message":"слишком часто","retryable":true}}""",
            ).addHeader("Retry-After", "3"),
        )
        val singleShot = HttpRelayTransport(
            baseUrl = server.url("/").toString(),
            retryPolicy = RetryPolicy(maxAttempts = 1),
            sleeper = { },
        )

        try {
            singleShot.listQuestions(token = "dt_test")
            fail("ожидали RelayException")
        } catch (e: RelayException) {
            assertEquals(RelayException.Kind.RateLimited, e.kind)
            assertEquals(3L, e.retryAfterSeconds)
            assertTrue(e.retryable)
        }
    }

    @Test
    fun `пауза повтора берётся из Retry-After`() = runBlocking {
        server.enqueue(
            jsonResponse(
                code = 429,
                body = """{"error":{"code":"rate-limited","message":"слишком часто","retryable":true}}""",
            ).addHeader("Retry-After", "3"),
        )
        server.enqueue(
            jsonResponse(
                code = 200,
                body = """{"questions":[],"nextSince":"2026-11-03T18:00:00Z"}""",
            ),
        )

        val pauses = mutableListOf<Long>()
        val retryingTransport = HttpRelayTransport(
            baseUrl = server.url("/").toString(),
            retryPolicy = RetryPolicy(maxAttempts = 2, backoff = BackoffPolicy.deterministic(initialMs = 1, maxMs = 1)),
            sleeper = { pauses += it },
        )

        val page = retryingTransport.listQuestions(token = "dt_test")

        assertTrue("должен быть ровно один повтор", page.questions.isEmpty())
        assertEquals(2, server.requestCount)
        assertEquals(listOf(3_000L), pauses)
    }

    @Test
    fun `401 не повторяется`() = runBlocking {
        server.enqueue(
            jsonResponse(
                code = 401,
                body = """{"error":{"code":"unauthorized","message":"токен просрочен","retryable":false}}""",
            ),
        )

        try {
            transport.listQuestions(token = "dt_broken")
            fail("ожидали RelayException")
        } catch (e: RelayException) {
            assertEquals(RelayException.Kind.Unauthorized, e.kind)
        }
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `heartbeat это POST без тела ответа`() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(204))

        transport.heartbeat("dt_test")

        val request = server.takeRequest()
        assertEquals("POST", request.method)
        assertEquals("/v1/heartbeat", request.path)
        assertEquals("Bearer dt_test", request.getHeader(RelayProtocol.AUTHORIZATION_HEADER))
    }

    @Test
    fun `адрес релея нормализуется`() = runBlocking {
        assertEquals("https://relay.example.com", HttpRelayTransport.normalizeBaseUrl(" relay.example.com/ "))
        assertEquals("http://10.0.2.2:8080", HttpRelayTransport.normalizeBaseUrl("http://10.0.2.2:8080/"))

        try {
            HttpRelayTransport.normalizeBaseUrl("   ")
            fail("пустой адрес должен отвергаться")
        } catch (e: RelayException) {
            assertEquals(RelayException.Kind.Protocol, e.kind)
        }
    }

    private fun jsonResponse(code: Int, body: String): MockResponse = MockResponse()
        .setResponseCode(code)
        .addHeader("Content-Type", "application/json; charset=utf-8")
        .setBody(body)
}
