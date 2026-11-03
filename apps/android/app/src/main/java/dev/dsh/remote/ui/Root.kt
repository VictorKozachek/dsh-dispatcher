package dev.dsh.remote.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.dsh.remote.AppContainer
import dev.dsh.remote.domain.model.Question
import dev.dsh.remote.ui.screens.ClosedScreen
import dev.dsh.remote.ui.screens.PairingScreen
import dev.dsh.remote.ui.screens.QuestionScreen
import dev.dsh.remote.ui.screens.QuestionsScreen

/** Навигация без библиотеки: три экрана и одно состояние — этого достаточно для MVP. */
@Composable
fun Root(container: AppContainer) {
    val settingsFlow = remember(container) { container.settings.observe() }
    val initialSettings = remember(container) { container.settings.snapshot() }
    val settings by settingsFlow.collectAsStateWithLifecycle(initialValue = initialSettings)

    if (!settings.isPaired) {
        val pairingViewModel: PairingViewModel = viewModel {
            PairingViewModel(container.transport, container.settings, container.deviceKeys)
        }
        PairingScreen(viewModel = pairingViewModel)
        return
    }

    val questionsViewModel: QuestionsViewModel = viewModel {
        QuestionsViewModel(
            repository = container.repository,
            transport = container.transport,
            settings = container.settings,
            syncScheduler = container.syncScheduler,
        )
    }
    val closedViewModel: ClosedViewModel = viewModel { ClosedViewModel(container.repository) }

    var route by remember { mutableStateOf<Route>(Route.Open) }
    when (val current = route) {
        Route.Open -> QuestionsScreen(
            viewModel = questionsViewModel,
            onOpenQuestion = { question -> route = Route.Detail(question) },
            onOpenClosed = { route = Route.Closed },
        )

        is Route.Detail -> QuestionScreen(
            question = current.question,
            onSend = { selected, custom ->
                questionsViewModel.answer(current.question, selected, custom)
                route = Route.Open
            },
            onBack = { route = Route.Open },
        )

        Route.Closed -> ClosedScreen(viewModel = closedViewModel, onBack = { route = Route.Open })
    }
}

private sealed interface Route {
    data object Open : Route
    data class Detail(val question: Question) : Route
    data object Closed : Route
}
