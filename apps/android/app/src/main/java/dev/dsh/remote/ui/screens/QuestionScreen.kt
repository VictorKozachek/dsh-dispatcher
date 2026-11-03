package dev.dsh.remote.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import dev.dsh.remote.R
import dev.dsh.remote.core.Deadline
import dev.dsh.remote.core.Timestamps
import dev.dsh.remote.domain.model.Question
import java.time.Instant
import kotlinx.coroutines.delay

/**
 * Экран вопроса: варианты кнопками (одиночный/множественный выбор), свободный
 * текст, дедлайн. Ответ уходит через репозиторий и сначала ложится в оффлайн-очередь,
 * поэтому кнопка работает и без сети.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuestionScreen(
    question: Question,
    onSend: (List<String>, String?) -> Unit,
    onBack: () -> Unit,
) {
    var selected by remember(question.id) { mutableStateOf(emptySet<String>()) }
    var customText by remember(question.id) { mutableStateOf("") }

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
    val expired = remaining == Deadline.EXPIRED

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(question.title ?: question.shortId ?: stringResource(R.string.questions_title)) },
                navigationIcon = {
                    TextButton(onClick = onBack) { Text(stringResource(R.string.question_back)) }
                },
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .padding(innerPadding)
                .padding(16.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            question.workspace?.let { workspace ->
                Text(stringResource(R.string.questions_workspace, workspace), style = MaterialTheme.typography.bodySmall)
            }
            question.taskId?.let { taskId ->
                Text(stringResource(R.string.questions_task, taskId), style = MaterialTheme.typography.bodySmall)
            }
            question.role?.let { role ->
                Text(stringResource(R.string.questions_role, role), style = MaterialTheme.typography.bodySmall)
            }

            Text(
                text = if (expired) {
                    stringResource(R.string.question_expired)
                } else {
                    stringResource(R.string.questions_expires_in, remaining)
                },
                color = if (expired) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyMedium,
            )

            if (question.isEncrypted) {
                // Тело в конверте: расшифровка — задача 021. Честно показываем
                // метаданные и не даём отправить «пустой» ответ.
                Text(stringResource(R.string.question_encrypted), color = MaterialTheme.colorScheme.error)
                return@Column
            }

            question.body?.takeIf { it.isNotBlank() }?.let { body ->
                Text(body, style = MaterialTheme.typography.bodyLarge)
            }
            question.detail?.takeIf { it.isNotBlank() }?.let { detail ->
                Text(detail, style = MaterialTheme.typography.bodyMedium)
            }

            if (question.options.isEmpty()) {
                Text(stringResource(R.string.question_no_options), style = MaterialTheme.typography.bodyMedium)
            } else {
                if (question.multiSelect) {
                    Text(stringResource(R.string.question_multiselect_hint), style = MaterialTheme.typography.bodySmall)
                }
                question.options.forEach { option ->
                    val isSelected = option.id in selected
                    FilterChip(
                        selected = isSelected,
                        onClick = {
                            selected = if (question.multiSelect) {
                                if (isSelected) selected - option.id else selected + option.id
                            } else {
                                setOf(option.id)
                            }
                        },
                        label = { Text(option.label) },
                        enabled = !expired,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            if (question.allowFreeText || question.options.isEmpty()) {
                OutlinedTextField(
                    value = customText,
                    onValueChange = { customText = it },
                    label = { Text(stringResource(R.string.question_free_text)) },
                    enabled = !expired,
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2,
                )
            }

            Button(
                onClick = { onSend(selected.toList(), customText.takeIf { it.isNotBlank() }) },
                enabled = !expired && (selected.isNotEmpty() || customText.isNotBlank()),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.question_send))
            }
        }
    }
}
