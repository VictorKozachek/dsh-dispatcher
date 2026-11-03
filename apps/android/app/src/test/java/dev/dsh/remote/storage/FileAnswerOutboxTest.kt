package dev.dsh.remote.storage

import dev.dsh.remote.domain.OutboxEntry
import dev.dsh.remote.domain.OutboxState
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** Оффлайн-очередь на диске: переживает рестарт и не теряет ключ идемпотентности. */
class FileAnswerOutboxTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test
    fun `ответ на диске переживает пересоздание хранилища`() = runBlocking {
        val file = File(tempFolder.root, "answers.json")
        val store = FileAnswerOutbox(file)

        store.put(entry(idempotencyKey = "k-1"))
        assertEquals(1, store.pending().size)

        val reopened = FileAnswerOutbox(file)
        val restored = reopened.entries().single()
        assertEquals("k-1", restored.idempotencyKey)
        assertEquals("q-1", restored.questionId)
        assertEquals(listOf("o1"), restored.selected)
        assertEquals(OutboxState.PENDING, restored.state)
    }

    @Test
    fun `update меняет запись по ключу`() = runBlocking {
        val store = FileAnswerOutbox(File(tempFolder.root, "answers.json"))
        store.put(entry(idempotencyKey = "k-1"))
        store.put(entry(idempotencyKey = "k-2"))

        store.update(entry(idempotencyKey = "k-1").copy(state = OutboxState.SENT, attempts = 1))

        assertEquals(listOf("k-2"), store.pending().map { it.idempotencyKey })
        assertEquals(OutboxState.SENT, store.entries().first { it.idempotencyKey == "k-1" }.state)
    }

    @Test
    fun `put с тем же ключом не плодит дубликаты`() = runBlocking {
        val store = FileAnswerOutbox(File(tempFolder.root, "answers.json"))

        store.put(entry(idempotencyKey = "k-1"))
        store.put(entry(idempotencyKey = "k-1").copy(custom = "уточнили"))

        assertEquals(1, store.entries().size)
        assertEquals("уточнили", store.entries().single().custom)
    }

    @Test
    fun `наблюдение отдаёт загруженную очередь`() = runBlocking {
        val store = FileAnswerOutbox(File(tempFolder.root, "answers.json"))
        store.put(entry(idempotencyKey = "k-1"))

        val observed = store.observe().first()

        assertEquals(1, observed.size)
        assertEquals("k-1", observed.single().idempotencyKey)
    }

    @Test
    fun `битый файл не роняет очередь и сохраняется для разбора`() = runBlocking {
        val file = File(tempFolder.root, "answers.json")
        file.writeText("{ это не json")

        val store = FileAnswerOutbox(file)

        assertTrue(store.entries().isEmpty())
        assertTrue("испорченный файл должен остаться рядом", File(tempFolder.root, "answers.json.broken").exists())
        store.put(entry(idempotencyKey = "k-1"))
        assertEquals(1, store.entries().size)
    }

    @Test
    fun `ключ идемпотентности уникален для каждого ответа`() = runBlocking {
        val store = FileAnswerOutbox(File(tempFolder.root, "answers.json"))

        store.put(entry(idempotencyKey = "k-1", questionId = "q-1"))
        store.put(entry(idempotencyKey = "k-2", questionId = "q-2"))

        assertEquals(setOf("k-1", "k-2"), store.entries().map { it.idempotencyKey }.toSet())
    }

    private fun entry(idempotencyKey: String, questionId: String = "q-1") = OutboxEntry(
        idempotencyKey = idempotencyKey,
        questionId = questionId,
        questionTitle = "Вопрос",
        questionShortId = "a1b2c3d4",
        workspace = "/repo",
        selected = listOf("o1"),
        custom = null,
        answeredAt = "2026-11-03T18:05:00Z",
    )
}
