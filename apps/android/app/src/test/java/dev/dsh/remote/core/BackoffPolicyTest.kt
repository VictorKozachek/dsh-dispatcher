package dev.dsh.remote.core

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BackoffPolicyTest {

    @Test
    fun `пауза растёт экспоненциально и упирается в потолок`() {
        val policy = BackoffPolicy(initialMs = 1_000, maxMs = 30_000, jitterRatio = 0.0)

        assertEquals(1_000, policy.delayForAttempt(1))
        assertEquals(2_000, policy.delayForAttempt(2))
        assertEquals(4_000, policy.delayForAttempt(3))
        assertEquals(8_000, policy.delayForAttempt(4))
        assertEquals(16_000, policy.delayForAttempt(5))
        assertEquals(30_000, policy.delayForAttempt(6))
        assertEquals(30_000, policy.delayForAttempt(1_000))
    }

    @Test
    fun `jitter не выходит за границы`() {
        val policy = BackoffPolicy(initialMs = 1_000, maxMs = 30_000, jitterRatio = 0.2, random = Random(42))

        repeat(200) {
            val delay = policy.delayForAttempt(5) // 16 000 ± 20 %
            assertTrue("пауза вне границ: $delay", delay in 12_800..19_200)
        }
    }

    @Test
    fun `пауза не превышает потолок даже с jitter`() {
        val policy = BackoffPolicy(initialMs = 1_000, maxMs = 30_000, jitterRatio = 0.5, random = Random(1))

        repeat(200) {
            assertTrue(policy.delayForAttempt(10) <= 30_000)
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun `нулевая попытка — ошибка`() {
        BackoffPolicy().delayForAttempt(0)
    }

    @Test
    fun `детерминированная политика повторяет серию ретраев транспорта`() {
        val policy = BackoffPolicy.deterministic(initialMs = 10, maxMs = 20)
        assertEquals(10, policy.delayForAttempt(1))
        assertEquals(20, policy.delayForAttempt(2))
        assertEquals(20, policy.delayForAttempt(3))
    }
}
