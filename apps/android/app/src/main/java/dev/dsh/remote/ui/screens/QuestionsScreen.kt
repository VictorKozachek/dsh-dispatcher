package dev.dsh.remote.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.dsh.remote.R
import dev.dsh.remote.core.Deadline
import dev.dsh.remote.core.Timestamps
import dev.dsh.remote.domain.model.Question
import dev.dsh.remote.ui.QuestionsViewModel
import kotlinx.coroutines.delay
import java.time.Instant

/**
 * Открытые вопросы: воркспейс, задача, дедлайн. Состояние соединения и число
 * неотправленных ответов видны сразу — по ним понятно, почему вопрос «завис».
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuestionsScreen(
    viewModel: QuestionsViewModel,
    onOpenQuestion: (Question) -> Unit,
    onOpenClosed: () -> Unit,
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val context = LocalContext.current

    LaunchedEffect(viewModel) {
        viewModel.messages.collect { message ->
            snackbarHostState.showSnackbar(message.toText(context))
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.questions_title)) },
                actions = {
                    TextButton(onClick = onOpenClosed) {
                        Text(stringResource(R.string.questions_closed_tab))
                    }
                },
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .padding(innerPadding)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!state.connected) {
                Text(
                    text = stringResource(R.string.questions_connection_offline),
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
            if (state.pendingAnswers > 0) {
                Text(
                    text = stringResource(R.string.questions_pending_answers, state.pendingAnswers),
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }
            state.error?.let { error ->
                Text(
                    text = error,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 16.dp),
                )
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Button(onClick = viewModel::refresh, enabled = !state.loading) {
                    Text(stringResource(R.string.questions_refresh))
                }
                if (state.loading) {
                    CircularProgressIndicator(modifier = Modifier.padding(8.dp))
                }
            }

            if (state.questions.isEmpty()) {
                Text(
                    text = stringResource(R.string.questions_empty),
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(16.dp),
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth(),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
                ) {
                    items(items = state.questions, key = { question -> question.id }) { question ->
                        QuestionCard(question = question, onClick = { onOpenQuestion(question) })
                    }
                }
            }
        }
    }
}

@Composable
private fun QuestionCard(question: Question, onClick: () -> Unit) {
    val expiresAt = remember(question.expiresAt) { Timestamps.parse(question.expiresAt) }
    val remaining by produceState(
        initialValue = Deadline.remainingText(expiresAt, Instant.now()),
        key1 = question.id,
    ) {
        while (true) {
            value = Deadline.remainingText(expiresAt, Instant.now())
            delay(1_000)
        }
    }

    ElevatedCard(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            question.title?.takeIf { it.isNotBlank() }?.let { title ->
                Text(text = title, style = MaterialTheme.typography.titleMedium)
            } ?: question.shortId?.let { shortId ->
                Text(
                    text = stringResource(R.string.questions_short_id, shortId),
                    style = MaterialTheme.typography.titleMedium,
                )
            }

            question.workspace?.let { workspace ->
                Text(
                    text = stringResource(R.string.questions_workspace, workspace),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            question.taskId?.let { taskId ->
                Text(
                    text = stringResource(R.string.questions_task, taskId),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            question.role?.let { role ->
                Text(
                    text = stringResource(R.string.questions_role, role),
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Text(
                text = stringResource(R.string.questions_expires_in, remaining),
                style = MaterialTheme.typography.bodySmall,
                color = if (remaining == Deadline.EXPIRED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            )
        }
    }
}

private fun QuestionsViewModel.Message.toText(context: android.content.Context): String = when (this) {
    QuestionsViewModel.Message.AnswerSent -> context.getString(R.string.question_answer_sent)
    QuestionsViewModel.Message.AnswerQueued -> context.getString(R.string.question_answer_queued)
    QuestionsViewModel.Message.AnswerRejected -> context.getString(R.string.question_answer_conflict)
    is QuestionsViewModel.Message.Failed -> context.getString(R.string.question_answer_failed, text)
}
