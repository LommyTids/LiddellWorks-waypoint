import SwiftUI

@main
struct WayPointApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(Color(red: 0.04, green: 0.43, blue: 0.43))
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active && model.canRefresh {
                        Task { await model.refresh() }
                    }
                }
        }
    }
}
