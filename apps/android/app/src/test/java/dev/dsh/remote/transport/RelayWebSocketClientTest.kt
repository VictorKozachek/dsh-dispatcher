package dev.dsh.remote.transport

import dev.dsh.remote.core.BackoffPolicy
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/** WebSocket-поток: события и переподключение после обрыва (§3 контракта). */
class RelayWebSocketClientTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun `событие из WebSocket превращается в RelayEvent`() = runBlocking {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        webSocket.send(
                            """{"type":"question.created","at":"2026-11-03T18:00:00Z","questionId":"q-1"}""",
                        )
                    }
                },
            ),
        )

        val received = withTimeout(10_000) {
            client().events().filterIsInstance<RelayStreamEvent.Received>().first()
        }

        assertEquals("question.created", received.event.type)
        assertEquals("q-1", received.event.questionId)
    }

    @Test
    fun `после обрыва клиент переподключается сам`() = runBlocking {
        val opens = AtomicInteger(0)
        fun listener(): WebSocketListener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val number = opens.incrementAndGet()
                webSocket.send("""{"type":"heartbeat","at":"2026-11-03T18:00:0$number"}""")
                if (number == 1) {
                    // Сервер рвёт соединение: клиент обязан открыть новое.
                    webSocket.close(1001, "server going away")
                }
            }
        }
        server.enqueue(MockResponse().withWebSocketUpgrade(listener()))
        server.enqueue(MockResponse().withWebSocketUpgrade(listener()))

        val events = withTimeout(15_000) {
            client().events().filterIsInstance<RelayStreamEvent.Received>().take(2).toList()
        }

        assertEquals("нужно два события с двух соединений", 2, events.size)
        assertEquals(2, opens.get())
        assertEquals(2, server.requestCount)
        assertEquals("/v1/events", server.takeRequest().path)
    }

    @Test
    fun `без привязки поток честно говорит об отсутствии соединения`() = runBlocking {
        val disconnected = withTimeout(5_000) {
            RelayWebSocketClient(
                baseUrlProvider = { "" },
                tokenProvider = { null },
            ).events().first()
        }

        assertTrue("ожидали Disconnected, получили $disconnected", disconnected is RelayStreamEvent.Disconnected)
    }

    @Test
    fun `битый кадр не рвёт поток`() = runBlocking {
        server.enqueue(
            MockResponse().withWebSocketUpgrade(
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        webSocket.send("не json")
                        webSocket.send("""{"type":"question.expired","questionId":"q-2"}""")
                    }
                },
            ),
        )

        val received = withTimeout(10_000) {
            client().events().filterIsInstance<RelayStreamEvent.Received>().first()
        }

        assertEquals("question.expired", received.event.type)
        assertEquals("q-2", received.event.questionId)
    }

    private fun client(): RelayWebSocketClient = RelayWebSocketClient(
        baseUrlProvider = { server.url("/").toString() },
        tokenProvider = { "dt_test" },
        backoff = BackoffPolicy(initialMs = 20, maxMs = 40, jitterRatio = 0.0),
    )
}
