package dev.dsh.remote.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.dsh.remote.R
import dev.dsh.remote.domain.OutboxEntry
import dev.dsh.remote.domain.OutboxState
import dev.dsh.remote.ui.ClosedViewModel

/** «Закрытые»: история ответов устройства, включая те, что ещё ждут сеть. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ClosedScreen(viewModel: ClosedViewModel, onBack: () -> Unit) {
    val entries by viewModel.entries.collectAsStateWithLifecycle()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.closed_title)) },
                navigationIcon = {
                    TextButton(onClick = onBack) { Text(stringResource(R.string.question_back)) }
                },
            )
        },
    ) { innerPadding ->
        if (entries.isEmpty()) {
            Text(
                text = stringResource(R.string.closed_empty),
                modifier = Modifier
                    .padding(innerPadding)
                    .padding(16.dp),
            )
            return@Scaffold
        }

        LazyColumn(
            modifier = Modifier
                .padding(innerPadding)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        ) {
            items(items = entries, key = { entry -> entry.idempotencyKey }) { entry ->
                ClosedEntryCard(entry = entry)
            }
        }
    }
}

@Composable
private fun ClosedEntryCard(entry: OutboxEntry) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                text = entry.questionTitle ?: entry.questionShortId?.let { stringResource(R.string.questions_short_id, it) }
                    ?: entry.questionId,
                style = MaterialTheme.typography.titleSmall,
            )
            entry.workspace?.let { workspace ->
                Text(stringResource(R.string.questions_workspace, workspace), style = MaterialTheme.typography.bodySmall)
            }
            if (entry.selected.isNotEmpty()) {
                Text(
                    stringResource(R.string.closed_answer_selected, entry.selected.joinToString(", ")),
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            entry.custom?.takeIf { it.isNotBlank() }?.let { custom ->
                Text(stringResource(R.string.closed_answer_custom, custom), style = MaterialTheme.typography.bodySmall)
            }
            Text(
                text = stringResource(entry.state.labelRes()),
                style = MaterialTheme.typography.bodySmall,
                color = when (entry.state) {
                    OutboxState.SENT -> MaterialTheme.colorScheme.primary
                    OutboxState.PENDING -> MaterialTheme.colorScheme.secondary
                    OutboxState.REJECTED -> MaterialTheme.colorScheme.error
                },
            )
            entry.lastError?.let { error ->
                Text(
                    text = stringResource(R.string.closed_last_error, error),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

private fun OutboxState.labelRes(): Int = when (this) {
    OutboxState.SENT -> R.string.closed_state_sent
    OutboxState.PENDING -> R.string.closed_state_pending
    OutboxState.REJECTED -> R.string.closed_state_rejected
}
