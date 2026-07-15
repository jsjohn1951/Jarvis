import SwiftUI

/// iOS companion client. The Mac runs the whole Jarvis stack (orchestrator, Claude
/// Agent SDK, TTS); this app is the voice/text surface, reached over LAN or the
/// tailnet. See docs/IOS.md.
@main
struct JarvisMobileApp: App {
    @StateObject private var client: OrchestratorClient
    @StateObject private var voice: MobileVoiceController
    @Environment(\.scenePhase) private var scenePhase

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
            .onChange(of: scenePhase) { _, phase in
                // iOS froze the socket while backgrounded; verify it the moment the
                // app is back, so the HUD flips to OFFLINE in ~1 s instead of lying.
                if phase == .active { client.nudge() }
            }
        }
    }
}

/// Dismiss the keyboard from anywhere (tap-to-dismiss, keyboard "Done" buttons).
func hideKeyboard() {
    UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

/// Tap anywhere that isn't an input field (or other control — child gestures win
/// over this parent tap) to dismiss the keyboard, so it can't trap the tab bar.
/// ONLY safe on plain stack layouts: on List/Form the gesture swallows row-button
/// taps (it broke the Settings buttons once — use a keyboard toolbar there).
extension View {
    func dismissKeyboardOnTap() -> some View {
        contentShape(Rectangle()).onTapGesture { hideKeyboard() }
    }
}
