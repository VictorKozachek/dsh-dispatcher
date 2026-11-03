package dev.dsh.remote.transport

import dev.dsh.remote.domain.model.Answer
import dev.dsh.remote.domain.model.AnswerRequest
import dev.dsh.remote.domain.model.Device
import dev.dsh.remote.domain.model.PairResponse
import dev.dsh.remote.domain.model.QuestionCursor
import dev.dsh.remote.domain.model.QuestionPage
import kotlinx.coroutines.flow.Flow

/**
 * Транспорт к релею — единственный способ приложения поговорить с DSH.
 * Прямого доступа к сессии агента нет: всё идёт через `docs/relay/PROTOCOL.md` (§3).
 *
 * Токены передаются явно: транспорт не читает настройки и не хранит секретов,
 * это делает репозиторий, а тесты подставляют фейк.
 */
interface RelayTransport {

    /** `POST /v1/devices`: идемпотентно по `(platform, publicKey)`. */
    suspend fun registerDevice(publicKey: String, label: String? = null): Device

    /** `POST /v1/pair`: одноразовый код, `deviceToken` — Bearer устройства. */
    suspend fun pair(pairCode: String, deviceId: String): PairResponse

    /** `GET /v1/questions?since=&sinceId=&limit=&wait=`. */
    suspend fun listQuestions(
        token: String,
        cursor: QuestionCursor? = null,
        limit: Int = RelayProtocol.DEFAULT_PAGE_LIMIT,
        waitSeconds: Int = 0,
    ): QuestionPage

    /** `POST /v1/answers`: идемпотентно по `idempotencyKey`. */
    suspend fun submitAnswer(token: String, answer: AnswerRequest): Answer

    /** `POST /v1/heartbeat`: устройство живо, раз в 30 секунд. */
    suspend fun heartbeat(token: String)

    /** `GET /v1/events`: поток событий, с переподключением внутри. */
    fun events(token: String): Flow<RelayStreamEvent>
}

/** Элемент потока событий: состояние соединения тоже часть потока — по нему рисуем индикатор. */
sealed interface RelayStreamEvent {
    data object Connected : RelayStreamEvent
    data class Disconnected(val reason: String?) : RelayStreamEvent
    data class Received(val event: dev.dsh.remote.domain.model.RelayEvent) : RelayStreamEvent
}
