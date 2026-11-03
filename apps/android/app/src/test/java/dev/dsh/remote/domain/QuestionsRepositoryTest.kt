package dev.dsh.remote.domain

import dev.dsh.remote.FakeRelayTransport
import dev.dsh.remote.InMemoryAnswerStore
import dev.dsh.remote.InMemorySettingsStore
import dev.dsh.remote.question
import dev.dsh.remote.storage.FileAnswerOutbox
import dev.dsh.remote.transport.RelayException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

/** Репозиторий: оффлайн-ответ, идемпотентность, курсор и фильтрация списка. */
class QuestionsRepositoryTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private val now = Instant.parse("2026-11-03T18:00:00Z")
    private val clock: Clock = Clock.fixed(now, ZoneOffset.UTC)

    private lateinit var transport: FakeRelayTransport
    private lateinit var settings: InMemorySettingsStore
    private lateinit var store: InMemoryAnswerStore
    private lateinit var repository: QuestionsRepository

    @Before
    fun setUp() {
        transport = FakeRelayTransport()
        settings = InMemorySettingsStore(
            RelaySettings(
                relayUrl = "https://relay.test",
                deviceId = "device-1",
                deviceToken = "dt_test",
            ),
        )
        store = InMemoryAnswerStore()
        repository = QuestionsRepository(
            transport = transport,
            settings = settings,
            answers = store,
            clock = clock,
            newId = { KEY },
        )
    }

    @Test
    fun `ответ без сети сохраняется и уходит ровно один раз`() = runBlocking {
        transport.submitError = RelayException(RelayException.Kind.Network, "нет сети")

        val outcome = repository.answer(question("q-1"), selected = listOf("o1"), custom = null)

        assertEquals(AnswerOutcome.QUEUED, outcome)
        assertEquals("ответ должен лежать в очереди", 1, store.pending().size)
        assertEquals(KEY, store.pending().single().idempotencyKey)

        transport.submitError = null
        val firstFlush = repository.flush()
        assertEquals(1, firstFlush.sent)
        assertEquals(0, firstFlush.pending)

        val secondFlush = repository.flush()
        assertEquals("повторный проход ничего не отправляет", 0, secondFlush.sent)
        // Две попытки — упавшая при ответе и успешная при flush, — но ключ один:
        // релей увидит ровно один ответ.
        assertEquals(2, transport.submittedAnswers.size)
        assertEquals(listOf(KEY), transport.submittedAnswers.map { it.idempotencyKey }.distinct())
        assertEquals(OutboxState.SENT, store.entries().single().state)
    }

    @Test
    fun `оффлайн-ответ переживает рестарт приложения`() = runBlocking {
        val file = File(tempFolder.root, "answers.json")
        val firstRepository = QuestionsRepository(
            transport = transport,
            settings = settings,
            answers = FileAnswerOutbox(file),
            clock = clock,
            newId = { "k-restart" },
        )
        transport.submitError = RelayException(RelayException.Kind.Network, "нет сети")
        assertEquals(AnswerOutcome.QUEUED, firstRepository.answer(question("q-1"), listOf("o1"), null))

        // «Рестарт»: новый экземпляр хранилища читает очередь с диска.
        transport.submitError = null
        val restartedRepository = QuestionsRepository(
            transport = transport,
            settings = settings,
            answers = FileAnswerOutbox(file),
            clock = clock,
        )
        val report = restartedRepository.flush()

        assertEquals(1, report.sent)
        assertTrue(transport.submittedAnswers.any { it.idempotencyKey == "k-restart" })
    }

    @Test
    fun `повторный ответ на тот же вопрос не плодит записей`() = runBlocking {
        transport.submitError = RelayException(RelayException.Kind.Network, "нет сети")

        repository.answer(question("q-1"), listOf("o1"), null)
        repository.answer(question("q-1"), listOf("o2"), null)

        assertEquals(1, store.entries().size)
        assertEquals(listOf("o1"), store.entries().single().selected)
    }

    @Test
    fun `конфликт не повторяется`() = runBlocking {
        transport.submitError = RelayException(RelayException.Kind.Conflict, "вопрос уже отвечен")

        val outcome = repository.answer(question("q-1"), listOf("o1"), null)

        assertEquals(AnswerOutcome.REJECTED, outcome)
        assertEquals(OutboxState.REJECTED, store.entries().single().state)
        assertEquals(0, repository.flush().pending)
        assertEquals("после 409 повторов нет", 1, transport.submittedAnswers.size)
    }

    @Test
    fun `постоянная ошибка 400 отклоняет ответ без повторов`() = runBlocking {
        transport.submitError = RelayException(RelayException.Kind.BadRequest, "лишнее поле")

        val outcome = repository.answer(question("q-1"), listOf("o1"), null)

        assertEquals(AnswerOutcome.REJECTED, outcome)
        assertEquals(0, repository.flush().pending)
    }

    @Test
    fun `серверная ошибка оставляет ответ в очереди`() = runBlocking {
        transport.submitError = RelayException(RelayException.Kind.Server, "500")

        val outcome = repository.answer(question("q-1"), listOf("o1"), null)

        assertEquals(AnswerOutcome.QUEUED, outcome)
        val entry = store.pending().single()
        assertEquals(1, entry.attempts)
        assertEquals("500", entry.lastError)
    }

    @Test
    fun `курсор сохраняется и следующая страница идёт с него`() = runBlocking {
        transport.page = dev.dsh.remote.domain.model.QuestionPage(
            questions = listOf(question("q-1")),
            nextSince = "2026-11-03T18:00:01Z",
            nextId = "q-1",
        )

        repository.refresh()

        assertEquals("2026-11-03T18:00:01Z", settings.snapshot().cursorSince)
        assertEquals("q-1", settings.snapshot().cursorSinceId)

        transport.page = dev.dsh.remote.domain.model.QuestionPage(
            questions = emptyList(),
            nextSince = "2026-11-03T18:00:02Z",
            nextId = "q-2",
        )
        repository.refresh()

        val second = transport.listRequests.last()
        assertEquals("2026-11-03T18:00:01Z", second.cursor?.since)
        assertEquals("q-1", second.cursor?.sinceId)
    }

    @Test
    fun `полная синхронизация обходит страницы с начала`() = runBlocking {
        val firstPage = (1..50).map { question("q-$it") }
        transport.pageQueue.add(
            dev.dsh.remote.domain.model.QuestionPage(firstPage, "2026-11-03T18:00:01Z", "q-50"),
        )
        transport.pageQueue.add(
            dev.dsh.remote.domain.model.QuestionPage(listOf(question("q-51")), "2026-11-03T18:00:02Z", "q-51"),
        )

        val result = repository.refresh(fullSync = true)

        assertEquals(51, result.size)
        assertEquals(2, transport.listRequests.size)
        assertNull("полный обход начинается без курсора", transport.listRequests.first().cursor)
        assertEquals("2026-11-03T18:00:02Z", settings.snapshot().cursorSince)
    }

    @Test
    fun `вопрос с ответом в очереди не показывается повторно`() = runBlocking {
        transport.page = dev.dsh.remote.domain.model.QuestionPage(
            questions = listOf(question("q-1"), question("q-2")),
            nextSince = "2026-11-03T18:00:01Z",
            nextId = "q-2",
        )
        transport.submitError = RelayException(RelayException.Kind.Network, "нет сети")
        repository.answer(question("q-1"), listOf("o1"), null)

        val questions = repository.refresh()

        assertEquals(listOf("q-2"), questions.map { it.id })
    }

    @Test
    fun `истёкший вопрос не попадает в список`() = runBlocking {
        transport.page = dev.dsh.remote.domain.model.QuestionPage(
            questions = listOf(
                question("q-old", expiresAt = "2026-11-03T17:59:00Z"),
                question("q-new"),
            ),
            nextSince = "2026-11-03T18:00:01Z",
            nextId = "q-new",
        )

        assertEquals(listOf("q-new"), repository.refresh().map { it.id })
    }

    @Test
    fun `без привязки refresh падает unauthorized, а flush не теряет очередь`() = runBlocking {
        settings.write(RelaySettings(relayUrl = "https://relay.test"))

        try {
            repository.refresh()
            throw AssertionError("ожидали RelayException")
        } catch (e: RelayException) {
            assertEquals(RelayException.Kind.Unauthorized, e.kind)
        }

        val report = repository.flush()
        assertEquals("устройство не привязано к релею", report.lastError)
    }

    @Test
    fun `ответ требует вариант или текст`() = runBlocking {
        try {
            repository.answer(question("q-1"), selected = emptyList(), custom = "   ")
            throw AssertionError("ожидали IllegalArgumentException")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message!!.contains("вариант"))
        }
    }

    private companion object {
        const val KEY = "idem-0000-0000-0000-000000000001"
    }
}
