//
//  RelayClient.swift
//  RelayKit — HTTP/WS клиент протокола релея v1 (016/023).
//
//  Всё сетевое инжектируется (`URLSession`, часы), поэтому ViewModel тестируется
//  с фейковым транспортом и без единого реального запроса.
//

import Foundation

/// Событие потока `/v1/events`.
public enum RelayEvent: Equatable, Sendable {
    case questionCreated(questionId: String)
    case questionAnswered(questionId: String)
    case questionExpired(questionId: String)
    case other(type: String)
}

/// Транспорт, который нужен экранам. Реализация — `RelayClient`, в тестах — фейк.
public protocol RelayAPI: Sendable {
    func registerDevice(publicKey: String) async throws -> String
    func pair(pairCode: String, deviceId: String) async throws -> RelayPairing
    func fetchQuestions(since: String?) async throws -> [RelayQuestion]
    func answer(questionId: String) async throws -> RelayAnswer?
    func send(_ answer: RelayAnswer) async throws -> RelayAnswer
    func events() -> AsyncStream<RelayEvent>
}

/// Сокет, который нужен клиенту: обёртка над `URLSessionWebSocketTask`,
/// подменяемая в тестах (реальный WS не нужен).
public protocol RelaySocket: AnyObject, Sendable {
    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func receive() async throws -> URLSessionWebSocketTask.Message
}

extension URLSessionWebSocketTask: RelaySocket {}

/// Клиент релея: Bearer-токен устройства, заголовок версии, JSON.
public final class RelayClient: RelayAPI, @unchecked Sendable {
    public static let protocolVersion = "1"

