//
//  QuestionsViewModel.swift
//  RelayKit — состояние экранов «вопросы / ответ / закрытые».
//

import Foundation
import Combine

/// Модель экранов: загрузка вопросов, ответ (онлайн или через оффлайн-очередь),
/// список закрытых.
@MainActor
public final class QuestionsViewModel: ObservableObject {
    public enum LoadState: Equatable, Sendable {
        case idle, loading, loaded, failed(String)
    }

    @Published public private(set) var openQuestions: [RelayQuestion] = []
    @Published public private(set) var closedQuestions: [RelayQuestion] = []
    @Published public private(set) var loadState: LoadState = .idle
    @Published public private(set) var pendingCount = 0
    @Published public var errorText: String?

    private let api: RelayAPI
    private let queue: OfflineQueue
    private let closedStore: ClosedQuestionsStorage
    private let now: @Sendable () -> Date
    private var answered: Set<String> = []

    public init(
        api: RelayAPI,
        queue: OfflineQueue,
        closedStore: ClosedQuestionsStorage = InMemoryClosedQuestionsStore(),
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.api = api
        self.queue = queue
        self.closedStore = closedStore
        self.now = now
        pendingCount = queue.count
        closedQuestions = closedStore.load()
    }

    /// Загрузить открытые вопросы; уже отвеченные (локально) не показываем повторно.
    public func load() async {
        loadState = .loading
        do {
            let questions = try await api.fetchQuestions(since: nil)
            let fresh = questions.filter { !answered.contains($0.id) && $0.state == .open }
            mergeOpen(fresh)
            loadState = .loaded
        } catch {
            loadState = .failed(Self.describe(error))
        }
    }

    /// Ответить кнопкой и/или текстом. Ответ всегда попадает в очередь — даже
    /// если сеть есть: так один и тот же путь работает офлайн и при разрыве.
    public func answer(
        _ question: RelayQuestion,
        selected: [String],
        custom: String? = nil
    ) async {
        guard question.state == .open else { return }
        let text = custom?.trimmingCharacters(in: .whitespacesAndNewlines)
        let answer = RelayAnswer(
            questionId: question.id,
            selected: selected,
            custom: (text?.isEmpty ?? true) ? nil : text,
            answeredAt: Self.iso8601(now()),
            idempotencyKey: UUID().uuidString
        )
        do {
            try queue.enqueue(answer)
        } catch {
            errorText = "ответ не сохранён локально: \(Self.describe(error))"
            return
        }
        pendingCount = queue.count
        markAnswered(question)
        await flushQueue()
    }

    /// Отправить всё, что накопилось в очереди (после восстановления сети/запуска).
    public func flushQueue() async {
        for item in queue.pending {
            do {
                _ = try await api.send(item.answer)
                try? queue.remove(questionId: item.answer.questionId)
            } catch {
                try? queue.markFailed(questionId: item.answer.questionId, error: Self.describe(error))
                if (error as? RelayClientError)?.isRetryable == false {
                    errorText = "релей отклонил ответ: \(Self.describe(error))"
                }
            }
        }
        pendingCount = queue.count
    }

    /// События потока: ответ из другого канала/устройства закрывает вопрос;
    /// истёкший — уходит в закрытые.
    public func apply(event: RelayEvent) {
        switch event {
        case .questionCreated:
            // Новый вопрос пришёл потоком — подтягиваем список, чтобы он появился
            // без pull-to-refresh.
            Task { await self.load() }
        case .questionAnswered(let questionId):
            if let question = openQuestions.first(where: { $0.id == questionId }) {
                markAnswered(question)
            }
        case .questionExpired(let questionId):
            if let index = openQuestions.firstIndex(where: { $0.id == questionId }) {
                var question = openQuestions.remove(at: index)
                question.state = .expired
                closedQuestions.insert(question, at: 0)
                try? closedStore.save(closedQuestions)
            }
        case .other:
            break
        }
    }

    private func markAnswered(_ question: RelayQuestion) {
        answered.insert(question.id)
        openQuestions.removeAll { $0.id == question.id }
        var closed = question
        closed.state = .answered
        closedQuestions.insert(closed, at: 0)
        try? closedStore.save(closedQuestions)
    }

    private func mergeOpen(_ questions: [RelayQuestion]) {
        let known = Set(openQuestions.map(\.id))
        let added = questions.filter { !known.contains($0.id) }
        openQuestions = (openQuestions + added).sorted { $0.createdAt > $1.createdAt }
    }

    nonisolated private static func describe(_ error: Error) -> String {
        if let clientError = error as? RelayClientError {
            switch clientError {
            case .invalidResponse(let detail):
                return "некорректный ответ релея: \(detail)"
            case .api(let status, let code, let message):
                return "HTTP \(status) \(code): \(message)"
            }
        }
        return error.localizedDescription
    }

    nonisolated private static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}
