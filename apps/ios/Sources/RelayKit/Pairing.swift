//
//  Pairing.swift
//  RelayKit — состояние привязки устройства.
//
//  Хранение: URL и deviceId — в UserDefaults (не секрет), deviceToken — в Keychain.
//

import Foundation

public struct StoredPairing: Codable, Equatable, Sendable {
    public let baseURL: URL
    public let deviceId: String

    public init(baseURL: URL, deviceId: String) {
        self.baseURL = baseURL
        self.deviceId = deviceId
    }
}

public protocol PairingStorage: Sendable {
    func load() -> StoredPairing?
    func save(_ pairing: StoredPairing?) throws
}

public final class UserDefaultsPairingStorage: PairingStorage, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key = "relay.pairing"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> StoredPairing? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(StoredPairing.self, from: data)
    }

    public func save(_ pairing: StoredPairing?) throws {
        if let pairing {
            defaults.set(try JSONEncoder().encode(pairing), forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}

public final class InMemoryPairingStorage: PairingStorage, @unchecked Sendable {
    private var value: StoredPairing?
    private let lock = NSLock()

    public init(value: StoredPairing? = nil) {
        self.value = value
    }

    public func load() -> StoredPairing? {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    public func save(_ pairing: StoredPairing?) throws {
        lock.lock(); defer { lock.unlock() }
        value = pairing
    }
}

/// Привязка: зарегистрировать устройство, обменять код на токен, сохранить.
public final class PairingService: @unchecked Sendable {
    public static let tokenKey = "relay.deviceToken"

    private let apiFactory: @Sendable (URL) -> RelayAPI
    private let secrets: SecretStore
    private let storage: PairingStorage

    public init(
        apiFactory: @escaping @Sendable (URL) -> RelayAPI,
        secrets: SecretStore,
        storage: PairingStorage
    ) {
        self.apiFactory = apiFactory
        self.secrets = secrets
        self.storage = storage
    }

    public var current: StoredPairing? { storage.load() }

    public func currentToken() -> String? {
        try? secrets.read(Self.tokenKey)
    }

    /// Привязать: публичный ключ → POST /v1/devices → POST /v1/pair → Keychain.
    public func pair(baseURL: URL, pairCode: String) async throws -> StoredPairing {
        let api = apiFactory(baseURL)
        let publicKey = Self.devicePublicKey()
        let deviceId = try await api.registerDevice(publicKey: publicKey)
        let pairing = try await api.pair(pairCode: pairCode, deviceId: deviceId)
        try secrets.save(pairing.deviceToken, for: Self.tokenKey)
        let stored = StoredPairing(baseURL: baseURL, deviceId: deviceId)
        try storage.save(stored)
        return stored
    }

    public func unpair() throws {
        try secrets.delete(Self.tokenKey)
        try storage.save(nil)
    }

    /// MVP: ключ — случайные 32 байта в base64 (задел под e2e-021).
    nonisolated static func devicePublicKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        for index in bytes.indices {
            bytes[index] = UInt8.random(in: 0...255)
        }
        return Data(bytes).base64EncodedString()
    }
}
