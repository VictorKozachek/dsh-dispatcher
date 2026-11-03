//
//  OfflineQueue.swift
//  RelayKit — оффлайн-очередь ответов.
//
//  Ответ человека не должен теряться без сети: он кладётся в файл и уходит на
//  релей, как только сеть появилась. Ключ идемпотентности создаётся один раз при
//  постановке в очередь, поэтому повтор/перезапуск не создаёт второй ответ на
//  сервере (016: повтор с тем же `idempotencyKey` и телом — 200).
//

import Foundation

public struct PendingAnswer: Codable, Equatable, Sendable {
    public let answer: RelayAnswer
    public var attempts: Int
    public var lastError: String?

    public init(answer: RelayAnswer, attempts: Int = 0, lastError: String? = nil) {
        self.answer = answer
        self.attempts = attempts
        self.lastError = lastError
    }
}

/// Файловая очередь: переживает перезапуск приложения.
public final class OfflineQueue: @unchecked Sendable {
    private let fileURL: URL
    private let lock = NSLock()
    private var items: [PendingAnswer]

    /// - Parameter fileURL: путь к JSON-файлу (в Application Support приложения).
    public init(fileURL: URL) {
        self.fileURL = fileURL
        self.items = Self.load(from: fileURL)
    }

    public var pending: [PendingAnswer] {
        lock.lock(); defer { lock.unlock() }
        return items
    }

    public var count: Int {
        lock.lock(); defer { lock.unlock() }
        return items.count
    }

    /// Поставить ответ в очередь. Если для вопроса уже есть запись — она
    /// заменяется (человек передумал до отправки), ключ идемпотентности сохраняется.
    public func enqueue(_ answer: RelayAnswer) throws {
        lock.lock()
        if let index = items.firstIndex(where: { $0.answer.questionId == answer.questionId }) {
            var existing = items[index]
            existing = PendingAnswer(
                answer: RelayAnswer(
                    questionId: answer.questionId,
                    selected: answer.selected,
                    custom: answer.custom,
                    answeredAt: existing.answer.answeredAt,
                    idempotencyKey: existing.answer.idempotencyKey
                ),
                attempts: existing.attempts,
                lastError: existing.lastError
            )
            items[index] = existing
        } else {
            items.append(PendingAnswer(answer: answer))
        }
        let snapshot = items
        lock.unlock()
        try Self.save(snapshot, to: fileURL)
    }

    public func remove(questionId: String) throws {
        lock.lock()
        items.removeAll { $0.answer.questionId == questionId }
        let snapshot = items
        lock.unlock()
        try Self.save(snapshot, to: fileURL)
    }

    public func markFailed(questionId: String, error: String) throws {
        lock.lock()
        if let index = items.firstIndex(where: { $0.answer.questionId == questionId }) {
            items[index].attempts += 1
            items[index].lastError = error
        }
        let snapshot = items
        lock.unlock()
        try Self.save(snapshot, to: fileURL)
    }

    public func clear() throws {
        lock.lock()
        items.removeAll()
        lock.unlock()
        try Self.save([], to: fileURL)
    }

    private static func load(from url: URL) -> [PendingAnswer] {
        guard let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([PendingAnswer].self, from: data)) ?? []
    }

    private static func save(_ items: [PendingAnswer], to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(items).write(to: url, options: .atomic)
    }
}
