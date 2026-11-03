package dev.dsh.remote.domain

import dev.dsh.remote.core.Timestamps
import dev.dsh.remote.domain.model.Question
import dev.dsh.remote.domain.model.QuestionCursor
import dev.dsh.remote.transport.RelayException
import dev.dsh.remote.transport.RelayTransport
import kotlinx.coroutines.flow.Flow
import java.time.Clock
import java.util.UUID

/** Итог отправки одного ответа: UI показывает разное сообщение и по-разному фильтрует список. */
enum class AnswerOutcome {
    SENT,
    QUEUED,
    REJECTED,
}

/** Итог прохода по оффлайн-очереди — его показывают индикатор и `WorkManager`. */
data class FlushReport(
    val sent: Int = 0,
    val rejected: Int = 0,
    val pending: Int = 0,
    val lastError: String? = null,
) {
    val retryable: Boolean get() = pending > 0
}

/**
 * Репозиторий вопросов и ответов: единственное место, где сходятся транспорт,
 * настройки и оффлайн-очередь.
 *
 * Инварианты:
 * - ответ сначала попадает в [AnswerStore] и только потом уходит в сеть — оффлайн-ответ
 *   не теряется;
 * - `idempotencyKey` создаётся при постановке в очередь и не меняется при повторах;
 * - курсор `(since, sinceId)` сохраняется после каждой страницы, поэтому рестарт
 *   приложения не теряет и не дублирует вопросы.
 */
