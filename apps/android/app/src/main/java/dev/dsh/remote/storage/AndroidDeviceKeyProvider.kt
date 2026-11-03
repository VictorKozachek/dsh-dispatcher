package dev.dsh.remote.storage

import android.content.Context
import dev.dsh.remote.core.DeviceKeys

/** Публичный ключ устройства (и его приватная половина) в Keystore-хранилище. */
interface DeviceKeyProvider {
    fun publicKeyBase64(): String
}

class AndroidDeviceKeyProvider(context: Context) : DeviceKeyProvider {

    private val secrets = KeystoreSecretStore(context, FILE_NAME)

    @Synchronized
    override fun publicKeyBase64(): String {
        secrets.read(KEY_PUBLIC)?.let { return it }

        // Ключ устройства нужен для регистрации (`DeviceCreateRequest.publicKey`):
        // без него повторная регистрация создала бы новое устройство.
        val material = DeviceKeys.generate()
        secrets.write(KEY_PUBLIC, material.publicKeyBase64)
        secrets.write(KEY_PRIVATE, material.privateKeyBase64)
        secrets.write(KEY_ALGORITHM, material.algorithm)
        return material.publicKeyBase64
    }

    private companion object {
        const val FILE_NAME = "device_keys"
        const val KEY_PUBLIC = "public_key"
        const val KEY_PRIVATE = "private_key"
        const val KEY_ALGORITHM = "algorithm"
    }
}
