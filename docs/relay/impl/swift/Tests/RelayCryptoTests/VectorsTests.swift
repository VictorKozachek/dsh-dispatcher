import XCTest

@testable import RelayCrypto

/// Общие векторы e2e: тот же `docs/relay/test-vectors.json`, что читают JS и Kotlin.
final class VectorsTests: XCTestCase {

    private struct VectorFile {
        let keyId: String
        let devicePrivate: String
        let devicePublic: String
        let pluginPrivate: String
        let pluginPublic: String
        let valid: [[String: Any]]
        let invalid: [[String: Any]]
    }

    private func loadVectors() throws -> VectorFile {
        let fileManager = FileManager.default
        let testFile = URL(fileURLWithPath: #filePath)
        var directory = testFile.deletingLastPathComponent() // RelayCryptoTests
        for _ in 0..<4 {
            directory = directory.deletingLastPathComponent()
        }
        // .../docs/relay/impl/swift/Tests → docs/relay
        let vectorsURL = directory.appendingPathComponent("test-vectors.json")
        guard fileManager.fileExists(atPath: vectorsURL.path) else {
            throw XCTSkip("не нашли test-vectors.json: \(vectorsURL.path)")
        }
        let data = try Data(contentsOf: vectorsURL)
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let keys = root["keys"] as? [String: Any],
              let device = keys["device"] as? [String: Any],
              let plugin = keys["plugin"] as? [String: Any],
              let keyId = root["keyId"] as? String,
              let valid = root["valid"] as? [[String: Any]],
              let invalid = root["invalid"] as? [[String: Any]]
        else {
            XCTFail("не разобрали test-vectors.json")
            throw XCTSkip("битый файл векторов")
        }
        return VectorFile(
            keyId: keyId,
            devicePrivate: device["privateKey"] as! String,
            devicePublic: device["publicKey"] as! String,
            pluginPrivate: plugin["privateKey"] as! String,
            pluginPublic: plugin["publicKey"] as! String,
            valid: valid,
            invalid: invalid
        )
    }

    private func questionMeta(_ json: [String: Any]) -> RelayCrypto.QuestionMeta {
        RelayCrypto.QuestionMeta(
            id: json["id"] as! String,
            shortId: json["shortId"] as! String,
            createdAt: json["createdAt"] as! String,
            expiresAt: json["expiresAt"] as! String
        )
    }

    private func answerMeta(_ json: [String: Any]) -> RelayCrypto.AnswerMeta {
        RelayCrypto.AnswerMeta(
            questionId: json["questionId"] as! String,
            answeredAt: json["answeredAt"] as! String,
            idempotencyKey: json["idempotencyKey"] as! String
        )
    }

    private func envelope(_ json: [String: Any]) -> RelayCrypto.Envelope {
        RelayCrypto.Envelope(
            enc: json["enc"] as! String,
            nonce: json["nonce"] as! String,
            keyId: json["keyId"] as! String,
            alg: json["alg"] as! String,
            plainSize: json["plainSize"] as! Int
        )
    }

    func testVectorFileMatchesCryptoVersion() throws {
        let vectors = try loadVectors()
        XCTAssertEqual(vectors.keyId, try RelayCrypto.keyId(for: vectors.devicePublic))
        XCTAssertGreaterThanOrEqual(vectors.valid.count, 5)
        XCTAssertGreaterThanOrEqual(vectors.invalid.count, 4)
    }

    func testValidVectorsAreByteIdentical() throws {
        let vectors = try loadVectors()
        for vector in vectors.valid {
            let name = vector["name"] as! String
            let kind = vector["kind"] as! String
            let alg = vector["alg"] as! String
            let nonce = Data(base64Encoded: vector["nonce"] as! String)!
            let plaintext = vector["plaintextCanonical"] as! String
            let expected = envelope(vector["envelope"] as! [String: Any])

            let sealer = try RelayCrypto.E2e(
                privateKey: kind == "question" ? vectors.pluginPrivate : vectors.devicePrivate,
                peerPublicKey: kind == "question" ? vectors.devicePublic : vectors.pluginPublic,
                devicePublicKey: vectors.devicePublic,
                alg: alg
            )
            let opener = try RelayCrypto.E2e(
                privateKey: kind == "question" ? vectors.devicePrivate : vectors.pluginPrivate,
                peerPublicKey: kind == "question" ? vectors.pluginPublic : vectors.devicePublic,
                devicePublicKey: vectors.devicePublic
            )

            let sealed: RelayCrypto.Envelope
            let opened: String
            if kind == "question" {
                let meta = questionMeta(vector["meta"] as! [String: Any])
                sealed = try sealer.sealQuestion(plaintext, meta: meta, nonce: nonce)
                opened = try opener.openQuestion(sealed, meta: meta)
            } else {
                let meta = answerMeta(vector["meta"] as! [String: Any])
                sealed = try sealer.sealAnswer(plaintext, meta: meta, nonce: nonce)
                opened = try opener.openAnswer(sealed, meta: meta)
            }

            XCTAssertEqual(sealed.enc, expected.enc, "\(name): enc")
            XCTAssertEqual(sealed.nonce, expected.nonce, "\(name): nonce")
            XCTAssertEqual(sealed.keyId, expected.keyId, "\(name): keyId")
            XCTAssertEqual(sealed.alg, expected.alg, "\(name): alg")
            XCTAssertEqual(sealed.plainSize, expected.plainSize, "\(name): plainSize")
            XCTAssertEqual(opened, plaintext, "\(name): расшифровка")
        }
    }

    func testInvalidVectorsFailWithCode() throws {
        let vectors = try loadVectors()
        for vector in vectors.invalid {
            let name = vector["name"] as! String
            let kind = vector["kind"] as! String
            let expected = vector["error"] as! String
            let badEnvelope = envelope(vector["envelope"] as! [String: Any])
            let meta = vector["meta"] as! [String: Any]

            let opener = try RelayCrypto.E2e(
                privateKey: kind == "question" ? vectors.devicePrivate : vectors.pluginPrivate,
                peerPublicKey: kind == "question" ? vectors.pluginPublic : vectors.devicePublic,
                devicePublicKey: vectors.devicePublic
            )

            do {
                if kind == "question" {
                    _ = try opener.openQuestion(badEnvelope, meta: questionMeta(meta))
                } else {
                    _ = try opener.openAnswer(badEnvelope, meta: answerMeta(meta))
                }
                XCTFail("\(name): ожидали ошибку \(expected)")
            } catch let error as RelayCrypto.CryptoError {
                XCTAssertEqual(error.code, expected, "\(name): код ошибки")
            }
        }
    }

    func testRoundTripBothAlgorithms() throws {
        let vectors = try loadVectors()
        for alg in RelayCrypto.supportedAlgs {
            let plugin = try RelayCrypto.E2e(
                privateKey: vectors.pluginPrivate,
                peerPublicKey: vectors.devicePublic,
                devicePublicKey: vectors.devicePublic,
                alg: alg
            )
            let device = try RelayCrypto.E2e(
                privateKey: vectors.devicePrivate,
                peerPublicKey: vectors.pluginPublic,
                devicePublicKey: vectors.devicePublic,
                alg: alg
            )
            let questionMeta = RelayCrypto.QuestionMeta(
                id: "q-1", shortId: "a1b2c3d4",
                createdAt: "2026-11-03T18:00:00Z", expiresAt: "2026-11-03T18:30:00Z"
            )
            let answerMeta = RelayCrypto.AnswerMeta(
                questionId: "q-1", answeredAt: "2026-11-03T18:05:00Z",
                idempotencyKey: "3f2a1b0c-9d8e-4f70-a1b2-c3d4e5f60718"
            )

            let question = try plugin.sealQuestion(
                #"{"body":"Продолжать?","options":[{"id":"o1","label":"Да"}]}"#,
                meta: questionMeta
            )
            XCTAssertEqual(question.alg, alg)
            XCTAssertEqual(
                try device.openQuestion(question, meta: questionMeta),
                #"{"body":"Продолжать?","options":[{"id":"o1","label":"Да"}]}"#
            )

            let answer = try device.sealAnswer(#"{"custom":"ок"}"#, meta: answerMeta)
            XCTAssertEqual(try plugin.openAnswer(answer, meta: answerMeta), #"{"custom":"ок"}"#)
        }
    }

    func testKeyPairFormatAndKeyId() throws {
        let first = RelayCrypto.generateKeyPair()
        let second = RelayCrypto.generateKeyPair()

        XCTAssertEqual(Data(base64URLEncoded: first.privateKey)?.count, 32)
        XCTAssertTrue(first.publicKey.hasPrefix("base64:"))
        XCTAssertEqual(Data(base64Encoded: String(first.publicKey.dropFirst(7)))?.count, 32)
        XCTAssertEqual(try RelayCrypto.keyId(for: first.publicKey), try RelayCrypto.keyId(for: first.publicKey))
        XCTAssertNotEqual(try RelayCrypto.keyId(for: first.publicKey), try RelayCrypto.keyId(for: second.publicKey))
    }

    func testForeignQuestionIsRejected() throws {
        let vectors = try loadVectors()
        let other = RelayCrypto.generateKeyPair()
        let plugin = try RelayCrypto.E2e(
            privateKey: vectors.pluginPrivate,
            peerPublicKey: other.publicKey,
            devicePublicKey: other.publicKey
        )
        let device = try RelayCrypto.E2e(
            privateKey: vectors.devicePrivate,
            peerPublicKey: vectors.pluginPublic,
            devicePublicKey: vectors.devicePublic
        )
        let meta = RelayCrypto.QuestionMeta(
            id: "q-1", shortId: "a1b2c3d4",
            createdAt: "2026-11-03T18:00:00Z", expiresAt: "2026-11-03T18:30:00Z"
        )

        let envelope = try plugin.sealQuestion(#"{"body":"Продолжать?"}"#, meta: meta)
        XCTAssertThrowsError(try device.openQuestion(envelope, meta: meta)) { error in
            XCTAssertEqual((error as? RelayCrypto.CryptoError)?.code, "key-mismatch")
        }
    }
}
