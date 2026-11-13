import SwiftUI

@main
struct InboxApp: App {
  @State private var store: Store
  @Environment(\.scenePhase) private var phase
  // Hosting the unit tests, the app draws nothing and asks nothing.
  private let testing = ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

  init() {
    let store = Store()
    #if DEBUG
      store.applyLaunchArguments()
    #endif
    _store = State(initialValue: store)
  }

  var body: some Scene {
    WindowGroup {
      if testing {
        Color.clear
      } else {
        RootView()
          .environment(store)
          .tint(Theme.accent)
          // The stream lives only while the app is in front; coming back reads at once.
          .onChange(of: phase, initial: true) { _, phase in
            if phase == .active {
              store.now = Date()
              store.startLive()
            } else if phase == .background {
              store.stopLive()
            }
          }
          .task {
            // Ages move on while the page sits open.
            while !Task.isCancelled {
              try? await Task.sleep(for: .seconds(30))
              store.now = Date()
            }
          }
      }
    }
  }
}

struct RootView: View {
  @Environment(Store.self) private var store

  var body: some View {
    Group {
      if store.address == nil {
        ConnectView()
      } else {
        DeskView()
      }
    }
    .background(Theme.paper.ignoresSafeArea())
  }
}
