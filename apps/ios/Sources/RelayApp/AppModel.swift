//
//  AppModel.swift
//  Общее состояние приложения: привязка, клиент, очередь ответов.
//

import Foundation
import Combine
import RelayKit

@MainActor
final class AppModel: ObservableObject {
    enum Status: Equatable {
        case pairing, ready
    }

    @Published private(set) var status: Status = .pairing
    @Published private(set) var pairing: StoredPairing?
    @Published private(set) var questions: QuestionsViewModel?
    @Published var errorText: String?

    private let secrets: SecretStore
    private let pairingService: PairingService
    private let storage: PairingStorage
    private var eventTask: Task<Void, Never>?

    init(
        secrets: SecretStore = KeychainStore(),
        storage: PairingStorage = UserDefaultsPairingStorage()
    ) {
        self.secrets = secrets
        self.storage = storage
        self.pairingService = PairingService(
            apiFactory: { baseURL in
                MainActor.assumeIsolated {
                    AppModel.makeClient(baseURL: baseURL, secrets: secrets)
                }
            },
            secrets: secrets,
            storage: storage
        )
        restore()
    }

    private static func makeClient(baseURL: URL, secrets: SecretStore) -> RelayClient {
        RelayClient(baseURL: baseURL, tokenProvider: {
            (try? secrets.read(PairingService.tokenKey)) ?? nil
        })
    }

    private func restore() {
        guard let stored = storage.load(),
              (try? secrets.read(PairingService.tokenKey)) != nil else {
            status = .pairing
            return
        }
        activate(stored)
    }

    func pair(baseURLText: String, pairCode: String) async {
        guard let baseURL = URL(string: baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)),
              baseURL.scheme == "https" || baseURL.scheme == "http" else {
            errorText = "URL должен начинаться с https:// или http://"
            return
        }
        do {
            let stored = try await pairingService.pair(baseURL: baseURL, pairCode: pairCode)
            activate(stored)
        } catch {
            errorText = "привязка не удалась: \(error.localizedDescription)"
        }
    }

    func unpair() {
        try? pairingService.unpair()
        eventTask?.cancel()
        questions = nil
        pairing = nil
        status = .pairing
    }

    private func activate(_ stored: StoredPairing) {
        pairing = stored
        status = .ready
        let client = Self.makeClient(baseURL: stored.baseURL, secrets: secrets)
        let queue = OfflineQueue(fileURL: Self.queueURL())
        let closedStore = FileClosedQuestionsStore(fileURL: Self.closedURL())
        let viewModel = QuestionsViewModel(api: client, queue: queue, closedStore: closedStore)
        questions = viewModel
        eventTask?.cancel()
        eventTask = Task { @MainActor [weak self] in
            for await event in client.events() {
                self?.questions?.apply(event: event)
                if case .questionAnswered = event {
                    await self?.questions?.load()
                }
            }
        }
        Task {
            await viewModel.flushQueue()
            await viewModel.load()
        }
    }

    private static func closedURL() -> URL {
        queueURL().deletingLastPathComponent().appendingPathComponent("closed-questions.json")
    }

    private static func queueURL() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("RelayClient", isDirectory: true)
            .appendingPathComponent("pending-answers.json")
    }
}
