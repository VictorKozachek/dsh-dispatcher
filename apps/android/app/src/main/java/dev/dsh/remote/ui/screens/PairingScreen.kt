package dev.dsh.remote.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.dsh.remote.R
import dev.dsh.remote.ui.PairingViewModel

/**
 * Экран привязки: адрес релея + одноразовый `pairCode`, который плагин показывает
 * человеку (`POST /v1/pairing`). После успеха токен лежит в EncryptedSharedPreferences.
 */
@Composable
fun PairingScreen(viewModel: PairingViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    Scaffold { innerPadding ->
        Column(
            modifier = Modifier
                .padding(innerPadding)
                .padding(24.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                text = stringResource(R.string.pairing_title),
                style = MaterialTheme.typography.headlineSmall,
            )

            OutlinedTextField(
                value = state.relayUrl,
                onValueChange = viewModel::onRelayUrlChange,
                label = { Text(stringResource(R.string.pairing_hint_relay)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = state.pairCode,
                onValueChange = viewModel::onPairCodeChange,
                label = { Text(stringResource(R.string.pairing_hint_code)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                modifier = Modifier.fillMaxWidth(),
            )

            state.error?.let { error ->
                Text(
                    text = stringResource(error.messageRes()),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            Button(
                onClick = viewModel::startPairing,
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = if (state.busy) {
                        stringResource(R.string.pairing_busy)
                    } else {
                        stringResource(R.string.pairing_action)
                    },
                )
            }
        }
    }
}

private fun PairingViewModel.Error.messageRes(): Int = when (this) {
    PairingViewModel.Error.INVALID_URL -> R.string.pairing_error_invalid_url
    PairingViewModel.Error.INVALID_CODE -> R.string.pairing_error_invalid_code
    PairingViewModel.Error.NETWORK -> R.string.pairing_error_network
    PairingViewModel.Error.CODE_EXPIRED -> R.string.pairing_error_code_expired
    PairingViewModel.Error.CODE_USED -> R.string.pairing_error_code_used
    PairingViewModel.Error.UNKNOWN -> R.string.pairing_error_unknown
}
