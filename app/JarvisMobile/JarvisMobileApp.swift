import SwiftUI

/// iOS companion client. The Mac runs the whole Jarvis stack (orchestrator, Claude
/// Agent SDK, TTS); this app is the voice/text surface, reached over LAN or the
/// tailnet. See docs/IOS.md.
@main
struct JarvisMobileApp: App {
    @StateObject private var client: OrchestratorClient
    @StateObject private var voice: MobileVoiceController

    init() {
        let client = OrchestratorClient()
        _client = StateObject(wrappedValue: client)
        _voice = StateObject(wrappedValue: MobileVoiceController(client: client))
    }

    var body: some Scene {
        WindowGroup {
            TabView {
                MobileHUDView()
                    .tabItem { Label("Jarvis", systemImage: "waveform.circle") }
                AgentPanelView()
                    .tabItem { Label("Agents", systemImage: "square.grid.2x2") }
            }
            .environmentObject(client)
            .environmentObject(voice)
            .task {
                AudioSessionController.shared.configure()
                client.connect()
            }
        }
    }
}
