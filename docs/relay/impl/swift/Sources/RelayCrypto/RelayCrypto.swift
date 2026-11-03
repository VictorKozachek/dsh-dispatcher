import CryptoKit
import Foundation

/// E2E-шифрование тела вопроса — эталонная реализация на Swift (CryptoKit).
///
/// Повторяет `dsh-remote/lib/crypto.js` (задача 021) и проверяется общими
/// векторами `docs/relay/test-vectors.json`. iOS-клиент (задача 020) переносит
/// этот код в приложение, меняя только хранение ключа (Keychain/Secure Enclave).
///
/// Схема — `docs/relay/CRYPTO.md`:
///   S  = X25519(own_private, peer_public)
///   Kq = HKDF-SHA256(S, salt = "dsh-relay-e2e-v1", info = "question|" + keyId)
///   Ka = HKDF-SHA256(S, salt = "dsh-relay-e2e-v1", info = "answer|"   + keyId)
public enum RelayCrypto {
    public static let cryptoVersion = "dsh-relay-e2e-v1"
    public static let algChaCha20Poly1305 = "xchacha20poly1305"
    public static let algAes256Gcm = "aes256gcm"
    public static let defaultAlg = algChaCha20Poly1305
    public static let supportedAlgs = [algChaCha20Poly1305, algAes256Gcm]

    public static let publicKeyPrefix = "base64:"
    public static let keyIdPrefix = "dpk-"

    public static let nonceBytes = 12
    public static let tagBytes = 16
    public static let maxPlainBytes = 48 * 1024
    public static let maxEncChars = 64 * 1024

    /// Ошибка криптослоя: `code` совпадает с кодами JS и Kotlin реализаций.
    public struct CryptoError: Error, CustomStringConvertible {
        public let code: String
        public let message: String

        public init(code: String, message: String) {
            self.code = code
            self.message = message
        }

        public var description: String { "CryptoError(\(code)): \(message)" }
    }

    public struct KeyPair: Equatable {
        public let privateKey: String
        public let publicKey: String
    }

    public struct Envelope: Codable, Equatable {
        public let enc: String
        public let nonce: String
        public let keyId: String
        public let alg: String
        public let plainSize: Int
    }

    public struct QuestionMeta {
        public let id: String
        public let shortId: String
        public let createdAt: String
        public let expiresAt: String

        public init(id: String, shortId: String, createdAt: String, expiresAt: String) {
            self.id = id
            self.shortId = shortId
            self.createdAt = createdAt
            self.expiresAt = expiresAt
        }
    }

    public struct AnswerMeta {
        public let questionId: String
        public let answeredAt: String
        public let idempotencyKey: String

        public init(questionId: String, answeredAt: String, idempotencyKey: String) {
            self.questionId = questionId
            self.answeredAt = answeredAt
            self.idempotencyKey = idempotencyKey
        }
    }

    public static func generateKeyPair() -> KeyPair {
        let privateKey = Curve25519.KeyAgreement.PrivateKey()
        return KeyPair(
            privateKey: base64url(Data(privateKey.rawRepresentation)),
            publicKey: publicKeyPrefix + Data(privateKey.publicKey.rawRepresentation).base64EncodedString()
        )
    }

    public static func keyId(for publicKey: String) throws -> String {
        let raw = try rawPublicKey(publicKey)
        let digest = SHA256.hash(data: raw)
        return keyIdPrefix + String(base64url(Data(digest)).prefix(16))
    }

    public static func questionAad(_ meta: QuestionMeta, keyId: String, alg: String) -> String {
        "\(cryptoVersion)|question|\(meta.id)|\(meta.shortId)|\(meta.createdAt)|\(meta.expiresAt)|\(keyId)|\(alg)"
    }

    public static func answerAad(_ meta: AnswerMeta, keyId: String, alg: String) -> String {
        "\(cryptoVersion)|answer|\(meta.questionId)|\(meta.answeredAt)|\(meta.idempotencyKey)|\(keyId)|\(alg)"
    }

    /// Криптослой одной пары «плагин ↔ устройство».
    public final class E2e {
        public let keyId: String
        public let alg: String

        private let questionKey: SymmetricKey
        private let answerKey: SymmetricKey

        public init(
            privateKey: String,
            peerPublicKey: String,
            devicePublicKey: String? = nil,
            alg: String = RelayCrypto.defaultAlg,
            keyId: String? = nil
        ) throws {
            try RelayCrypto.requireAlg(alg)
            self.alg = alg
            let shared = try RelayCrypto.sharedSecret(privateKey: privateKey, peerPublicKey: peerPublicKey)
            self.keyId = try keyId ?? RelayCrypto.keyId(for: devicePublicKey ?? peerPublicKey)
            self.questionKey = RelayCrypto.deriveKey(shared, info: "question|\(self.keyId)")
            self.answerKey = RelayCrypto.deriveKey(shared, info: "answer|\(self.keyId)")
        }

