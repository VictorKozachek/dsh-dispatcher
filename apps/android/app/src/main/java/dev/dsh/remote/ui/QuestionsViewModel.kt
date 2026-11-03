package dev.dsh.remote.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.dsh.remote.domain.AnswerOutcome
import dev.dsh.remote.domain.QuestionsRepository
import dev.dsh.remote.domain.SettingsStore
import dev.dsh.remote.domain.model.Question
import dev.dsh.remote.domain.model.RelayEvent
import dev.dsh.remote.sync.AnswerSyncScheduler
import dev.dsh.remote.transport.RelayException
import dev.dsh.remote.transport.RelayStreamEvent
import dev.dsh.remote.transport.RelayTransport
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive
import kotlinx.coroutines.delay

/**
 * Экран открытых вопросов.
 *
 * Жизненный цикл соединения: пока устройство привязано, держим WebSocket
 * (`GET /v1/events`) и heartbeat раз в 30 секунд; при потере соединения поток
 * событий сам переподключается с экспоненциальной паузой. Каждое новое событие
 * `question.created` подтягивает страницу `GET /v1/questions` по курсору.
 *
 * Настройки наблюдением разделены на «идентичность привязки» (url + токен) и
 * курсор: обновление курсора после страницы не должно пересоздавать соединение.
 */
class QuestionsViewModel(
    private val repository: QuestionsRepository,
    private val transport: RelayTransport,
    private val settings: SettingsStore,
    private val syncScheduler: AnswerSyncScheduler,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    /** 0 отключает heartbeat: в юнит-тестах живость держит фейковый транспорт. */
    private val heartbeatIntervalMs: Long = HEARTBEAT_INTERVAL_MS,
) : ViewModel() {

    data class State(
        val loading: Boolean = false,
        val questions: List<Question> = emptyList(),
        val pendingAnswers: Int = 0,
        val connected: Boolean = false,
        val error: String? = null,
    )

    sealed interface Message {
        data object AnswerSent : Message
        data object AnswerQueued : Message
        data object AnswerRejected : Message
        data class Failed(val text: String) : Message
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private val messagesChannel = Channel<Message>(Channel.BUFFERED)
    val messages: Flow<Message> = messagesChannel.receiveAsFlow()

    private var streamJob: Job? = null
    private var heartbeatJob: Job? = null

    init {
        viewModelScope.launch(ioDispatcher) {
            settings.observe()
                .map { it.relayUrl to it.deviceToken }
                .distinctUntilChanged()
                .collectLatest { (relayUrl, token) ->
                    streamJob?.cancel()
                    heartbeatJob?.cancel()
                    if (relayUrl.isBlank() || token.isNullOrBlank()) {
                        _state.update { it.copy(connected = false, questions = emptyList()) }
                        return@collectLatest
                    }
                    startStream(token)
                    startHeartbeat(token)
                    runCatching { fullSync() }
                }
        }
    }

    /** Кнопка «Обновить»: сначала досылаем очередь, потом тянем новые вопросы по курсору. */
    fun refresh() {
        viewModelScope.launch(ioDispatcher) {
            runCatching { repository.flush() }
            runCatching { incrementalRefresh() }
            updatePending()
        }
    }

    fun answer(question: Question, selected: List<String>, custom: String?) {
        viewModelScope.launch(ioDispatcher) {
            try {
                val outcome = repository.answer(question = question, selected = selected, custom = custom)
                when (outcome) {
                    AnswerOutcome.SENT -> {
                        removeQuestion(question.id)
                        messagesChannel.send(Message.AnswerSent)
                    }

                    AnswerOutcome.QUEUED -> {
                        // Ответ уже на диске: сеть появится — уйдёт сам (WorkManager).
                        removeQuestion(question.id)
                        messagesChannel.send(Message.AnswerQueued)
                        syncScheduler.scheduleFlush()
                    }

                    AnswerOutcome.REJECTED -> messagesChannel.send(Message.AnswerRejected)
                }
            } catch (e: RelayException) {
                messagesChannel.send(Message.Failed(e.message ?: "не удалось отправить ответ"))
            } catch (e: IllegalArgumentException) {
                // Пустой ответ отсекает и UI, но ViewModel не должен падать из-за ввода.
                messagesChannel.send(Message.Failed(e.message ?: "ответ пуст"))
            } finally {
                updatePending()
            }
        }
    }

    private fun startStream(token: String) {
        streamJob = viewModelScope.launch(ioDispatcher) {
            transport.events(token).collect { streamEvent ->
                when (streamEvent) {
                    is RelayStreamEvent.Connected -> _state.update { it.copy(connected = true, error = null) }
                    is RelayStreamEvent.Disconnected -> _state.update { it.copy(connected = false) }
                    is RelayStreamEvent.Received -> handleEvent(streamEvent.event)
                }
            }
        }
    }

    private fun startHeartbeat(token: String) {
        if (heartbeatIntervalMs <= 0) return
        heartbeatJob = viewModelScope.launch(ioDispatcher) {
            while (isActive) {
                runCatching { transport.heartbeat(token) }
                updatePending()
                delay(heartbeatIntervalMs)
            }
        }
    }

    private suspend fun handleEvent(event: RelayEvent) {
        when (event.type) {
            RelayEvent.QUESTION_CREATED -> runCatching { incrementalRefresh() }

            RelayEvent.QUESTION_ANSWERED, RelayEvent.QUESTION_EXPIRED -> {
                event.questionId?.let { removeQuestion(it) }
            }

            // device.revoked и pairing.confirmed — экран привязки; здесь только
            // показываем, что соединение потеряно, и не рвём данные.
            RelayEvent.DEVICE_REVOKED -> _state.update { it.copy(error = "устройство отозвано релеем") }

            else -> Unit // открытый набор типов: незнакомое событие игнорируем (§4)
        }
    }

    private suspend fun fullSync() {
        _state.update { it.copy(loading = true, error = null) }
        try {
            val questions = repository.refresh(waitSeconds = 0, fullSync = true)
            _state.update { it.copy(loading = false, questions = questions, error = null) }
            updatePending()
        } catch (e: RelayException) {
            _state.update { it.copy(loading = false, error = e.message) }
        }
    }

    private suspend fun incrementalRefresh() {
        val fetched = repository.refresh(waitSeconds = 0, fullSync = false)
        _state.update { current ->
            val merged = LinkedHashMap<String, Question>()
            current.questions.forEach { merged[it.id] = it }
            fetched.forEach { merged[it.id] = it }
            current.copy(questions = merged.values.toList(), loading = false, error = null)
        }
        updatePending()
    }

    private fun removeQuestion(questionId: String) {
        _state.update { it.copy(questions = it.questions.filterNot { question -> question.id == questionId }) }
    }

    private suspend fun updatePending() {
        val pending = runCatching { repository.pendingCount() }.getOrDefault(0)
        _state.update { it.copy(pendingAnswers = pending) }
    }

    private companion object {
        const val HEARTBEAT_INTERVAL_MS = 30_000L
    }
}
