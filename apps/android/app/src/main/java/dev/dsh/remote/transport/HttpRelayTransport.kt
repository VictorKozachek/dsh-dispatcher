package dev.dsh.remote.transport

import dev.dsh.remote.core.BackoffPolicy
import dev.dsh.remote.domain.model.Answer
import dev.dsh.remote.domain.model.AnswerRequest
import dev.dsh.remote.domain.model.Device
import dev.dsh.remote.domain.model.DeviceCreateRequest
import dev.dsh.remote.domain.model.PairRequest
import dev.dsh.remote.domain.model.PairResponse
import dev.dsh.remote.domain.model.QuestionCursor
import dev.dsh.remote.domain.model.QuestionPage
import dev.dsh.remote.domain.model.RelayErrorBody
import dev.dsh.remote.domain.model.RelayEvent
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * HTTP-транспорт релея на OkHttp.
 *
 * Правила §2–§4 контракта, которые здесь зашиты:
 * - обязательный заголовок `X-Relay-Version: 1` в каждом запросе;
 * - `Authorization: Bearer <токен>` у всех запросов, кроме `POST /v1/devices` и `POST /v1/pair`;
 * - повтор только для `5xx`, `429` и сетевых ошибок и только для идемпотентных вызовов;
 * - `Retry-After` у `429` уважается, иначе — экспоненциальная пауза 1→2→4→8→16 с.
 *
 * Адрес релея приходит провайдером: его вводит человек на экране привязки, поэтому
 * транспорт создаётся один раз, а URL читается на каждом запросе.
 */