        public func sealQuestion(
            _ plaintext: String,
            meta: QuestionMeta,
            nonce: Data? = nil
        ) throws -> Envelope {
            try RelayCrypto.validatePlaintext(plaintext, kind: "question")
            let nonceBytes = try nonce ?? RelayCrypto.randomNonce()
            let aad = RelayCrypto.questionAad(meta, keyId: keyId, alg: alg)
            return try RelayCrypto.seal(
                alg: alg,
                key: questionKey,
                nonce: nonceBytes,
                aad: aad,
                plaintext: plaintext,
                keyId: keyId
            )
        }

        public func openQuestion(_ envelope: Envelope, meta: QuestionMeta) throws -> String {
            let parsed = try RelayCrypto.validateEnvelope(envelope)
            try RelayCrypto.requireKeyId(parsed, expected: keyId)
            let aad = RelayCrypto.questionAad(meta, keyId: parsed.keyId, alg: parsed.alg)
            return try RelayCrypto.open(parsed, key: questionKey, aad: aad)
        }

        public func sealAnswer(
            _ plaintext: String,
            meta: AnswerMeta,
            nonce: Data? = nil
        ) throws -> Envelope {
            try RelayCrypto.validatePlaintext(plaintext, kind: "answer")
            let nonceBytes = try nonce ?? RelayCrypto.randomNonce()
            let aad = RelayCrypto.answerAad(meta, keyId: keyId, alg: alg)
            return try RelayCrypto.seal(
                alg: alg,
                key: answerKey,
                nonce: nonceBytes,
                aad: aad,
                plaintext: plaintext,
                keyId: keyId
            )
        }

        public func openAnswer(_ envelope: Envelope, meta: AnswerMeta) throws -> String {
            let parsed = try RelayCrypto.validateEnvelope(envelope)
            try RelayCrypto.requireKeyId(parsed, expected: keyId)
            let aad = RelayCrypto.answerAad(meta, keyId: parsed.keyId, alg: parsed.alg)
            return try RelayCrypto.open(parsed, key: answerKey, aad: aad)
        }
    }

    // MARK: - Внутреннее

    static func requireAlg(_ alg: String) throws {
        guard supportedAlgs.contains(alg) else {
            throw CryptoError(
                code: "unsupported-alg",
                message: "alg: поддерживаются \(supportedAlgs.joined(separator: " и ")), получено \(alg)"
            )
        }
    }

    static func decodeBase64(_ text: String) throws -> Data {
        guard let data = Data(base64Encoded: text), !data.isEmpty else {
            throw CryptoError(code: "bad-envelope", message: "base64 не декодируется")
        }
        return data
    }

    static func rawPublicKey(_ publicKey: String) throws -> Data {
        var text = publicKey
        if text.hasPrefix(publicKeyPrefix) {
            text = String(text.dropFirst(publicKeyPrefix.count))
        }
        guard !text.isEmpty else {
            throw CryptoError(code: "bad-key", message: "пустой публичный ключ устройства")
        }
        let raw = try decodeBase64(text)
        guard raw.count == 32 else {
            throw CryptoError(
                code: "bad-key",
                message: "публичный ключ X25519 должен быть 32 байта, а не \(raw.count)"
            )
        }
        return raw
    }

