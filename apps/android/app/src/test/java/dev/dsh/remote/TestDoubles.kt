package dev.dsh.remote

import dev.dsh.remote.domain.AnswerStore
import dev.dsh.remote.domain.OutboxEntry
import dev.dsh.remote.domain.RelaySettings
import dev.dsh.remote.domain.SettingsStore
import dev.dsh.remote.domain.model.Answer
import dev.dsh.remote.domain.model.AnswerRequest
import dev.dsh.remote.domain.model.Device
import dev.dsh.remote.domain.model.PairResponse
import dev.dsh.remote.domain.model.Question
import dev.dsh.remote.domain.model.QuestionCursor
import dev.dsh.remote.domain.model.QuestionPage
import dev.dsh.remote.sync.AnswerSyncScheduler
import dev.dsh.remote.transport.RelayException
import dev.dsh.remote.transport.RelayStreamEvent
import dev.dsh.remote.transport.RelayTransport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import java.util.concurrent.atomic.AtomicInteger

/** Фейковый транспорт: записывает вызовы и подменяет ответы/ошибки в тестах. */
class FakeRelayTransport : RelayTransport {

    var device: Device = Device(deviceId = "device-1", platform = "android", createdAt = "2026-11-03T18:00:00Z")
    var pairResponse: PairResponse = PairResponse(deviceToken = "dt_test_token", device = device)

    var registerError: RelayException? = null
    var pairError: RelayException? = null
    var listError: RelayException? = null
    var submitError: RelayException? = null

    var page: QuestionPage = QuestionPage(questions = emptyList(), nextSince = "2026-11-03T18:00:00Z", nextId = "")
    val pageQueue: ArrayDeque<QuestionPage> = ArrayDeque()
    var eventsFlow: Flow<RelayStreamEvent> = emptyFlow()

    val registeredPublicKeys = mutableListOf<String>()
    val submittedAnswers = mutableListOf<AnswerRequest>()
    val listRequests = mutableListOf<ListRequest>()
    val heartbeats = AtomicInteger(0)

    data class ListRequest(val token: String, val cursor: QuestionCursor?, val limit: Int, val waitSeconds: Int)

    override suspend fun registerDevice(publicKey: String, label: String?): Device {
        registerError?.let { throw it }
        registeredPublicKeys += publicKey
        return device
    }

    override suspend fun pair(pairCode: String, deviceId: String): PairResponse {
        pairError?.let { throw it }
        return pairResponse
    }

    override suspend fun listQuestions(
        token: String,
        cursor: QuestionCursor?,
        limit: Int,
        waitSeconds: Int,
    ): QuestionPage {
        listRequests += ListRequest(token, cursor, limit, waitSeconds)
        listError?.let { throw it }
        return pageQueue.removeFirstOrNull() ?: page
    }

    override suspend fun submitAnswer(token: String, answer: AnswerRequest): Answer {
        submittedAnswers += answer
        submitError?.let { throw it }
        return Answer(
            questionId = answer.questionId,
            answeredAt = answer.answeredAt,
            idempotencyKey = answer.idempotencyKey,
            selected = answer.selected,
            custom = answer.custom,
        )
    }

    override suspend fun heartbeat(token: String) {
        heartbeats.incrementAndGet()
    }

    override fun events(token: String): Flow<RelayStreamEvent> = eventsFlow
}

class InMemorySettingsStore(initial: RelaySettings = RelaySettings()) : SettingsStore {
    private val state = MutableStateFlow(initial)

    override fun snapshot(): RelaySettings = state.value

    override fun observe(): Flow<RelaySettings> = state

    override suspend fun write(settings: RelaySettings) {
        state.value = settings
    }
}

class InMemoryAnswerStore(initial: List<OutboxEntry> = emptyList()) : AnswerStore {
    private val state = MutableStateFlow(initial)

    override fun observe(): Flow<List<OutboxEntry>> = flow { emitAll(state) }

    override suspend fun entries(): List<OutboxEntry> = state.value

    override suspend fun pending(): List<OutboxEntry> =
        state.value.filter { it.state == dev.dsh.remote.domain.OutboxState.PENDING }

    override suspend fun put(entry: OutboxEntry) {
        state.value = state.value.filterNot { it.idempotencyKey == entry.idempotencyKey } + entry
    }

    override suspend fun update(entry: OutboxEntry) {
        state.value = state.value.map { existing ->
            if (existing.idempotencyKey == entry.idempotencyKey) entry else existing
        }
    }
}

class RecordingSyncScheduler : AnswerSyncScheduler {
    val scheduled = AtomicInteger(0)
    override fun scheduleFlush() {
        scheduled.incrementAndGet()
    }
}

/** Подмена главного диспетчера: `viewModelScope` в юнит-тестах требует Main. */
@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(
    val dispatcher: TestDispatcher = UnconfinedTestDispatcher(),
) : TestWatcher() {

    override fun starting(description: Description) {
        Dispatchers.setMain(dispatcher)
    }

    override fun finished(description: Description) {
        Dispatchers.resetMain()
    }
}


/** Пустой вопрос для тестов. */
fun question(
    id: String = "q-1",
    title: String? = "Вопрос",
    workspace: String? = "/repo",
    taskId: String? = "019",
    expiresAt: String = "2026-11-03T18:30:00Z",
    createdAt: String = "2026-11-03T18:00:00Z",
): Question = Question(
    id = id,
    shortId = "a1b2c3d4",
    workspace = workspace,
    taskId = taskId,
    role = "worker",
    title = title,
    body = "Продолжать?",
    options = emptyList(),
    createdAt = createdAt,
    expiresAt = expiresAt,
)
