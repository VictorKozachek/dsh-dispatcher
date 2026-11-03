package dev.dsh.remote.storage

import android.content.Context
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

/**
 * Шифрованное хранилище небольших секретов (токен устройства, приватный ключ).
 *
 * Ключ AES-256 живёт в Android Keystore и наружу не выходит: в `SharedPreferences`
 * лежит только `base64(iv || ciphertext)` с GCM. Своя реализация вместо
 * `androidx.security:security-crypto` — библиотека объявлена deprecated, а нужен
 * ровно один примитив.
 *
 * Запись/чтение синхронизированы: `Cipher` не потокобезопасен.
 */
class KeystoreSecretStore(
    context: Context,
    fileName: String = "secure_settings",
) {

    private val prefs = context.applicationContext.getSharedPreferences(fileName, Context.MODE_PRIVATE)
    private val alias = "${fileName}_key"
    private val cipher = Cipher.getInstance(TRANSFORMATION)

    fun read(key: String): String? {
        val encoded = prefs.getString(key, null) ?: return null
        return synchronized(cipher) {
            runCatching {
                val raw = Base64.decode(encoded, Base64.NO_WRAP)
                require(raw.size > IV_SIZE) { "слишком короткое значение" }
                val iv = raw.copyOfRange(0, IV_SIZE)
                val ciphertext = raw.copyOfRange(IV_SIZE, raw.size)
                cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
                String(cipher.doFinal(ciphertext), Charsets.UTF_8)
            }.getOrNull()
        }
    }

    fun write(key: String, value: String?) {
        if (value == null) {
            prefs.edit().remove(key).apply()
            return
        }
        synchronized(cipher) {
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val payload = cipher.iv + ciphertext
            prefs.edit().putString(key, Base64.encodeToString(payload, Base64.NO_WRAP)).apply()
        }
    }

    private fun secretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_SIZE = 12
        const val TAG_BITS = 128
    }
}
