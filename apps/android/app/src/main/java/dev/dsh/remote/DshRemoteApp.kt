package dev.dsh.remote

import android.app.Application
import dev.dsh.remote.work.AnswerFlushWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class DshRemoteApp : Application() {

    val container: AppContainer by lazy { AppContainer(this) }

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onCreate() {
        super.onCreate()
        // Прогрев зашифрованных настроек — вне главного потока, чтобы первый кадр
        // не ждал дискового I/O..
        appScope.launch { container.settings.snapshot() }
        // Без FCM единственный background-канал — периодическая проверка (см. README).
        AnswerFlushWorker.schedulePeriodicCheck(this)
    }
}
