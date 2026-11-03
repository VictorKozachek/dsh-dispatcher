package dev.dsh.remote.sync

/**
 * Планировщик отправки оффлайн-очереди. Отделён интерфейсом, чтобы ViewModel
 * не зависел от `androidx.work` и тестировался на JVM.
 */
interface AnswerSyncScheduler {
    /** Разбудить отправку очереди, когда появится сеть (идемпотентно). */
    fun scheduleFlush()
}
