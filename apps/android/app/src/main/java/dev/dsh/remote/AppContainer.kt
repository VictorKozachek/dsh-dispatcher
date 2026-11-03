package dev.dsh.remote

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import dev.dsh.remote.domain.AnswerStore
import dev.dsh.remote.domain.QuestionsRepository
import dev.dsh.remote.domain.SettingsStore
import dev.dsh.remote.storage.AndroidDeviceKeyProvider
import dev.dsh.remote.storage.DeviceKeyProvider
import dev.dsh.remote.storage.EncryptedSettingsStore
import dev.dsh.remote.storage.FileAnswerOutbox
import dev.dsh.remote.sync.AnswerSyncScheduler
import dev.dsh.remote.transport.HttpRelayTransport
import dev.dsh.remote.transport.RelayTransport
import dev.dsh.remote.work.AnswerFlushWorker
import java.io.File

/**
 * Ручная сборка зависимостей: приложение маленькое, DI-фреймворк тут дороже пользы.
 * Здесь же единственное место, где Android-типы (Context) встречаются с доменом.
 */
class AppContainer(context: Context) {

    private val appContext: Context = context.applicationContext

    /** Токен и настройки — в EncryptedSharedPreferences (ключ в Android Keystore). */
    val settings: SettingsStore = EncryptedSettingsStore(appContext)

    /** Оффлайн-очередь ответов: переживает рестарт приложения и потерю сети. */
    val answers: AnswerStore = FileAnswerOutbox(File(appContext.filesDir, "answers.json"))

    val deviceKeys: DeviceKeyProvider = AndroidDeviceKeyProvider(appContext)

    val transport: RelayTransport = HttpRelayTransport(baseUrlProvider = { settings.snapshot().relayUrl })

    val repository: QuestionsRepository = QuestionsRepository(
        transport = transport,
        settings = settings,
        answers = answers,
    )

    val syncScheduler: AnswerSyncScheduler = WorkManagerAnswerSyncScheduler(appContext)
}

/** Постановка отправки очереди в `WorkManager`: только по появлению сети. */
class WorkManagerAnswerSyncScheduler(private val context: Context) : AnswerSyncScheduler {

    override fun scheduleFlush() {
        val request = OneTimeWorkRequestBuilder<AnswerFlushWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE_WORK_NAME, ExistingWorkPolicy.KEEP, request)
    }

    companion object {
        const val UNIQUE_WORK_NAME = "answer-flush"
    }
}
