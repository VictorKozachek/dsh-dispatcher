package dev.dsh.remote.storage

import dev.dsh.remote.domain.AnswerStore
import dev.dsh.remote.domain.OutboxEntry
import dev.dsh.remote.domain.OutboxState
import dev.dsh.remote.transport.RelayJson
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Очередь ответов в JSON-файле внутри `filesDir` приложения.
 *
 * Почему файл, а не Room: очередь крошечная (несколько записей), зависимость и
 * схема миграций тут дороже пользы, а запись атомарна через `rename` — падение
 * посреди сохранения не оставляет половину JSON.
 *
 * Все операции идут под мьютексом: `WorkManager` и UI могут писать одновременно.
 */
class FileAnswerOutbox(
    private val file: File,
    private val json: Json = RelayJson,
) : AnswerStore {

    private val mutex = Mutex()
    private val state = MutableStateFlow<List<OutboxEntry>?>(null)

    override fun observe(): Flow<List<OutboxEntry>> = flow {
        emit(read())
        emitAll(state.filterNotNull())
    }

    override suspend fun entries(): List<OutboxEntry> = snapshot()

    override suspend fun pending(): List<OutboxEntry> = snapshot().filter { it.state == OutboxState.PENDING }

    override suspend fun put(entry: OutboxEntry) {
        mutate { current -> current.filterNot { it.idempotencyKey == entry.idempotencyKey } + entry }
    }

    override suspend fun update(entry: OutboxEntry) {
        mutate { current ->
            current.map { existing -> if (existing.idempotencyKey == entry.idempotencyKey) entry else existing }
        }
    }

    private suspend fun snapshot(): List<OutboxEntry> = mutex.withLock { loadLocked() }

    private suspend fun read(): List<OutboxEntry> = snapshot()

    private suspend fun mutate(transform: (List<OutboxEntry>) -> List<OutboxEntry>) {
        mutex.withLock {
            val updated = transform(loadLocked())
            writeLocked(updated)
        }
    }

    private fun loadLocked(): List<OutboxEntry> {
        state.value?.let { return it }
        val loaded = readFile()
        state.value = loaded
        return loaded
    }

    private fun readFile(): List<OutboxEntry> {
        if (!file.exists()) return emptyList()
        return runCatching {
            json.decodeFromString(OutboxFile.serializer(), file.readText()).entries
        }.getOrElse {
            // Битый файл не должен блокировать приложение: очередь начинается заново,
            // а сломанный файл оставляем рядом для разбора (не перезаписываем молча).
            file.renameTo(File(file.parentFile, file.name + ".broken"))
            emptyList()
        }
    }

    private fun writeLocked(entries: List<OutboxEntry>) {
        file.parentFile?.mkdirs()
        val temp = File(file.parentFile, file.name + ".tmp")
        temp.writeText(json.encodeToString(OutboxFile.serializer(), OutboxFile(entries = entries)))
        Files.move(temp.toPath(), file.toPath(), StandardCopyOption.REPLACE_EXISTING)
        state.value = entries
    }

    @Serializable
    private data class OutboxFile(
        val version: Int = 1,
        val entries: List<OutboxEntry> = emptyList(),
    )
}
