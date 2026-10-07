import SwiftUI

@main
struct WayPointApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(WayPointStyle.teal)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active && model.canRefresh {
                        Task { await model.refresh() }
                    }
                }
        }
    }
}
