//
//  Models.swift
//  RelayKit — модели протокола релея v1 (docs/relay/PROTOCOL.md, 016/023).
//

import Foundation

/// Вопрос, который релей отдаёт устройству.
public struct RelayQuestion: Codable, Identifiable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case open, answered, expired
    }

    public let id: String
    public let shortId: String
    public let workspace: String?
    public let taskId: String?
    public let role: String?
    public let title: String?
    public let body: String?
    public let detail: String?
    public let options: [Option]
    public let multiSelect: Bool
    public let allowFreeText: Bool
    public let createdAt: String
    public let expiresAt: String
    /// Закрытые вопросы (ответили/истекли) показываем в отдельном списке.
    public var state: State

    public struct Option: Codable, Identifiable, Equatable, Sendable {
        public let id: String
        public let label: String
    }

    public init(
        id: String,
        shortId: String,
        workspace: String? = nil,
        taskId: String? = nil,
        role: String? = nil,
        title: String? = nil,
        body: String? = nil,
        detail: String? = nil,
        options: [Option] = [],
        multiSelect: Bool = false,
        allowFreeText: Bool = true,
        createdAt: String,
        expiresAt: String,
        state: State = .open
    ) {
        self.id = id
        self.shortId = shortId
        self.workspace = workspace
        self.taskId = taskId
        self.role = role
        self.title = title
        self.body = body
        self.detail = detail
        self.options = options
        self.multiSelect = multiSelect
        self.allowFreeText = allowFreeText
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.state = state
    }

    enum CodingKeys: String, CodingKey {
        case id, shortId, workspace, taskId, role, title, body, detail
        case options, multiSelect, allowFreeText, createdAt, expiresAt, state
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        shortId = try container.decode(String.self, forKey: .shortId)
        workspace = try container.decodeIfPresent(String.self, forKey: .workspace)
        taskId = try container.decodeIfPresent(String.self, forKey: .taskId)
        role = try container.decodeIfPresent(String.self, forKey: .role)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        body = try container.decodeIfPresent(String.self, forKey: .body)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        options = try container.decodeIfPresent([Option].self, forKey: .options) ?? []
        multiSelect = try container.decodeIfPresent(Bool.self, forKey: .multiSelect) ?? false
        allowFreeText = try container.decodeIfPresent(Bool.self, forKey: .allowFreeText) ?? true
        createdAt = try container.decode(String.self, forKey: .createdAt)
        expiresAt = try container.decode(String.self, forKey: .expiresAt)
        state = try container.decodeIfPresent(State.self, forKey: .state) ?? .open
    }
}

/// Ответ человека уходит на релей идемпотентно: ключ создаётся один раз и
/// переиспользуется при повторах/перезапуске.
public struct RelayAnswer: Codable, Equatable, Sendable {
    public let questionId: String
    public let selected: [String]
    public let custom: String?
    public let answeredAt: String
    public let idempotencyKey: String

    public init(
        questionId: String,
        selected: [String],
        custom: String? = nil,
        answeredAt: String,
        idempotencyKey: String
    ) {
        self.questionId = questionId
        self.selected = selected
        self.custom = custom
        self.answeredAt = answeredAt
        self.idempotencyKey = idempotencyKey
    }
}

/// Пара «устройство + токен» после привязки. Токен живёт в Keychain, не в файле.
public struct RelayPairing: Codable, Equatable, Sendable {
    public let baseURL: URL
    public let deviceId: String
    public let deviceToken: String

    public init(baseURL: URL, deviceId: String, deviceToken: String) {
        self.baseURL = baseURL
        self.deviceId = deviceId
        self.deviceToken = deviceToken
    }
}

/// Ошибка протокола (тело `{error:{code,message,retryable}}`).
public struct RelayAPIError: Codable, Error, Equatable, Sendable {
    public struct Payload: Codable, Equatable, Sendable {
        public let code: String
        public let message: String
        public let retryable: Bool?
    }

    public let error: Payload

    public var isRetryable: Bool { error.retryable ?? false }
}
