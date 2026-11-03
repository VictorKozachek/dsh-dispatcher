package dev.dsh.remote.ui

import androidx.lifecycle.viewModelScope
import dev.dsh.remote.FakeRelayTransport
import dev.dsh.remote.InMemoryAnswerStore
import dev.dsh.remote.InMemorySettingsStore
import dev.dsh.remote.MainDispatcherRule
import dev.dsh.remote.RecordingSyncScheduler
import dev.dsh.remote.domain.model.QuestionPage
import dev.dsh.remote.domain.QuestionsRepository
import dev.dsh.remote.domain.RelaySettings
import dev.dsh.remote.domain.model.RelayEvent
import dev.dsh.remote.question
import dev.dsh.remote.transport.RelayException
import dev.dsh.remote.transport.RelayStreamEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

/** ViewModel открытых вопросов: старт, события WS, ответы онлайн и оффлайн. */
@OptIn(ExperimentalCoroutinesApi::class)
class QuestionsViewModelTest {

    @get:Rule
    val mainDispatcherRule = MainDispatcherRule()

    private val transport = FakeRelayTransport()
    private val settings = InMemorySettingsStore(
        RelaySettings(relayUrl = "https://relay.test", deviceId = "device-1", deviceToken = "dt_test"),
    )
    private val store = InMemoryAnswerStore()
    private val scheduler = RecordingSyncScheduler()
    private val events = MutableSharedFlow<RelayStreamEvent>(extraBufferCapacity = 32)

    private lateinit var repository: QuestionsRepository

    @Before
    fun setUp() {
        transport.eventsFlow = events
        repository = QuestionsRepository(
            transport = transport,
            settings = settings,
            answers = store,
            clock = Clock.fixed(Instant.parse("2026-11-03T18:00:00Z"), ZoneOffset.UTC),
        )
    }

    @Test
    fun `при старте показывает открытые вопросы`() = runTest(mainDispatcherRule.dispatcher) {
        transport.page = QuestionPage(listOf(question("q-1"), question("q-2")), "2026-11-03T18:00:01Z", "q-2")

        val viewModel = viewModel()
        advanceUntilIdle()

        assertEquals(listOf("q-1", "q-2"), viewModel.state.value.questions.map { it.id })
        assertFalse(viewModel.state.value.loading)
        viewModel.viewModelScope.cancel()
    }

    @Test
    fun `событие question_created подтягивает новый вопрос`() = runTest(mainDispatcherRule.dispatcher) {
        transport.page = QuestionPage(listOf(question("q-1")), "2026-11-03T18:00:01Z", "q-1")
        val viewModel = viewModel()
        advanceUntilIdle()

        transport.page = QuestionPage(listOf(question("q-2")), "2026-11-03T18:00:02Z", "q-2")
        events.tryEmit(
            RelayStreamEvent.Received(
                RelayEvent(type = RelayEvent.QUESTION_CREATED, at = "2026-11-03T18:00:02Z", questionId = "q-2"),
            ),
        )
        advanceUntilIdle()

        assertEquals(setOf("q-1", "q-2"), viewModel.state.value.questions.map { it.id }.toSet())
        viewModel.viewModelScope.cancel()
    }

    @Test
    fun `событие question_answered убирает вопрос из списка`() = runTest(mainDispatcherRule.dispatcher) {
        transport.page = QuestionPage(listOf(question("q-1")), "2026-11-03T18:00:01Z", "q-1")
        val viewModel = viewModel()
        advanceUntilIdle()

        events.tryEmit(
            RelayStreamEvent.Received(
                RelayEvent(type = RelayEvent.QUESTION_ANSWERED, at = "2026-11-03T18:01:00Z", questionId = "q-1"),
            ),
        )
        advanceUntilIdle()

        assertTrue(viewModel.state.value.questions.isEmpty())
        viewModel.viewModelScope.cancel()
    }

    @Test
    fun `незнакомое событие не ломает состояние`() = runTest(mainDispatcherRule.dispatcher) {
        transport.page = QuestionPage(listOf(question("q-1")), "2026-11-03T18:00:01Z", "q-1")
        val viewModel = viewModel()
        advanceUntilIdle()

        events.tryEmit(
            RelayStreamEvent.Received(
                RelayEvent(type = "future.event", at = "2026-11-03T18:01:00Z", questionId = "q-1"),
            ),
        )
        advanceUntilIdle()

        assertEquals(1, viewModel.state.value.questions.size)
        viewModel.viewModelScope.cancel()
    }

    @Test
    fun `состояние соединения видно в state`() = runTest(mainDispatcherRule.dispatcher) {
        transport.page = QuestionPage(emptyList(), "2026-11-03T18:00:01Z", "q-1")
        val viewModel = viewModel()
        advanceUntilIdle()

        events.tryEmit(RelayStreamEvent.Connected)
        advanceUntilIdle()
        assertTrue(viewModel.state.value.connected)

        events.tryEmit(RelayStreamEvent.Disconnected("сеть пропала"))
        advanceUntilIdle()
        assertFalse(viewModel.state.value.connected)
        viewModel.viewModelScope.cancel()
    }

    @Test
    fun `ответ без сети уходит в очередь и планирует отправку`() = runTest(mainDispatcherRule.dispatcher) {
        transport.page = QuestionPage(listOf(question("q-1")), "2026-11-03T18:00:01Z", "q-1")
        transport.submitError = RelayException(RelayException.Kind.Network, "нет сети")
        val viewModel = viewModel()
        val messages = mutableListOf<QuestionsViewModel.Message>()
        backgroundScope.launch(mainDispatcherRule.dispatcher) { viewModel.messages.collect { messages += it } }
        advanceUntilIdle()

        viewModel.answer(question("q-1"), listOf("o1"), null)
        advanceUntilIdle()

        assertEquals(1, viewModel.state.value.pendingAnswers)
        assertTrue("отвеченный вопрос убираем из списка", viewModel.state.value.questions.isEmpty())
        assertEquals("WorkManager должен быть разбужен", 1, scheduler.scheduled.get())
        assertTrue(messages.contains(QuestionsViewModel.Message.AnswerQueued))
        viewModel.viewModelScope.cancel()
    }

    @Test
    fun `ответ в сети отправляется сразу и не попадает в очередь`() = runTest(mainDispatcherRule.dispatcher) {
        transport.page = QuestionPage(listOf(question("q-1")), "2026-11-03T18:00:01Z", "q-1")
        val viewModel = viewModel()
        val messages = mutableListOf<QuestionsViewModel.Message>()
        backgroundScope.launch(mainDispatcherRule.dispatcher) { viewModel.messages.collect { messages += it } }
        advanceUntilIdle()

        viewModel.answer(question("q-1"), listOf("o1"), null)
        advanceUntilIdle()

        assertEquals(0, viewModel.state.value.pendingAnswers)
        assertEquals(1, transport.submittedAnswers.size)
        assertEquals(0, scheduler.scheduled.get())
        assertTrue(messages.contains(QuestionsViewModel.Message.AnswerSent))
        viewModel.viewModelScope.cancel()
    }

    private fun viewModel(): QuestionsViewModel = QuestionsViewModel(
        repository = repository,
        transport = transport,
        settings = settings,
        syncScheduler = scheduler,
        ioDispatcher = mainDispatcherRule.dispatcher,
        heartbeatIntervalMs = 0,
    )
}
