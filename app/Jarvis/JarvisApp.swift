import SwiftUI

@main
struct JarvisApp: App {
    @StateObject private var client: OrchestratorClient
    @StateObject private var voice: VoiceController
    @StateObject private var providers = ProviderSettings()
    private let hotkey = Hotkey()

    init() {
        let c = OrchestratorClient()
        _client = StateObject(wrappedValue: c)
        _voice = StateObject(wrappedValue: VoiceController(client: c))
        // Play the startup chime at launch. `init()` (not HUDView.onAppear, which
        // only fires when the menu-bar popover first opens) is the true-launch seam.
        StartupSound.play()
    }

    var body: some Scene {
        MenuBarExtra {
            HUDView(client: client, voice: voice)
                .onAppear {
                    client.connect()
                    providers.push(to: client)   // apply saved Ollama fallback config
                    hotkey.onTrigger = { [weak voice] in voice?.pushToTalkDown() }
                    hotkey.enable()
                }
        } label: {
            Image(systemName: client.connected ? "circle.hexagongrid.circle.fill" : "circle.hexagongrid.circle")
        }
        .menuBarExtraStyle(.window)

        // Expanded HUD — the full Agent Registry + model hot-swap.
        Window("Agent Registry", id: "registry") {
            RegistryView(client: client)
        }
        .windowResizability(.contentMinSize)

        // Settings — alternate provider (Ollama Cloud) fallback configuration.
        Window("Jarvis Settings", id: "settings") {
            SettingsView(client: client, providers: providers)
        }
        .windowResizability(.contentSize)
    }
}
