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

// MARK: - RelayClient на URLProtocol (реальный URLSession, сеть не нужна)

final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, Data))?
    nonisolated(unsafe) static var requests: [URLRequest] = []
    private static let lock = NSLock()

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        requests = []
        handler = nil
    }

    static func record(_ request: URLRequest) {
        lock.lock(); defer { lock.unlock() }
        requests.append(request)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.record(request)
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        do {
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: status,
                httpVersion: "HTTP/1.1",
                headerFields: ["content-type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

func makeStubSession() -> URLSession {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StubURLProtocol.self]
    return URLSession(configuration: configuration)
}

final class RelayClientTests: XCTestCase {
    let baseURL = URL(string: "https://relay.test")!

    func client(token: String = "token-1") -> RelayClient {
        RelayClient(baseURL: baseURL, tokenProvider: { token }, session: makeStubSession())
    }

    override func setUp() {
        super.setUp()
        StubURLProtocol.reset()
    }

    func testFetchQuestionsBuildsQueryAndHeaders() async throws {
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/questions", "query не должен попадать в path")
            XCTAssertEqual(request.url?.query, "limit=100")
            XCTAssertEqual(request.value(forHTTPHeaderField: "x-relay-version"), "1")
            XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer token-1")
            let body = #"{"questions":[{"id":"q-1","shortId":"a1b2c3d4","createdAt":"2026-11-03T18:00:00Z","expiresAt":"2026-11-03T18:30:00Z"}],"nextSince":"t1","nextId":"q-1"}"#
            return (200, Data(body.utf8))
        }

        let questions = try await client().fetchQuestions()

        XCTAssertEqual(questions.map(\.id), ["q-1"])
        XCTAssertEqual(StubURLProtocol.requests.count, 1)
    }

    func testFetchQuestionsFollowsCursorPages() async throws {
        let page = (0..<100).map { index in
            #"{"id":"q-\#(index)","shortId":"a1b2c3d4","createdAt":"2026-11-03T18:00:00Z","expiresAt":"2026-11-03T18:30:00Z"}"#
        }.joined(separator: ",")
        StubURLProtocol.handler = { request in
            let query = request.url?.query ?? ""
            if query.contains("sinceId=") {
                XCTAssertTrue(query.contains("since=t1"))
                XCTAssertTrue(query.contains("sinceId=q-99"))
                let body = #"{"questions":[{"id":"q-100","shortId":"deadbeef","createdAt":"2026-11-03T18:00:00Z","expiresAt":"2026-11-03T18:30:00Z"}],"nextSince":"t2"}"#
                return (200, Data(body.utf8))
            }
            let body = #"{"questions":[\#(page)],"nextSince":"t1","nextId":"q-99"}"#
            return (200, Data(body.utf8))
        }

        let questions = try await client().fetchQuestions()

        XCTAssertEqual(questions.count, 101, "вторая страница не потеряна")
        XCTAssertEqual(questions.last?.id, "q-100")
        XCTAssertEqual(StubURLProtocol.requests.count, 2, "курсор nextSince/nextId использован")
    }

    func testAnswerGetsQuestionIdAndHandles404() async throws {
        StubURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/v1/answers")
            XCTAssertTrue((request.url?.query ?? "").contains("questionId=q-1"))
            return (404, Data(#"{"error":{"code":"not-found","message":"нет ответа"}}"#.utf8))
        }

        let answer = try await client().answer(questionId: "q-1")

        XCTAssertNil(answer, "404 — это «ответа ещё нет», а не ошибка")
    }

    func testServerErrorBecomesAPIError() async {
        StubURLProtocol.handler = { _ in
            (503, Data(#"{"error":{"code":"internal","message":"сбой","retryable":true}}"#.utf8))
        }

        do {
            _ = try await client().fetchQuestions()
            XCTFail("ожидалась ошибка")
        } catch let error as RelayClientError {
            guard case .api(let status, let code, _) = error else {
                return XCTFail("ожидался .api, получено \(error)")
            }
            XCTAssertEqual(status, 503)
            XCTAssertEqual(code, "internal")
            XCTAssertTrue(error.isRetryable)
        } catch {
            XCTFail("неожиданная ошибка: \(error)")
        }
    }

    func testParseCreatedEvent() {
        XCTAssertEqual(
            RelayClient.parseEvent(#"{"type":"question.created","questionId":"q-7"}"#),
            .questionCreated(questionId: "q-7")
        )
    }
}

// MARK: - Закрытые и события

@MainActor
final class ClosedQuestionsTests: XCTestCase {
    func testClosedQuestionsSurviveRestart() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("relay-closed-\(UUID().uuidString)", isDirectory: true)
        let fileURL = dir.appendingPathComponent("closed.json")
        let store = FileClosedQuestionsStore(fileURL: fileURL)
        let api = FakeRelayAPI()
        api.answerResult = .failure(RelayClientError.api(status: 503, code: "internal", message: "нет сети"))
        api.questions = [makeQuestion()]
        let viewModel = QuestionsViewModel(api: api, queue: tempQueue(), closedStore: store)
        await viewModel.load()
        await viewModel.answer(makeQuestion(), selected: ["o1"])
        XCTAssertEqual(viewModel.closedQuestions.count, 1)

        // «Перезапуск»: новый VM читает тот же файл.
        let restarted = QuestionsViewModel(api: FakeRelayAPI(), queue: tempQueue(), closedStore: store)
        XCTAssertEqual(restarted.closedQuestions.map(\.id), ["q-1"], "закрытые пережили перезапуск")
        XCTAssertEqual(restarted.closedQuestions.first?.state, .answered)
    }

    func testQuestionCreatedEventRefreshesList() async throws {
        let api = FakeRelayAPI()
        let viewModel = QuestionsViewModel(api: api, queue: tempQueue())
        XCTAssertEqual(api.fetchCount, 0)

        viewModel.apply(event: .questionCreated(questionId: "q-9"))
        for _ in 0..<20 {
            await Task.yield()
            try await Task.sleep(nanoseconds: 2_000_000)
            if api.fetchCount > 0 { break }
        }

        XCTAssertGreaterThan(api.fetchCount, 0, "question.created обновляет список")
    }
}

extension RelayClientTests {
    func testPaginationWithEqualCreatedAtUsesSinceId() async throws {
        let timestamp = "2026-11-03T18:00:00Z"
        let page = (0..<100).map { index in
            #"{"id":"q-\#(index)","shortId":"a1b2c3d4","createdAt":"\#(timestamp)","expiresAt":"2026-11-03T18:30:00Z"}"#
        }.joined(separator: ",")
        StubURLProtocol.handler = { request in
            let query = request.url?.query ?? ""
            if query.contains("sinceId=q-99") {
                XCTAssertTrue(query.contains("since=\(timestamp)"), "since не сдвинулся — это нормально, двигает sinceId")
                let body = #"{"questions":[{"id":"q-100","shortId":"deadbeef","createdAt":"\#(timestamp)","expiresAt":"2026-11-03T18:30:00Z"}],"nextSince":"\#(timestamp)"}"#
                return (200, Data(body.utf8))
            }
            let body = #"{"questions":[\#(page)],"nextSince":"\#(timestamp)","nextId":"q-99"}"#
            return (200, Data(body.utf8))
        }

        let questions = try await client().fetchQuestions()

        XCTAssertEqual(questions.count, 101, "остаток не потерян при одинаковом createdAt")
        XCTAssertEqual(questions.last?.id, "q-100")
        XCTAssertEqual(StubURLProtocol.requests.count, 2)
        XCTAssertTrue((StubURLProtocol.requests[1].url?.query ?? "").contains("sinceId=q-99"))
    }
}

// MARK: - WebSocket: схема URL и чтение событий

final class FakeSocket: RelaySocket, @unchecked Sendable {
    private let messages: [URLSessionWebSocketTask.Message]
    private let lock = NSLock()
    private var index = 0
    private(set) var resumed = false

    init(messages: [URLSessionWebSocketTask.Message]) {
        self.messages = messages
    }

    func resume() { resumed = true }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {}

    func receive() async throws -> URLSessionWebSocketTask.Message {
        let next: URLSessionWebSocketTask.Message? = lock.withLock {
            guard index < messages.count else { return nil }
            defer { index += 1 }
            return messages[index]
        }
        if let next { return next }
        throw URLError(.networkConnectionLost)
    }
}

extension RelayClientTests {
    func testWebSocketURLReplacesScheme() {
        let http = RelayClient.webSocketURL(from: URL(string: "http://127.0.0.1:8080")!)
        XCTAssertEqual(http?.absoluteString, "ws://127.0.0.1:8080/v1/events")

        let https = RelayClient.webSocketURL(from: URL(string: "https://relay.example/base")!)
        XCTAssertEqual(https?.absoluteString, "wss://relay.example/base/v1/events")

        XCTAssertNil(RelayClient.webSocketURL(from: URL(string: "ftp://relay.example")!))
    }

    func testEventsReadFromFakeSocketWithHeaders() async {
        let socket = FakeSocket(messages: [
            .string(#"{"type":"question.created","questionId":"q-1"}"#),
            .string(#"{"type":"question.answered","questionId":"q-1"}"#),
        ])
        let client = RelayClient(
            baseURL: URL(string: "http://127.0.0.1:8080")!,
            tokenProvider: { "token-1" },
            session: makeStubSession(),
            socketFactory: { request in
                XCTAssertEqual(request.url?.absoluteString, "ws://127.0.0.1:8080/v1/events")
                XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer token-1")
                XCTAssertEqual(request.value(forHTTPHeaderField: "x-relay-version"), "1")
                return socket
            }
        )

        var events: [RelayEvent] = []
        for await event in client.events() {
            events.append(event)
            if events.count == 2 { break }
        }

        XCTAssertEqual(events, [.questionCreated(questionId: "q-1"), .questionAnswered(questionId: "q-1")])
        XCTAssertTrue(socket.resumed)
    }

    @MainActor
    func testNonRetryableAnswerIsRemovedFromQueueWithAction() async {
        let api = FakeRelayAPI()
        api.answerResult = .failure(RelayClientError.api(status: 409, code: "conflict", message: "конфликт"))
        let queue = tempQueue()
        let viewModel = QuestionsViewModel(api: api, queue: queue)
        try? queue.enqueue(RelayAnswer(
            questionId: "q-1",
            selected: ["o1"],
            custom: nil,
            answeredAt: "2026-11-03T18:00:00Z",
            idempotencyKey: "key-1"
        ))

        await viewModel.flushQueue()

        XCTAssertEqual(queue.count, 0, "неретраибельный ответ снят с очереди")
        XCTAssertNotNil(viewModel.errorText)
        XCTAssertTrue(viewModel.errorText?.contains("нужны действия") ?? false)
    }
}
