//
//  ClosedStore.swift
//  RelayKit — закрытые вопросы переживают перезапуск.
//
//  MVP хранит закрытые (отвеченные/истёкшие) вопросы рядом с очередью ответов:
//  вкладка «Закрытые» не должна пустеть после перезапуска приложения.
//

import Foundation

public protocol ClosedQuestionsStorage: Sendable {
    func load() -> [RelayQuestion]
    func save(_ questions: [RelayQuestion]) throws
}

/// Файловое хранилище: `Application Support/RelayClient/closed-questions.json`.
public final class FileClosedQuestionsStore: ClosedQuestionsStorage, @unchecked Sendable {
    private let fileURL: URL
    private let lock = NSLock()

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func load() -> [RelayQuestion] {
        lock.lock(); defer { lock.unlock() }
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        return (try? JSONDecoder().decode([RelayQuestion].self, from: data)) ?? []
    }

    public func save(_ questions: [RelayQuestion]) throws {
        lock.lock(); defer { lock.unlock() }
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(Array(questions.prefix(200))).write(to: fileURL, options: .atomic)
    }
}

/// In-memory для тестов/превью.
public final class InMemoryClosedQuestionsStore: ClosedQuestionsStorage, @unchecked Sendable {
    private var value: [RelayQuestion]
    private let lock = NSLock()

    public init(value: [RelayQuestion] = []) {
        self.value = value
    }

    public func load() -> [RelayQuestion] {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    public func save(_ questions: [RelayQuestion]) throws {
        lock.lock(); defer { lock.unlock() }
        value = questions
    }
}
