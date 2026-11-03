package dev.dsh.remote.transport

import dev.dsh.remote.core.BackoffPolicy
import dev.dsh.remote.domain.model.RelayEvent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.isActive
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Поток `GET /v1/events` (WebSocket) с переподключением.
 *
 * Контракт §3: ping-кадр каждые 25 с (его шлёт OkHttp, настроенный в
 * [HttpRelayTransport.defaultWebSocketClient]), при обрыве — переподключение с
 * экспоненциальной паузой 1 с → 30 с и jitter ([BackoffPolicy]). Тип события —
 * открытый набор: незнакомый тип пропускаем, соединение не рвём.
 *
 * Состояние соединения — часть потока (`Connected`/`Disconnected`), поэтому UI
 * показывает индикатор, не заводя второй канал правды.
 */
class RelayWebSocketClient(
    private val baseUrlProvider: () -> String,
    private val tokenProvider: () -> String?,
    private val client: OkHttpClient = HttpRelayTransport.defaultWebSocketClient(),
    private val json: Json = RelayJson,
    private val backoff: BackoffPolicy = BackoffPolicy(),
    private val sleeper: suspend (Long) -> Unit = { delay(it) },
) {

    fun events(): Flow<RelayStreamEvent> = channelFlow {
        var attempt = 0
        while (isActive) {
            val token = tokenProvider()
            val base = runCatching { HttpRelayTransport.normalizeBaseUrl(baseUrlProvider()) }.getOrNull()
            if (base == null || token.isNullOrBlank()) {
                send(RelayStreamEvent.Disconnected("нет привязки к релею"))
                return@channelFlow
            }

            val url = (base + RelayProtocol.PATH_EVENTS).toHttpUrlOrNull()
            if (url == null) {
                send(RelayStreamEvent.Disconnected("некорректный адрес релея"))
                return@channelFlow
            }

            val request = Request.Builder()
                .url(url)
                .header(RelayProtocol.VERSION_HEADER, RelayProtocol.VERSION.toString())
                .header(RelayProtocol.AUTHORIZATION_HEADER, "Bearer $token")
                .build()

            val closeSignal = CompletableDeferred<String?>()
            val opened = AtomicBoolean(false)
            val listener = EventListener(this, json, closeSignal) { opened.set(true) }
            val socket = client.newWebSocket(request, listener)

            val reason = closeSignal.await()
            socket.cancel()
            if (!isActive) break

            send(RelayStreamEvent.Disconnected(reason))
            attempt = if (opened.get()) 1 else attempt + 1
            val pause = backoff.delayForAttempt(attempt)
            sleeper(pause)
        }
    }

    private class EventListener(
        private val producer: ProducerScope<RelayStreamEvent>,
        private val json: Json,
        private val closeSignal: CompletableDeferred<String?>,
        private val onOpened: () -> Unit,
    ) : WebSocketListener() {

        override fun onOpen(webSocket: WebSocket, response: Response) {
            onOpened()
            producer.trySend(RelayStreamEvent.Connected)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            val event = runCatching { json.decodeFromString(RelayEvent.serializer(), text) }.getOrNull()
                ?: return // битый кадр не рвёт поток: следующий кадр может быть валидным
            producer.trySend(RelayStreamEvent.Received(event))
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(NORMAL_CLOSURE, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            closeSignal.complete("закрыт кодом $code${reason.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            closeSignal.complete(t.message ?: "сбой WebSocket")
        }

        private companion object {
            const val NORMAL_CLOSURE = 1000
        }
    }
}
