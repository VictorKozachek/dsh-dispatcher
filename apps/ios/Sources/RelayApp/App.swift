//
//  App.swift
//  RelayApp — минимальный iOS-клиент MVP: привязка, вопросы, ответ.
//

import SwiftUI
import RelayKit

@main
struct RelayApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(model)
        }
    }
}
