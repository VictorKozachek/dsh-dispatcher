package dev.dsh.remote.work

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dev.dsh.remote.DshRemoteApp
import dev.dsh.remote.notifications.QuestionNotifier
import java.util.concurrent.TimeUnit

/**
 * Отправка оффлайн-очереди ответов.
 *
 * Ставится двух видов:
 * - разово, сразу после того как человек ответил без сети (`AnswerSyncScheduler`);
 * - периодически, вместе с проверкой новых вопросов (без FCM это единственный
 *   background-канал — ограничение описано в README).
 *
 * `Result.retry()` возвращаем, только пока в очереди остались отправляемые ответы:
 * исчерпав попытки, `WorkManager` оставит их до следующей периодической проверки.
 */
class AnswerFlushWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val container = (applicationContext as DshRemoteApp).container
        val report = container.repository.flush()
        return if (report.retryable) {
            Result.retry()
        } else {
            // «Закрытые» и индикатор очереди читают тот же store: UI обновится сам.
            Result.success()
        }
    }

    companion object {
        const val PERIODIC_WORK_NAME = "periodic-check"

        /** Периодическая проверка: `WorkManager` не даёт меньше 15 минут. */
        fun schedulePeriodicCheck(context: Context) {
            val request = PeriodicWorkRequestBuilder<PeriodicCheckWorker>(15, TimeUnit.MINUTES)
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .build()
            WorkManager.getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}

/**
 * Фоновая проверка новых вопросов и досылка ответов.
 *
 * Без FCM: приложение в фоне не держит WebSocket, поэтому узнаёт о вопросах раз в
 * 15 минут (плюс при открытии). Это осознанное ограничение MVP — см. `apps/android/README.md`.
 */
class PeriodicCheckWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val container = (applicationContext as DshRemoteApp).container
        if (!container.settings.snapshot().isPaired) return Result.success()

        val report = container.repository.flush()
        val questions = runCatching { container.repository.refresh(waitSeconds = 0) }.getOrDefault(emptyList())
        if (questions.isNotEmpty()) {
            QuestionNotifier.notifyNewQuestions(applicationContext, questions.size)
        }
        return if (report.retryable) Result.retry() else Result.success()
    }
}
