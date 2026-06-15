import SwiftUI

@main
struct JarvisApp: App {
    @StateObject private var client: OrchestratorClient
    @StateObject private var voice: VoiceController
    private let hotkey = Hotkey()

    init() {
        let c = OrchestratorClient()
        _client = StateObject(wrappedValue: c)
        _voice = StateObject(wrappedValue: VoiceController(client: c))
    }

    var body: some Scene {
        MenuBarExtra {
            HUDView(client: client, voice: voice)
                .onAppear {
                    client.connect()
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
    }
}