    private let baseURL: URL
    private let tokenProvider: @Sendable () -> String?
    private let session: URLSession
    private let socketFactory: (@Sendable (URLRequest) -> RelaySocket)?
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(
        baseURL: URL,
        tokenProvider: @escaping @Sendable () -> String?,
        session: URLSession = .shared,
        socketFactory: (@Sendable (URLRequest) -> RelaySocket)? = nil
    ) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.session = session
        self.socketFactory = socketFactory
    }

    /// WebSocket-URL из базового HTTP(S): `http → ws`, `https → wss`.
    /// `appendingPathComponent` + `ws`-схема недопустимы для `URLRequest` сокета.
    public static func webSocketURL(from baseURL: URL) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        switch components.scheme?.lowercased() {
        case "https": components.scheme = "wss"
        case "http": components.scheme = "ws"
        case "wss", "ws": break
        default: return nil
        }
        var path = components.path
        if !path.hasSuffix("/") { path += "/" }
        components.path = path + "v1/events"
        return components.url
    }

    // MARK: - Привязка

    /// POST /v1/devices: id устройства выдаёт релей, идемпотентно по publicKey.
    public func registerDevice(publicKey: String) async throws -> String {
        let body = ["platform": "ios", "publicKey": publicKey]
        let data = try await request("POST", "/v1/devices", body: body, authorized: false)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let deviceId = object["deviceId"] as? String else {
            throw RelayClientError.invalidResponse("нет deviceId")
        }
        return deviceId
    }

    /// POST /v1/pair: одноразовый код → deviceToken (секрет).
    public func pair(pairCode: String, deviceId: String) async throws -> RelayPairing {
        let body = ["pairCode": pairCode, "deviceId": deviceId]
        let data = try await request("POST", "/v1/pair", body: body, authorized: false)
        let response = try decoder.decode(PairResponse.self, from: data)
        return RelayPairing(baseURL: baseURL, deviceId: deviceId, deviceToken: response.deviceToken)
    }

    // MARK: - Вопросы и ответы

    /// Все открытые вопросы, постранично: курсор — `nextSince` + `nextId` (023),
    /// поэтому страницы не теряются и не дублируются даже при одинаковом `createdAt`.
    public func fetchQuestions(since: String? = nil) async throws -> [RelayQuestion] {
        var collected: [RelayQuestion] = []
        var cursorSince = since
        var cursorId: String?
        var pages = 0
        repeat {
            var items = [URLQueryItem(name: "limit", value: "100")]
            if let cursorSince, !cursorSince.isEmpty {
                items.append(URLQueryItem(name: "since", value: cursorSince))
            }
            if let cursorId, !cursorId.isEmpty {
                items.append(URLQueryItem(name: "sinceId", value: cursorId))
            }
            let data = try await request("GET", "/v1/questions", queryItems: items, authorized: true)
            let page = try decoder.decode(QuestionList.self, from: data)
            collected.append(contentsOf: page.questions)
            pages += 1
            let nextSince = page.nextSince
            let nextId = page.nextId
            // Продолжаем по составному курсору: при одинаковом `createdAt`
            // (пачка ask_user_question) `nextSince` не меняется, двигает `nextId`.
            let moved = nextSince != cursorSince || nextId != cursorId
            guard page.questions.count >= 100, let nextSince, moved, pages < 20 else { break }
            cursorSince = nextSince
            cursorId = nextId
        } while true
        return collected
    }

    /// Agent-only: `GET /v1/answers` требует токен агента (deviceToken → 403).
    /// Приложение его не вызывает; оставлен для симметрии контракта.
    public func answer(questionId: String) async throws -> RelayAnswer? {
        do {
            let data = try await request(
                "GET",
                "/v1/answers",
                queryItems: [URLQueryItem(name: "questionId", value: questionId)],
                authorized: true
            )
            return try decoder.decode(RelayAnswer.self, from: data)
        } catch let error as RelayClientError {
            if case .api(status: 404, code: _, message: _) = error { return nil }
            throw error
        }
    }

    /// POST /v1/answers: повтор с тем же телом и ключом — 200, сервер не дублирует.
    public func send(_ answer: RelayAnswer) async throws -> RelayAnswer {
        let data = try await request("POST", "/v1/answers", body: answer, authorized: true)
        return try decoder.decode(RelayAnswer.self, from: data)
    }

    // MARK: - События (WebSocket)

    /// `GET /v1/events`: переподключение с backoff, парсинг событий.
    public func events() -> AsyncStream<RelayEvent> {
        AsyncStream { continuation in
            let attempts = AttemptCounter()
            let task = Task {
                while !Task.isCancelled {
                    do {
                        for try await event in self.socketEvents(onConnected: { attempts.reset() }) {
                            if Task.isCancelled { break }
                            continuation.yield(event)
                        }
                    } catch {
                        if Task.isCancelled { break }
                    }
                    // Backoff с 1 с (2^(attempt-1)): первая пауза короткая,
                    // после успешного сообщения счётчик сбрасывается.
                    let delay = attempts.nextDelay()
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func socketEvents(onConnected: @escaping @Sendable () -> Void) -> AsyncThrowingStream<RelayEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                guard let wsURL = Self.webSocketURL(from: baseURL) else {
                    continuation.finish(throwing: RelayClientError.invalidResponse("URL релея не http(s)"))
                    return
                }
                var request = URLRequest(url: wsURL)
                request.setValue("1", forHTTPHeaderField: "x-relay-version")
                if let token = tokenProvider() {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
                }
                let socket: RelaySocket = socketFactory?(request) ?? session.webSocketTask(with: request)
                socket.resume()
                defer { socket.cancel(with: .goingAway, reason: nil) }
                while !Task.isCancelled {
                    do {
                        let message = try await socket.receive()
                        onConnected()
                        switch message {
                        case .string(let text):
                            if let event = Self.parseEvent(text) { continuation.yield(event) }
                        case .data(let data):
                            if let text = String(data: data, encoding: .utf8),
                               let event = Self.parseEvent(text) {
                                continuation.yield(event)
                            }
                        @unknown default:
                            break
                        }
                    } catch {
                        continuation.finish(throwing: error)
                        return
                    }
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func parseEvent(_ text: String) -> RelayEvent? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return nil }
        let questionId = object["questionId"] as? String
        switch type {
        case "question.created":
            return questionId.map(RelayEvent.questionCreated)
        case "question.answered":
            return questionId.map(RelayEvent.questionAnswered)
        case "question.expired":
            return questionId.map(RelayEvent.questionExpired)
        default:
            return .other(type: type)
        }
    }

    // MARK: - HTTP

    private func request(
        _ method: String,
        _ path: String,
        queryItems: [URLQueryItem] = [],
        body: (any Encodable)? = nil,
        authorized: Bool
    ) async throws -> Data {
        // Query нельзя склеивать в path: `appendingPathComponent` закодирует `?`
        // в `%3F`, и запрос уйдёт на несуществующий путь. Только URLComponents.
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
        if !queryItems.isEmpty { components?.queryItems = queryItems }
        guard let url = components?.url else {
            throw RelayClientError.invalidResponse("не удалось собрать URL для \(path)")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("1", forHTTPHeaderField: "x-relay-version")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        if authorized, let token = tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
        if let body {
            request.httpBody = try encoder.encode(body)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw RelayClientError.invalidResponse("не HTTP-ответ")
        }
        guard (200..<300).contains(http.statusCode) else {
            if let payload = try? decoder.decode(RelayAPIError.self, from: data) {
                throw RelayClientError.api(status: http.statusCode, code: payload.error.code, message: payload.error.message)
            }
            throw RelayClientError.api(status: http.statusCode, code: "", message: "HTTP \(http.statusCode)")
        }
        return data
    }

    private struct PairResponse: Decodable {
        let deviceToken: String
    }

    private struct QuestionList: Decodable {
        let questions: [RelayQuestion]
        let nextSince: String?
        let nextId: String?
    }
}

/// Счётчик попыток переподключения: сбрасывается на первом сообщении WS.
final class AttemptCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var attempt = 0

    func reset() {
        lock.lock(); defer { lock.unlock() }
        attempt = 0
    }

    /// 1, 2, 4, 8, 16, 30 — секунды.
    func nextDelay() -> Double {
        lock.lock(); defer { lock.unlock() }
        attempt += 1
        let exponent = Double(min(max(attempt - 1, 0), 5))
        return min(30.0, pow(2.0, exponent))
    }
}

public enum RelayClientError: Error, Equatable {
    case invalidResponse(String)
    case api(status: Int, code: String, message: String)

    public var isRetryable: Bool {
        if case .api(let status, _, _) = self { return status >= 500 || status == 429 }
        return true
    }
}
