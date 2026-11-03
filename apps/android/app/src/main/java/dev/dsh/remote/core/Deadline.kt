package dev.dsh.remote.core

import java.time.Duration
import java.time.Instant

/** Человеческий дедлайн вопроса: «12 мин», «1 ч 5 мин», «истёк». */
object Deadline {

    fun remainingText(expiresAt: Instant?, now: Instant): String {
        val expires = expiresAt ?: return NO_DEADLINE
        val seconds = Duration.between(now, expires).seconds
        return when {
            seconds <= 0 -> EXPIRED
            seconds < 60 -> "$seconds с"
            seconds < 3_600 -> "${seconds / 60} мин"
            else -> "${seconds / 3_600} ч ${(seconds % 3_600) / 60} мин"
        }
    }

    const val NO_DEADLINE = "—"
    const val EXPIRED = "истёк"
}
