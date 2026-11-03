package dev.dsh.remote.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.dsh.remote.domain.OutboxEntry
import dev.dsh.remote.domain.QuestionsRepository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn

/** «Закрытые»: история ответов устройства — отправленных, ожидающих и отклонённых. */
class ClosedViewModel(repository: QuestionsRepository) : ViewModel() {

    val entries: StateFlow<List<OutboxEntry>> = repository.observeAnswers()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
}