class QuestionsRepository(
    private val transport: RelayTransport,
    private val settings: SettingsStore,
    private val answers: AnswerStore,
    private val clock: Clock = Clock.systemUTC(),
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {

    /**
     * `GET /v1/questions` по курсору.
     *
     * `waitSeconds > 0` — long-poll (только foreground: `WorkManager` ждать 25 секунд
     * не должен). `fullSync = true` — пройти страницы с самого начала: после
     * рестарта приложения сохранённый курсор указывает вперёд, и без полного обхода
     * старые неотвеченные вопросы в список бы не попали.
     */
    suspend fun refresh(waitSeconds: Int = 0, fullSync: Boolean = false): List<Question> {
        val token = settings.snapshot().deviceToken ?: throw RelayException(
            RelayException.Kind.Unauthorized,
            "устройство не привязано к релею",
        )

        var cursor: QuestionCursor? = if (fullSync) {
            null
        } else {
            settings.snapshot().let { current ->
                current.cursorSince?.let { QuestionCursor(since = it, sinceId = current.cursorSinceId) }
            }
        }

        val collected = mutableListOf<Question>()
        var pageIndex = 0
        while (true) {
            val page = transport.listQuestions(
                token = token,
                cursor = cursor,
                limit = PAGE_LIMIT,
                waitSeconds = if (pageIndex == 0) waitSeconds else 0,
            )
            collected += page.questions

            val nextSince = page.nextSince ?: break
            val current = settings.snapshot()
            val nextSinceId = page.nextId ?: current.cursorSinceId
            settings.write(current.copy(cursorSince = nextSince, cursorSinceId = nextSinceId))
            cursor = QuestionCursor(since = nextSince, sinceId = nextSinceId)
            pageIndex += 1

            // Одна страница на обычное обновление; полный обход — пока страницы полные.
            if (!fullSync || page.questions.size < PAGE_LIMIT || pageIndex >= MAX_FULL_SYNC_PAGES) break
        }

        val now = clock.instant()
        // Отвеченные релеем вопросы в список уже не попадают (`answered = 0` в SQL релея),
        // но ответ, который ещё лежит в очереди, релей пока не знает — такой вопрос
        // человеку повторно не показываем.
        val answeredLocally = answers.entries()
            .filter { it.state != OutboxState.REJECTED }
            .map { it.questionId }
            .toSet()
        return collected.filterNot { question ->
            val expiresAt = Timestamps.parse(question.expiresAt)
            val expired = expiresAt != null && !expiresAt.isAfter(now)
            expired || question.id in answeredLocally
        }
    }

    /**
     * Ответ человека. Сначала запись в очередь, потом попытка отправки: если сеть
     * недоступна, ответ уже сохранён и уйдёт следующим [flush] (его запускает
     * `WorkManager` по ограничению «есть сеть»).
     */
    suspend fun answer(question: Question, selected: List<String>, custom: String?): AnswerOutcome {
        val current = settings.snapshot()
        val token = current.deviceToken ?: throw RelayException(
            RelayException.Kind.Unauthorized,
            "устройство не привязано к релею",
        )
        val selectedIds = selected.distinct()
        val text = custom?.trim()?.takeIf { it.isNotEmpty() }
        require(selectedIds.isNotEmpty() || text != null) { "нужен выбранный вариант или текст ответа" }

        // Двойное нажатие или повторное открытие вопроса не должны порождать второй
        // ответ: у уже отвеченного вопроса (или ответа в очереди) ключ новый не нужен.
        answers.entries().firstOrNull { it.questionId == question.id && it.state != OutboxState.REJECTED }?.let { existing ->
            return if (existing.state == OutboxState.SENT) AnswerOutcome.SENT else AnswerOutcome.QUEUED
        }

        val entry = OutboxEntry(
            idempotencyKey = newId(),
            questionId = question.id,
            questionTitle = question.title,
            questionShortId = question.shortId,
            workspace = question.workspace,
            selected = selectedIds,
            custom = text,
            answeredAt = Timestamps.format(clock.instant()),
        )
        answers.put(entry)
        return submit(token, entry)
    }

    /** Проход по очереди: отправляет всё, что накопилось, и не бросает исключения наружу. */
    suspend fun flush(): FlushReport {
        val token = settings.snapshot().deviceToken
        if (token == null) {
            return FlushReport(pending = answers.pending().size, lastError = "устройство не привязано к релею")
        }
        var sent = 0
        var rejected = 0
        var lastError: String? = null
        for (entry in answers.pending()) {
            when (submit(token, entry)) {
                AnswerOutcome.SENT -> sent += 1
                AnswerOutcome.REJECTED -> rejected += 1
                AnswerOutcome.QUEUED -> lastError = entry.lastError
            }
        }
        return FlushReport(
            sent = sent,
            rejected = rejected,
            pending = answers.pending().size,
            lastError = lastError,
        )
    }

    fun observeAnswers(): Flow<List<OutboxEntry>> = answers.observe()

    suspend fun pendingCount(): Int = answers.pending().size

    private suspend fun submit(token: String, entry: OutboxEntry): AnswerOutcome {
        val attempt = entry.copy(attempts = entry.attempts + 1)
        return try {
            transport.submitAnswer(token, entry.toAnswerRequest())
            answers.update(attempt.copy(state = OutboxState.SENT, lastError = null))
            AnswerOutcome.SENT
        } catch (e: RelayException) {
            when {
                e.kind == RelayException.Kind.Conflict -> {
                    // Вопрос уже отвечен (в том числе этим устройством до падения) — повторять нечего.
                    answers.update(attempt.copy(state = OutboxState.REJECTED, lastError = "вопрос уже отвечен"))
                    AnswerOutcome.REJECTED
                }

                e.retryable -> {
                    answers.update(attempt.copy(lastError = e.message))
                    AnswerOutcome.QUEUED
                }

                else -> {
                    answers.update(attempt.copy(state = OutboxState.REJECTED, lastError = e.message))
                    AnswerOutcome.REJECTED
                }
            }
        }
    }

    private companion object {
        const val PAGE_LIMIT = 50

        /** Потолок полного обхода: 20 страниц по 50 — больше открытых вопросов у одного человека не бывает. */
        const val MAX_FULL_SYNC_PAGES = 20
    }
}
