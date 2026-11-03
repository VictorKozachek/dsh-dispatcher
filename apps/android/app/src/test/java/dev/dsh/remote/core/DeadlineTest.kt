package dev.dsh.remote.core

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Test

class DeadlineTest {

    private val now = Instant.parse("2026-11-03T18:00:00Z")

    @Test
    fun `секунды минуты и часы`() {
        assertEquals("30 с", Deadline.remainingText(now.plusSeconds(30), now))
        assertEquals("12 мин", Deadline.remainingText(now.plusSeconds(12 * 60), now))
        assertEquals("1 ч 5 мин", Deadline.remainingText(now.plusSeconds(65 * 60), now))
    }

    @Test
    fun `истёкший вопрос`() {
        assertEquals(Deadline.EXPIRED, Deadline.remainingText(now.minusSeconds(1), now))
        assertEquals(Deadline.EXPIRED, Deadline.remainingText(now, now))
    }

    @Test
    fun `без метки дедлайна`() {
        assertEquals(Deadline.NO_DEADLINE, Deadline.remainingText(null, now))
    }
}
