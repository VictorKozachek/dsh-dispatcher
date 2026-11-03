package dev.dsh.remote.core

import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/** Работа с временем на проводе: RFC 3339 (`2026-11-03T18:00:00Z`), как в §2 контракта. */
object Timestamps {

    private val formatter: DateTimeFormatter = DateTimeFormatter.ISO_INSTANT

    /** Разбирает метку релея; неразборчивая метка — `null` (вопрос без дедлайна не показываем как истёкший). */
    fun parse(value: String?): Instant? {
        if (value.isNullOrBlank()) return null
        return runCatching { Instant.parse(value) }.getOrNull()
    }

    fun format(instant: Instant): String = formatter.format(instant.truncatedTo(ChronoUnit.SECONDS))
}