class HttpRelayTransport(
    private val baseUrlProvider: () -> String,
    private val client: OkHttpClient = defaultHttpClient(),
    private val json: Json = RelayJson,
    private val retryPolicy: RetryPolicy = RetryPolicy(),
    private val sleeper: suspend (Long) -> Unit = { delay(it) },
    private val webSocketFactory: () -> OkHttpClient = { defaultWebSocketClient() },
) : RelayTransport {

    constructor(
        baseUrl: String,
        client: OkHttpClient = defaultHttpClient(),
        json: Json = RelayJson,
        retryPolicy: RetryPolicy = RetryPolicy(),
        sleeper: suspend (Long) -> Unit = { delay(it) },
    ) : this({ baseUrl }, client, json, retryPolicy, sleeper)

    override suspend fun registerDevice(publicKey: String, label: String?): Device {
        val body = json.encodeToString(
            DeviceCreateRequest.serializer(),
            DeviceCreateRequest(
                platform = DeviceCreateRequest.PLATFORM_ANDROID,
                publicKey = publicKey,
                label = label,
            ),
        )
        // §4: идемпотентно по (platform, publicKey) — повтор безопасен.
        return call(Method.POST, RelayProtocol.PATH_DEVICES, token = null, body = body, idempotent = true) {
            json.decodeFromString(Device.serializer(), it)
        }
    }

    override suspend fun pair(pairCode: String, deviceId: String): PairResponse {
        val body = json.encodeToString(PairRequest.serializer(), PairRequest(pairCode = pairCode, deviceId = deviceId))
        // Код одноразовый: автоматический повтор мог бы «сжечь» его, поэтому повтор
        // только ручной — человеком на экране привязки.
        return call(Method.POST, RelayProtocol.PATH_PAIR, token = null, body = body, idempotent = false) {
            json.decodeFromString(PairResponse.serializer(), it)
        }
    }

    override suspend fun listQuestions(
        token: String,
        cursor: QuestionCursor?,
        limit: Int,
        waitSeconds: Int,
    ): QuestionPage {
        val query = buildList {
            cursor?.since?.let { add("since" to it) }
            cursor?.sinceId?.let { add("sinceId" to it) }
            add("limit" to limit.coerceIn(1, 100).toString())
            if (waitSeconds > 0) add("wait" to waitSeconds.coerceIn(0, RelayProtocol.MAX_LONG_POLL_SECONDS).toString())
        }
        return call(Method.GET, RelayProtocol.PATH_QUESTIONS, token = token, query = query, idempotent = true) {
            val list = json.decodeFromString(QuestionListDto.serializer(), it)
            QuestionPage(questions = list.questions, nextSince = list.nextSince, nextId = list.nextId)
        }
    }

    override suspend fun submitAnswer(token: String, answer: AnswerRequest): Answer {
        val body = json.encodeToString(AnswerRequest.serializer(), answer)
        // §4: идемпотентно по idempotencyKey; повтор с тем же телом вернёт тот же 200.
        return call(Method.POST, RelayProtocol.PATH_ANSWERS, token = token, body = body, idempotent = true) {
            json.decodeFromString(Answer.serializer(), it)
        }
    }

    override suspend fun heartbeat(token: String) {
        call(Method.POST, RelayProtocol.PATH_HEARTBEAT, token = token, idempotent = true) { Unit }
    }

    override fun events(token: String): Flow<RelayStreamEvent> = RelayWebSocketClient(
        baseUrlProvider = baseUrlProvider,
        tokenProvider = { token },
        client = webSocketFactory(),
        json = json,
    ).events()

    private suspend fun <T> call(
        method: Method,
        path: String,
        token: String?,
        body: String? = null,
        query: List<Pair<String, String>> = emptyList(),
        idempotent: Boolean,
        decode: (String) -> T,
    ): T {
        var attempt = 1
        while (true) {
            val failure = try {
                return decode(executeOnce(method, path, token, body, query))
            } catch (e: RelayException) {
                e
            }
            if (!idempotent || !failure.retryable || attempt >= retryPolicy.maxAttempts) throw failure
            val pauseMs = failure.retryAfterSeconds?.times(1_000L) ?: retryPolicy.delayForAttempt(attempt)
            sleeper(pauseMs)
            attempt += 1
        }
    }

    private fun executeOnce(
        method: Method,
        path: String,
        token: String?,
        body: String?,
        query: List<Pair<String, String>>,
    ): String {
        val request = Request.Builder()
            .url(buildUrl(path, query))
            .header(RelayProtocol.VERSION_HEADER, RelayProtocol.VERSION.toString())
            .header("Accept", "application/json")
            .apply { if (token != null) header(RelayProtocol.AUTHORIZATION_HEADER, "Bearer $token") }
            .apply {
                when (method) {
                    Method.GET -> get()
                    Method.DELETE -> delete()
                    Method.POST -> post((body ?: "").toRequestBody(JSON_MEDIA_TYPE))
                }
            }
            .build()

        val response = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            throw RelayException(RelayException.Kind.Network, e.message ?: "сетевая ошибка", cause = e)
        }

        return response.use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw mapHttpError(resp, text)
            text
        }
    }

    private fun buildUrl(path: String, query: List<Pair<String, String>>): HttpUrl {
        val base = normalizeBaseUrl(baseUrlProvider())
        val url = (base + path).toHttpUrlOrNull()
            ?: throw RelayException(RelayException.Kind.Protocol, "некорректный адрес релея: $base")
        return url.newBuilder().apply {
            query.forEach { (name, value) -> addQueryParameter(name, value) }
        }.build()
    }

    private fun mapHttpError(response: Response, text: String): RelayException {
        val parsed = runCatching { json.decodeFromString(RelayErrorBody.serializer(), text) }.getOrNull()
        val kind = when (response.code) {
            400 -> RelayException.Kind.BadRequest
            401 -> RelayException.Kind.Unauthorized
            403 -> RelayException.Kind.Forbidden
            404 -> RelayException.Kind.NotFound
            409 -> RelayException.Kind.Conflict
            410 -> RelayException.Kind.Expired
            413 -> RelayException.Kind.PayloadTooLarge
            426 -> RelayException.Kind.UnsupportedVersion
            429 -> RelayException.Kind.RateLimited
            in 500..599 -> RelayException.Kind.Server
            else -> RelayException.Kind.Protocol
        }
        return RelayException(
            kind = kind,
            message = parsed?.error?.message ?: "HTTP ${response.code}",
            httpStatus = response.code,
            errorCode = parsed?.error?.code,
            retryAfterSeconds = response.header("Retry-After")?.trim()?.toLongOrNull(),
        )
    }

    private enum class Method { GET, POST, DELETE }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private const val CONNECT_TIMEOUT_SECONDS = 10L

        /** Читаем с запасом над long-poll: `wait` ≤ 25 с (§3). */
        private const val READ_TIMEOUT_SECONDS = 35L

        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(READ_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .build()

        /**
         * WebSocket-клиент: ping-кадр каждые 25 с (§3). Пропавший pong OkHttp считает
         * failure'ом соединения — после него [RelayWebSocketClient] переподключается.
         */
        fun defaultWebSocketClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(CONNECT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()

        /** `relay.example.com` → `https://relay.example.com`; хвостовой `/` не нужен. */
        fun normalizeBaseUrl(raw: String): String {
            val trimmed = raw.trim().trimEnd('/')
            if (trimmed.isEmpty()) {
                throw RelayException(RelayException.Kind.Protocol, "адрес релея пуст")
            }
            return if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
                trimmed
            } else {
                "https://$trimmed"
            }
        }
    }
}

/** Паузы между повторами: 5 попыток всего (1 с, 2 с, 4 с, 8 с, 16 с), jitter внутри. */
class RetryPolicy(
    val maxAttempts: Int = 5,
    private val backoff: BackoffPolicy = BackoffPolicy(),
) {
    init {
        require(maxAttempts >= 1) { "maxAttempts должен быть >= 1" }
    }

    fun delayForAttempt(attempt: Int): Long = backoff.delayForAttempt(attempt)
}

/** `QuestionList` релея: `nextSince`/`nextId` — аддитивные поля (§3). */
@kotlinx.serialization.Serializable
internal data class QuestionListDto(
    val questions: List<dev.dsh.remote.domain.model.Question> = emptyList(),
    val nextSince: String? = null,
    val nextId: String? = null,
)

/** Тип события незнакомый — это не ошибка: клиент его просто игнорирует. */
internal fun RelayEvent.isKnown(): Boolean = type in setOf(
    RelayEvent.QUESTION_CREATED,
    RelayEvent.QUESTION_ANSWERED,
    RelayEvent.QUESTION_EXPIRED,
    RelayEvent.PAIRING_CONFIRMED,
    RelayEvent.DEVICE_REVOKED,
    RelayEvent.HEARTBEAT,
)
