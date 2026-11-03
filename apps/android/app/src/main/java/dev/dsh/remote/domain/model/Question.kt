package dev.dsh.remote.domain.model

import kotlinx.serialization.Serializable

/** Вариант ответа: на проводе — `{id, label}` (см. `QuestionOption` в `docs/relay/schema.json`). */
@Serializable
data class QuestionOption(
    val id: String,
    val label: String,
)

/**
 * Конверт e2e-режима (`docs/relay/PROTOCOL.md` §6). Приложение MVP показывает
 * метаданные и честно говорит, что расшифровка появится в задаче 021.
 */
@Serializable
data class EncEnvelope(
    val enc: String,
    val nonce: String,
    val keyId: String,
    val alg: String,
    val plainSize: Int,
)

/**
 * Вопрос агента. Ответы релея аддитивны (`additionalProperties: true`), поэтому все
 * необязательные поля имеют значения по умолчанию, а неизвестные ключи JSON
 * отбрасываются настройкой `RelayJson`.
 */
@Serializable
data class Question(
    val id: String,
    val shortId: String? = null,
    val workspace: String? = null,
    val taskId: String? = null,
    val role: String? = null,
    val title: String? = null,
    val body: String? = null,
    val detail: String? = null,
    val options: List<QuestionOption> = emptyList(),
    val optionCount: Int? = null,
    val multiSelect: Boolean = false,
    val allowFreeText: Boolean = false,
    val createdAt: String,
    val expiresAt: String,
    val enc: EncEnvelope? = null,
) {
    val isEncrypted: Boolean get() = enc != null

    /** Сколько вариантов рисовать: в e2e-режиме подписей нет, остаётся только счётчик. */
    val effectiveOptionCount: Int get() = if (isEncrypted) optionCount ?: 0 else options.size
}

/** Страница `GET /v1/questions`: курсор `nextSince`/`nextId` (аддитивное поле из 023). */
data class QuestionPage(
    val questions: List<Question>,
    val nextSince: String?,
    val nextId: String?,
)

/** Курсор пагинации: `(createdAt, id)`, повтор с ним идемпотентен (§3 контракта). */
data class QuestionCursor(
    val since: String? = null,
    val sinceId: String? = null,
)
