//
//  RelayKitTests.swift
//  Юнит-тесты MVP: ViewModel, оффлайн-очередь, идемпотентность, привязка.
//
//  Сеть не нужна: `RelayAPI` подменяется фейком, часы и файловая очередь —
//  временными, Keychain — in-memory.
//

import XCTest
@testable import RelayKit

// MARK: - Фейковый транспорт

final class FakeRelayAPI: RelayAPI, @unchecked Sendable {
    var questions: [RelayQuestion] = []
    var answerResult: Result<RelayAnswer, Error> = .failure(RelayClientError.api(status: 503, code: "internal", message: "нет сети"))
    private(set) var sent: [RelayAnswer] = []
    private(set) var fetchCount = 0
    private let lock = NSLock()

    /// NSLock в async-контексте напрямую недоступен (Swift 6): только через sync-хелпер.
    private func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    func registerDevice(publicKey: String) async throws -> String { "device-1" }

    func pair(pairCode: String, deviceId: String) async throws -> RelayPairing {
        RelayPairing(baseURL: URL(string: "https://relay.test")!, deviceId: deviceId, deviceToken: "token-1")
    }

    func fetchQuestions(since: String?) async throws -> [RelayQuestion] {
        try withLock {
            fetchCount += 1
            return questions
        }
    }

    func answer(questionId: String) async throws -> RelayAnswer? { nil }

    func send(_ answer: RelayAnswer) async throws -> RelayAnswer {
        try withLock {
            switch answerResult {
            case .failure(let error):
                throw error
            case .success:
                sent.append(answer)
                return answer
            }
        }
    }

    func events() -> AsyncStream<RelayEvent> { AsyncStream { $0.finish() } }
}

// MARK: - Фикстуры

func makeQuestion(
    id: String = "q-1",
    shortId: String = "a1b2c3d4",
    title: String = "Продолжать?",
    state: RelayQuestion.State = .open
) -> RelayQuestion {
    RelayQuestion(
        id: id,
        shortId: shortId,
        workspace: "/p/alpha",
        taskId: "020",
        role: "worker",
        title: title,
        body: "Тело вопроса",
        options: [.init(id: "o1", label: "Да"), .init(id: "o2", label: "Нет")],
        createdAt: "2026-11-03T18:00:00Z",
        expiresAt: "2026-11-03T18:30:00Z",
        state: state
    )
}

func tempQueue() -> OfflineQueue {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("relay-tests-\(UUID().uuidString)", isDirectory: true)
        .appendingPathComponent("pending.json")
    return OfflineQueue(fileURL: url)
}

// MARK: - Тесты

@MainActor
final class QuestionsViewModelTests: XCTestCase {
    func testLoadShowsOnlyOpenQuestions() async {
        let api = FakeRelayAPI()
        api.questions = [makeQuestion(id: "q-1"), makeQuestion(id: "q-2", state: .answered)]
        let viewModel = QuestionsViewModel(api: api, queue: tempQueue())

        await viewModel.load()

        XCTAssertEqual(viewModel.loadState, .loaded)
        XCTAssertEqual(viewModel.openQuestions.map(\.id), ["q-1"])
        XCTAssertTrue(viewModel.closedQuestions.isEmpty)
    }

    func testAnswerSendsAndClosesQuestion() async {
        let api = FakeRelayAPI()
        api.answerResult = .failure(RelayClientError.api(status: 201, code: "", message: "ok"))
        let queue = tempQueue()
        let viewModel = QuestionsViewModel(api: api, queue: queue, now: { Date(timeIntervalSince1970: 1_700_000_000) })
        await viewModel.load()
        let question = makeQuestion()
        api.questions = [question]
        await viewModel.load()

        api.answerResult = .success(RelayAnswer(
            questionId: question.id,
            selected: ["o1"],
            answeredAt: "2026-11-03T18:00:00Z",
            idempotencyKey: "key"
        ))
        await viewModel.answer(question, selected: ["o1"], custom: "  текст  ")

        XCTAssertEqual(api.sent.count, 1)
        XCTAssertEqual(api.sent.first?.selected, ["o1"])
        XCTAssertEqual(api.sent.first?.custom, "текст", "пробелы обрезаются")
        XCTAssertEqual(queue.count, 0, "успешный ответ уходит из очереди")
        XCTAssertTrue(viewModel.openQuestions.isEmpty)
        XCTAssertEqual(viewModel.closedQuestions.first?.state, .answered)
        XCTAssertEqual(viewModel.pendingCount, 0)
    }

