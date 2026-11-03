//
//  Secrets.swift
//  RelayKit — хранение токена устройства.
//
//  Токен привязки — секрет: он живёт только в Keychain (на устройстве), не в
//  UserDefaults и не в файлах. Протокол позволяет хранить URL и deviceId открыто.
//

import Foundation
#if canImport(Security)
import Security
#endif

/// Хранилище секретов: в тестах — in-memory, в приложении — Keychain.
public protocol SecretStore: Sendable {
    func save(_ value: String, for key: String) throws
    func read(_ key: String) throws -> String?
    func delete(_ key: String) throws
}

public enum SecretStoreError: Error, Equatable {
    case keychain(OSStatus)
    case unexpectedData
}

#if canImport(Security)
/// Keychain-хранилище MVP: одна запись на ключ, доступ после первой разблокировки.
public struct KeychainStore: SecretStore {
    public let service: String

    public init(service: String = "dev.dsh.relay") {
        self.service = service
    }

    private func query(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    public func save(_ value: String, for key: String) throws {
        let data = Data(value.utf8)
        var attributes = query(for: key)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let updateStatus = SecItemUpdate(
                query(for: key) as CFDictionary,
                [kSecValueData as String: data] as CFDictionary
            )
            guard updateStatus == errSecSuccess else { throw SecretStoreError.keychain(updateStatus) }
            return
        }
        guard status == errSecSuccess else { throw SecretStoreError.keychain(status) }
    }

    public func read(_ key: String) throws -> String? {
        var attributes = query(for: key)
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SecretStoreError.keychain(status) }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            throw SecretStoreError.unexpectedData
        }
        return value
    }

    public func delete(_ key: String) throws {
        let status = SecItemDelete(query(for: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SecretStoreError.keychain(status)
        }
    }
}
#endif

/// In-memory хранилище для тестов и превью.
public final class InMemorySecretStore: SecretStore, @unchecked Sendable {
    private var values: [String: String] = [:]
    private let lock = NSLock()

    public init(values: [String: String] = [:]) {
        self.values = values
    }

    public func save(_ value: String, for key: String) throws {
        lock.lock(); defer { lock.unlock() }
        values[key] = value
    }

    public func read(_ key: String) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        return values[key]
    }

    public func delete(_ key: String) throws {
        lock.lock(); defer { lock.unlock() }
        values.removeValue(forKey: key)
    }
}
