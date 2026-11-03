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

/// Клиент релея: Bearer-токен устройства, заголовок версии, JSON.
public final class RelayClient: RelayAPI, @unchecked Sendable {
    public static let protocolVersion = "1"

    private let baseURL: URL
    private let tokenProvider: @Sendable () -> String?
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(
        baseURL: URL,
        tokenProvider: @escaping @Sendable () -> String?,
        session: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.tokenProvider = tokenProvider
        self.session = session
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

    public func fetchQuestions(since: String? = nil) async throws -> [RelayQuestion] {
        var path = "/v1/questions?limit=100"
        if let since, !since.isEmpty {
            path += "&since=\(since.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? since)"
        }
        let data = try await request("GET", path, authorized: true)
        let list = try decoder.decode(QuestionList.self, from: data)
        return list.questions
    }

    public func answer(questionId: String) async throws -> RelayAnswer? {
        let query = questionId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? questionId
        do {
            let data = try await request("GET", "/v1/answers?questionId=\(query)", authorized: true)
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
            let task = Task {
                var attempt = 0
                while !Task.isCancelled {
                    do {
                        for try await event in self.socketEvents() {
                            if Task.isCancelled { break }
                            continuation.yield(event)
                        }
                    } catch {
                        if Task.isCancelled { break }
                    }
                    attempt += 1
                    let delay = min(30.0, pow(2.0, Double(min(attempt, 5))))
                    try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func socketEvents() -> AsyncThrowingStream<RelayEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var request = URLRequest(url: baseURL.appendingPathComponent("v1/events"))
                request.setValue("1", forHTTPHeaderField: "x-relay-version")
                if let token = tokenProvider() {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
                }
                let socket = session.webSocketTask(with: request)
                socket.resume()
                defer { socket.cancel(with: .goingAway, reason: nil) }
                while !Task.isCancelled {
                    do {
                        let message = try await socket.receive()
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
        body: (any Encodable)? = nil,
        authorized: Bool
    ) async throws -> Data {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
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

public enum RelayClientError: Error, Equatable {
    case invalidResponse(String)
    case api(status: Int, code: String, message: String)

    public var isRetryable: Bool {
        if case .api(let status, _, _) = self { return status >= 500 || status == 429 }
        return true
    }
}
