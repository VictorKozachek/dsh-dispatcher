//
//  Views.swift
//  Экраны MVP: привязка, список вопросов, вопрос/ответ, закрытые.
//

import SwiftUI
import RelayKit

struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            switch model.status {
            case .pairing:
                PairingView()
            case .ready:
                TabView {
                    QuestionsListView()
                        .tabItem { Label("Вопросы", systemImage: "questionmark.bubble") }
                    ClosedListView()
                        .tabItem { Label("Закрытые", systemImage: "checkmark.circle") }
                    SettingsView()
                        .tabItem { Label("Настройки", systemImage: "gear") }
                }
            }
        }
    }
}

struct PairingView: View {
    @EnvironmentObject private var model: AppModel
    @State private var baseURL = "https://"
    @State private var pairCode = ""
    @State private var isPairing = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Релей") {
                    TextField("URL релея", text: $baseURL)
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                        .autocorrectionDisabled()
                }
                Section("Код привязки") {
                    TextField("6 цифр", text: $pairCode)
                        #if os(iOS)
                        .keyboardType(.numberPad)
                        #endif
                }
                if let error = model.errorText {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
                Section {
                    Button(isPairing ? "Привязываю…" : "Привязать") {
                        Task {
                            isPairing = true
                            await model.pair(baseURLText: baseURL, pairCode: pairCode)
                            isPairing = false
                        }
                    }
                    .disabled(isPairing || pairCode.count != 6 || baseURL.count < 8)
                }
            }
            .navigationTitle("Привязка")
        }
    }
}

struct QuestionsListView: View {
    @EnvironmentObject private var model: AppModel
    @State private var showPendingAlert = false

    var body: some View {
        NavigationStack {
            Group {
                if let viewModel = model.questions {
                    List(viewModel.openQuestions) { question in
                        NavigationLink(question.title ?? "Вопрос \(question.shortId)") {
                            QuestionDetailView(question: question, viewModel: viewModel)
                        }
                    }
                    .refreshable { await viewModel.load() }
                    .overlay {
                        if viewModel.openQuestions.isEmpty {
                            ContentUnavailableView("Нет открытых вопросов", systemImage: "checkmark.circle")
                        }
                    }
                    .toolbar {
                        if viewModel.pendingCount > 0 {
                            Button("В очереди: \(viewModel.pendingCount)") { showPendingAlert = true }
                        }
                    }
                    .alert("Ответы в очереди", isPresented: $showPendingAlert) {
                        Button("Отправить", role: .none) { Task { await viewModel.flushQueue() } }
                        Button("Позже", role: .cancel) {}
                    } message: {
                        Text("Ответы уйдут на релей, как только появится сеть.")
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Вопросы")
            .task { await model.questions?.load() }
        }
    }
}

struct QuestionDetailView: View {
    let question: RelayQuestion
    let viewModel: QuestionsViewModel
    @State private var selected: Set<String> = []
    @State private var customText = ""
    @State private var isSending = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section {
                if let title = question.title { Text(title).font(.headline) }
                if let body = question.body { Text(body) }
                if let detail = question.detail { Text(detail).foregroundStyle(.secondary) }
                if let workspace = question.workspace, let taskId = question.taskId {
                    Text("\(workspace) · #\(taskId)").font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section("Варианты") {
                ForEach(question.options) { option in
                    Button {
                        if question.multiSelect {
                            if selected.contains(option.id) { selected.remove(option.id) } else { selected.insert(option.id) }
                        } else {
                            selected = [option.id]
                        }
                    } label: {
                        HStack {
                            Text(option.label)
                            Spacer()
                            if selected.contains(option.id) {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            }
            if question.allowFreeText {
                Section("Свой ответ") {
                    TextEditor(text: $customText)
                        .frame(minHeight: 80)
                }
            }
            Section {
                Button(isSending ? "Отправляю…" : "Ответить") {
                    Task {
                        isSending = true
                        await viewModel.answer(question, selected: Array(selected), custom: customText)
                        isSending = false
                        dismiss()
                    }
                }
                .disabled(isSending || (selected.isEmpty && customText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }
        }
        .navigationTitle("Вопрос")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
    }
}

struct ClosedListView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            List(model.questions?.closedQuestions ?? []) { question in
                VStack(alignment: .leading) {
                    Text(question.title ?? "Вопрос \(question.shortId)").font(.headline)
                    Text(question.state == .answered ? "Отвечен" : "Истёк")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Закрытые")
            .overlay {
                if (model.questions?.closedQuestions ?? []).isEmpty {
                    ContentUnavailableView("Пока пусто", systemImage: "tray")
                }
            }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            Form {
                if let pairing = model.pairing {
                    Section("Привязка") {
                        Text(pairing.baseURL.absoluteString)
                        Text("Устройство: \(pairing.deviceId)").font(.footnote).foregroundStyle(.secondary)
                    }
                    Button("Отвязать", role: .destructive) { model.unpair() }
                }
                Section("О приложении") {
                    Text("MVP: WebSocket в foreground, фоновая проверка при запуске. APNs — опционально, см. README.")
                        .font(.footnote)
                }
            }
            .navigationTitle("Настройки")
        }
    }
}