    func testOfflineAnswerSurvivesRestartAndRetriesWithSameKey() async throws {
        let api = FakeRelayAPI()
        api.answerResult = .failure(RelayClientError.api(status: 503, code: "internal", message: "нет сети"))
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("relay-tests-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent("pending.json")
        let queue = OfflineQueue(fileURL: fileURL)
        let viewModel = QuestionsViewModel(api: api, queue: queue)
        api.questions = [makeQuestion()]
        await viewModel.load()

        await viewModel.answer(makeQuestion(), selected: ["o2"])

        XCTAssertEqual(viewModel.pendingCount, 1, "ответ остался в очереди")
        let pending = queue.pending
        XCTAssertEqual(pending.count, 1)
        let key = try XCTUnwrap(pending.first?.answer.idempotencyKey)

        // «Перезапуск приложения»: новая очередь читает тот же файл.
        let restartedQueue = OfflineQueue(fileURL: fileURL)
        XCTAssertEqual(restartedQueue.count, 1, "очередь пережила перезапуск")

        // Сеть вернулась: тот же ключ идемпотентности, ответ уходит один раз.
        let restartedAPI = FakeRelayAPI()
        restartedAPI.answerResult = .failure(RelayClientError.api(status: 503, code: "internal", message: "нет сети"))
        let restartedViewModel = QuestionsViewModel(api: restartedAPI, queue: restartedQueue)
        restartedAPI.answerResult = .success(RelayAnswer(
            questionId: "q-1",
            selected: ["o2"],
            answeredAt: "2026-11-03T18:00:00Z",
            idempotencyKey: key
        ))
        await restartedViewModel.flushQueue()

        XCTAssertEqual(restartedAPI.sent.count, 1)
        XCTAssertEqual(restartedAPI.sent.first?.idempotencyKey, key, "ключ не пересоздан")
        XCTAssertEqual(restartedQueue.count, 0)
    }

    func testPendingAnswerIsReplacedWithoutNewKey() async throws {
        let api = FakeRelayAPI()
        api.answerResult = .failure(RelayClientError.api(status: 503, code: "internal", message: "нет сети"))
        let queue = tempQueue()
        let viewModel = QuestionsViewModel(api: api, queue: queue)
        api.questions = [makeQuestion()]
        await viewModel.load()

        await viewModel.answer(makeQuestion(), selected: ["o1"])
        let firstKey = try XCTUnwrap(queue.pending.first?.answer.idempotencyKey)
        await viewModel.answer(makeQuestion(), selected: ["o2"], custom: "другое")

        XCTAssertEqual(queue.count, 1, "второй ответ заменяет первый")
        XCTAssertEqual(queue.pending.first?.answer.idempotencyKey, firstKey, "ключ сохраняется")
        XCTAssertEqual(queue.pending.first?.answer.selected, ["o2"])
    }

    func testEventsCloseQuestion() async {
        let api = FakeRelayAPI()
        let viewModel = QuestionsViewModel(api: api, queue: tempQueue())
        api.questions = [makeQuestion()]
        await viewModel.load()

        viewModel.apply(event: .questionAnswered(questionId: "q-1"))
        XCTAssertTrue(viewModel.openQuestions.isEmpty)
        XCTAssertEqual(viewModel.closedQuestions.first?.state, .answered)

        api.questions = [makeQuestion(id: "q-2")]
        await viewModel.load()
        viewModel.apply(event: .questionExpired(questionId: "q-2"))
        XCTAssertEqual(viewModel.closedQuestions.first?.state, .expired)
    }

    func testClientParseEvent() {
        XCTAssertEqual(
            RelayClient.parseEvent(#"{"type":"question.answered","questionId":"q-1"}"#),
            .questionAnswered(questionId: "q-1")
        )
        XCTAssertEqual(
            RelayClient.parseEvent(#"{"type":"question.expired","questionId":"q-2"}"#),
            .questionExpired(questionId: "q-2")
        )
        XCTAssertEqual(
            RelayClient.parseEvent(#"{"type":"heartbeat","at":"2026-11-03T18:00:00Z"}"#),
            .other(type: "heartbeat")
        )
        XCTAssertNil(RelayClient.parseEvent("не json"))
    }
}

final class PairingTests: XCTestCase {
    func testPairStoresTokenInSecretStoreNotInDefaults() async throws {
        let secrets = InMemorySecretStore()
        let storage = InMemoryPairingStorage()
        let api = FakeRelayAPI()
        let service = PairingService(apiFactory: { _ in api }, secrets: secrets, storage: storage)

        let stored = try await service.pair(baseURL: URL(string: "https://relay.test")!, pairCode: "123456")

        XCTAssertEqual(stored.deviceId, "device-1")
        XCTAssertEqual(try secrets.read(PairingService.tokenKey), "token-1", "токен в Keychain")
        XCTAssertEqual(storage.load()?.baseURL.absoluteString, "https://relay.test")
        XCTAssertFalse(String(describing: storage.load()).contains("token-1"), "токен не хранится вместе с URL/deviceId")
    }

    func testUnpairClearsTokenAndStorage() async throws {
        let secrets = InMemorySecretStore()
        let storage = InMemoryPairingStorage()
        let api = FakeRelayAPI()
        let service = PairingService(apiFactory: { _ in api }, secrets: secrets, storage: storage)
        _ = try await service.pair(baseURL: URL(string: "https://relay.test")!, pairCode: "123456")

        try service.unpair()

        XCTAssertNil(try secrets.read(PairingService.tokenKey))
        XCTAssertNil(storage.load())
    }
}