    static func sharedSecret(privateKey: String, peerPublicKey: String) throws -> SharedSecret {
        guard let rawPrivate = Data(base64URLEncoded: privateKey), rawPrivate.count == 32 else {
            throw CryptoError(code: "bad-key", message: "приватный ключ должен быть base64url из 32 байт")
        }
        let privateKeyObject: Curve25519.KeyAgreement.PrivateKey
        do {
            privateKeyObject = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: rawPrivate)
        } catch {
            throw CryptoError(code: "bad-key", message: "приватный ключ не разбирается как X25519")
        }
        let publicRaw = try rawPublicKey(peerPublicKey)
        let publicKeyObject: Curve25519.KeyAgreement.PublicKey
        do {
            publicKeyObject = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicRaw)
        } catch {
            throw CryptoError(code: "bad-key", message: "публичный ключ не разбирается как X25519")
        }
        do {
            return try privateKeyObject.sharedSecretFromKeyAgreement(with: publicKeyObject)
        } catch {
            throw CryptoError(code: "bad-key", message: "общий секрет не выводится")
        }
    }

    static func deriveKey(_ secret: SharedSecret, info: String) -> SymmetricKey {
        let ikm = secret.withUnsafeBytes { SymmetricKey(data: Data($0)) }
        return HKDF<SHA256>.deriveKey(
            inputKeyMaterial: ikm,
            salt: Data(cryptoVersion.utf8),
            info: Data(info.utf8),
            outputByteCount: 32
        )
    }

    static func randomNonce() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: nonceBytes)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw CryptoError(code: "bad-envelope", message: "не удалось получить nonce")
        }
        return Data(bytes)
    }

    static func validateEnvelope(_ envelope: Envelope) throws -> Envelope {
        try requireAlg(envelope.alg)
        guard (4...64).contains(envelope.keyId.count) else {
            throw CryptoError(code: "bad-envelope", message: "keyId: ожидалось 4..64 символа")
        }
        let nonce = try decodeBase64(envelope.nonce)
        guard nonce.count == nonceBytes else {
            throw CryptoError(
                code: "bad-envelope",
                message: "nonce: ровно \(nonceBytes) байт (\(nonce.count))"
            )
        }
        guard envelope.enc.count <= maxEncChars else {
            throw CryptoError(
                code: "payload-too-large",
                message: "enc: не больше \(maxEncChars) символов base64"
            )
        }
        let enc = try decodeBase64(envelope.enc)
        guard enc.count >= tagBytes + 1 else {
            throw CryptoError(code: "bad-envelope", message: "enc: пустой конверт")
        }
        guard (0...maxPlainBytes).contains(envelope.plainSize) else {
            throw CryptoError(
                code: "bad-envelope",
                message: "plainSize: ожидалось 0..\(maxPlainBytes)"
            )
        }
        return envelope
    }

    static func requireKeyId(_ envelope: Envelope, expected: String) throws {
        guard envelope.keyId == expected else {
            throw CryptoError(
                code: "key-mismatch",
                message: "конверт зашифрован для другого ключа: \(envelope.keyId) ≠ \(expected)"
            )
        }
    }

    static func validatePlaintext(_ plaintext: String, kind: String) throws {
        let bytes = Data(plaintext.utf8)
        guard bytes.count <= maxPlainBytes else {
            throw CryptoError(
                code: "payload-too-large",
                message: "открытый текст больше \(maxPlainBytes) байт"
            )
        }
        guard let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw CryptoError(code: "bad-plaintext", message: "открытый текст должен быть JSON-объектом")
        }
        if kind == "question" {
            let body = json["body"] as? String ?? ""
            guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw CryptoError(code: "bad-plaintext", message: "тело вопроса: нужен непустой body")
            }
        } else {
            let selected = json["selected"] as? [String] ?? []
            let custom = json["custom"] as? String ?? ""
            guard !selected.isEmpty || !custom.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw CryptoError(
                    code: "bad-plaintext",
                    message: "тело ответа: нужен выбранный вариант или текст"
                )
            }
        }
    }

    static func seal(
        alg: String,
        key: SymmetricKey,
        nonce: Data,
        aad: String,
        plaintext: String,
        keyId: String
    ) throws -> Envelope {
        let plainData = Data(plaintext.utf8)
        guard plainData.count <= maxPlainBytes else {
            throw CryptoError(
                code: "payload-too-large",
                message: "открытый текст больше \(maxPlainBytes) байт"
            )
        }
        let aadData = Data(aad.utf8)
        let sealed: Data
        do {
            if alg == algAes256Gcm {
                let nonceObject = try AES.GCM.Nonce(data: nonce)
                let box = try AES.GCM.seal(plainData, using: key, nonce: nonceObject, authenticating: aadData)
                sealed = box.ciphertext + box.tag
            } else {
                let nonceObject = try ChaChaPoly.Nonce(data: nonce)
                let box = try ChaChaPoly.seal(plainData, using: key, nonce: nonceObject, authenticating: aadData)
                sealed = box.ciphertext + box.tag
            }
        } catch {
            throw CryptoError(code: "bad-envelope", message: "шифрование не удалось")
        }
        return Envelope(
            enc: sealed.base64EncodedString(),
            nonce: nonce.base64EncodedString(),
            keyId: keyId,
            alg: alg,
            plainSize: plainData.count
        )
    }

    static func open(_ envelope: Envelope, key: SymmetricKey, aad: String) throws -> String {
        let sealed = try decodeBase64(envelope.enc)
        guard sealed.count > tagBytes else {
            throw CryptoError(code: "decrypt-failed", message: "конверт короче тега аутентификации")
        }
        let ciphertext = sealed.prefix(sealed.count - tagBytes)
        let tag = sealed.suffix(tagBytes)
        let aadData = Data(aad.utf8)
        let plain: Data
        do {
            if envelope.alg == algAes256Gcm {
                let nonce = try AES.GCM.Nonce(data: decodeBase64(envelope.nonce))
                let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
                plain = try AES.GCM.open(box, using: key, authenticating: aadData)
            } else {
                let nonce = try ChaChaPoly.Nonce(data: decodeBase64(envelope.nonce))
                let box = try ChaChaPoly.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
                plain = try ChaChaPoly.open(box, using: key, authenticating: aadData)
            }
        } catch let error as CryptoError {
            throw error
        } catch {
            throw CryptoError(
                code: "decrypt-failed",
                message: "конверт повреждён или подменён: тег не сошёлся (AAD и nonce проверены)"
            )
        }
        guard plain.count == envelope.plainSize else {
            throw CryptoError(
                code: "bad-envelope",
                message: "plainSize не совпал с расшифрованным телом: \(plain.count) ≠ \(envelope.plainSize)"
            )
        }
        guard let text = String(data: plain, encoding: .utf8) else {
            throw CryptoError(code: "bad-plaintext", message: "открытый текст не UTF-8")
        }
        return text
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

extension Data {
    /// base64url без padding (ключи в конфиге/credentials).
    init?(base64URLEncoded text: String) {
        var value = text
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while value.count % 4 != 0 {
            value += "="
        }
        self.init(base64Encoded: value)
    }
}
