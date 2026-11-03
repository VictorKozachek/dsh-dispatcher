package dev.dsh.remote.core

import kotlin.math.min
import kotlin.random.Random

/**
 * Экспоненциальная пауза с потолком и jitter — общая для HTTP-ретраев (§4 контракта:
 * 1, 2, 4, 8, 16 с, максимум 5 попыток) и переподключения WebSocket (§3: 1 с → 30 с с jitter).
 *
 * Номер попытки нумеруется с 1: `delayForAttempt(1) == initialMs` (± jitter).
 */
class BackoffPolicy(
    private val initialMs: Long = 1_000L,
    private val maxMs: Long = 30_000L,
    private val multiplier: Double = 2.0,
    private val jitterRatio: Double = 0.2,
    private val random: Random = Random.Default,
) {

    init {
        require(initialMs > 0) { "initialMs должен быть > 0" }
        require(maxMs >= initialMs) { "maxMs должен быть >= initialMs" }
        require(multiplier > 1.0) { "multiplier должен быть > 1" }
        require(jitterRatio in 0.0..1.0) { "jitterRatio должен быть в 0..1" }
    }

    fun delayForAttempt(attempt: Int): Long {
        require(attempt >= 1) { "attempt нумеруется с 1" }
        var base = initialMs.toDouble()
        var index = 1
        while (index < attempt && base < maxMs) {
            base *= multiplier
            index++
        }
        val capped = min(base, maxMs.toDouble())
        if (jitterRatio == 0.0) return capped.toLong().coerceAtMost(maxMs)

        val jitter = capped * jitterRatio * (random.nextDouble() * 2.0 - 1.0)
        return (capped + jitter).toLong().coerceIn(1L, maxMs)
    }

    companion object {
        /** Политика без jitter — для тестов и для мест, где нужна предсказуемость. */
        fun deterministic(initialMs: Long = 1_000L, maxMs: Long = 30_000L): BackoffPolicy =
            BackoffPolicy(initialMs = initialMs, maxMs = maxMs, jitterRatio = 0.0)
    }
}
