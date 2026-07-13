import SwiftUI
import AppKit

/// The menu-bar popover — the distilled Command Center (docs/DESIGN.md):
/// arc-reactor state, live transcript, active agent, health row, voice + text input.
struct HUDView: View {
    @ObservedObject var client: OrchestratorClient
    @ObservedObject var voice: VoiceController
    /// Set when hosted in the floating panel — shows a close button that hides it.
    var onClose: (() -> Void)? = nil
    /// Set only on the menu-bar popover instance — reports when the popover opens/closes
    /// so the floating panel can avoid stacking a second HUD behind an open popover.
    var onVisibilityChange: ((Bool) -> Void)? = nil
    @State private var input = ""
    @State private var micDown = false
    @StateObject private var piperVoices = PiperVoiceModel()
    @StateObject private var services = ServiceController()
    @State private var confirmStop: StopTarget? = nil

    /// Stop actions that need a "shared with claude-hybrid" confirmation first.
    enum StopTarget: String, Identifiable {
        case stack, proxy
        var id: String { rawValue }
    }
    @FocusState private var inputFocused: Bool
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 14) {
            header
            ArcReactorView(state: client.state)
            stateLine
            transcriptPanel
            healthRow
            servicesRow
            voiceRow
            settingsRow
            voicePickerRow
            commandField
        }
        .padding(16)
        .frame(width: 380)
        .glassSurface()
        .overlay(CornerBrackets().padding(6))
        .onAppear {
            client.requestHealth(); client.requestRegistry(); inputFocused = true
            Task { await piperVoices.refresh() }
            refreshServices()
            onVisibilityChange?(true)
        }
        .onDisappear { onVisibilityChange?(false) }
        .onChange(of: client.connected) { refreshServices() }
        .onChange(of: client.health.router) { refreshServices() }
        .confirmationDialog(
            confirmStop == .stack ? "Stop the whole Jarvis stack?" : "Stop the router proxy?",
            isPresented: Binding(get: { confirmStop != nil }, set: { if !$0 { confirmStop = nil } }),
            titleVisibility: .visible
        ) {
            Button(confirmStop == .stack ? "Stop Stack" : "Stop Proxy", role: .destructive) {
                let target = confirmStop
                confirmStop = nil
                Task {
                    if target == .stack { await services.stopStack() }
                    else { await services.stopProxy() }
                }
            }
            Button("Cancel", role: .cancel) { confirmStop = nil }
        } message: {
            Text(confirmStop == .stack
                ? "This also stops the shared 9B llama server and the :9090 router proxy — any active claude-hybrid Claude Code session loses them, not just Jarvis."
                : "The router proxy on :9090 is shared with your claude-hybrid Claude Code stack — stopping it breaks any active claude-hybrid session, not just Jarvis.")
        }
    }

    // MARK: pieces

    private var header: some View {
        HStack {
            Text("J.A.R.V.I.S")
                .font(Theme.display(16)).tracking(3)
                .foregroundStyle(Theme.onSurface)
            Spacer()
            Button { voice.lookAtScreen() } label: {
                Image(systemName: "eye").font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.onSurfaceVariant)
            }
            .buttonStyle(.plain).help("Look at my screen")
            Button { openWindow(id: "registry") } label: {
                Image(systemName: "square.grid.2x2").font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.onSurfaceVariant)
            }
            .buttonStyle(.plain).help("Open Agent Registry")
            Button { openWindow(id: "settings") } label: {
                Image(systemName: "gearshape").font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.onSurfaceVariant)
            }
            .buttonStyle(.plain).help("Settings")
            Button { client.shutdownBackend { NSApplication.shared.terminate(nil) } } label: {
                Image(systemName: "power").font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.onSurfaceVariant)
            }
            .buttonStyle(.plain).help("Power off Jarvis & backend")
            .keyboardShortcut("q", modifiers: .command)
            Image(systemName: "iphone")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(client.phoneConnected ? Theme.primary : Theme.outline)
                .shadow(color: client.phoneConnected ? Theme.primary.opacity(0.8) : .clear, radius: 4)
                .help(client.phoneConnected
                    ? "iPhone connected" + (client.phoneDevice.isEmpty ? "" : " — \(client.phoneDevice)")
                    : "No phone connected")
            Circle()
                .fill(client.connected ? Theme.primary : Theme.alert)
                .frame(width: 7, height: 7)
                .shadow(color: (client.connected ? Theme.primary : Theme.alert).opacity(0.8), radius: 4)
            Text(client.connected ? "ONLINE" : "OFFLINE")
                .font(Theme.label()).tracking(1.5)
                .foregroundStyle(Theme.onSurfaceVariant)
            if let onClose {
                Button(action: onClose) {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(Theme.onSurfaceVariant)
                }
                .buttonStyle(.plain).help("Hide")
                .keyboardShortcut(.cancelAction)
            }
        }
    }

    private var stateLine: some View {
        HStack(spacing: 6) {
            Text(client.state.rawValue.uppercased())
                .font(Theme.label()).tracking(2)
                .foregroundStyle(client.state == .alert ? Theme.alert : Theme.primary)
            if !client.activeAgent.isEmpty {
                Text("· \(client.activeAgent)").font(Theme.mono).foregroundStyle(Theme.onSurfaceVariant)
                Text("[\(client.agentVia)]").font(Theme.mono).foregroundStyle(Theme.outline)
            }
            Spacer()
            if voice.inFollowUp {
                Text("● LISTENING").font(Theme.label()).tracking(1.5).foregroundStyle(Theme.primary)
            }
        }
        .frame(height: 14)
    }

    private var transcriptPanel: some View {
        GlassPanel {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    // While the user speaks, show a live waveform instead of echoing the
                    // transcribed words — the panel keeps only Jarvis's reply as text.
                    if voice.isListening {
                        WaveformView(levels: voice.micLevels)
                            .frame(maxWidth: .infinity)
                    }
                    Text(client.transcript.isEmpty ? "Awaiting command…" : client.transcript)
                        .font(Theme.body)
                        .foregroundStyle(client.transcript.isEmpty ? Theme.outline : Theme.onSurface)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !client.toolTrail.isEmpty {
                        Text(client.toolTrail.joined(separator: " → "))
                            .font(Theme.mono).foregroundStyle(Theme.primary.opacity(0.7))
                    }
                }
            }
            .frame(height: 140)
        }
    }

    private var healthRow: some View {
        HStack(spacing: 8) {
            healthChip("llama", client.health.llama)
            healthChip("router", client.health.router)
            healthChip("quick", client.health.quick)
            Spacer()
        }
    }

    // Start/stop the backend from the HUD. STACK is everything (start-jarvis.sh /
    // stop-jarvis.sh --keep-app); ORCH and PROXY are individual. Stops that touch
    // the shared claude-hybrid router go through the confirmation dialog.
    private var servicesRow: some View {
        HStack(spacing: 10) {
            toggle("STACK", on: services.stackUp) {
                if services.stackUp { confirmStop = .stack }
                else { Task { await services.startStack(); client.requestHealth() } }
            }
            toggle("ORCH", on: services.orchestratorUp) {
                Task {
                    if services.orchestratorUp { await services.stopOrchestrator() }
                    else { await services.startOrchestrator() }
                }
            }
            toggle("PROXY", on: services.proxyUp) {
                if services.proxyUp { confirmStop = .proxy }
                else { Task { await services.startProxy(); client.requestHealth() } }
            }
            if services.busy != nil { ProgressView().controlSize(.small) }
            Spacer()
        }
        .disabled(services.busy != nil)
    }

    private func refreshServices() {
        Task { await services.refresh(connected: client.connected, routerHealthy: client.health.router) }
    }

    private func healthChip(_ label: String, _ ok: Bool) -> some View {
        HStack(spacing: 4) {
            Circle().fill(ok ? Theme.primary : Theme.alert).frame(width: 6, height: 6)
            Text(label).font(Theme.mono).foregroundStyle(Theme.onSurfaceVariant)
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .overlay(RoundedRectangle(cornerRadius: Theme.radius).strokeBorder(Theme.outline.opacity(0.4), lineWidth: 1))
    }

    private var voiceRow: some View {
        HStack(spacing: 10) {
            // Press-and-hold to talk.
            micButton
            toggle("WAKE", on: voice.wakeWordEnabled) { voice.toggleWakeWord() }
            toggle("FOLLOW", on: voice.followUpEnabled) { voice.followUpEnabled.toggle() }
            toggle("VOICE", on: voice.ttsEnabled) { voice.ttsEnabled.toggle() }
            Spacer()
            if voice.permissionDenied {
                Text("mic denied — enable in System Settings")
                    .font(Theme.mono).foregroundStyle(Theme.alert)
            }
        }
    }

    private var micButton: some View {
        Image(systemName: voice.isListening ? "mic.fill" : "mic")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(voice.isListening ? Theme.base : Theme.primary)
            .frame(width: 38, height: 30)
            .background(voice.isListening ? Theme.primary : Theme.surface)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius)
                .strokeBorder(Theme.primary.opacity(0.5), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in if !micDown { micDown = true; voice.pushToTalkDown() } }
                    .onEnded { _ in micDown = false; voice.pushToTalkUp() }
            )
            .help("Hold to talk")
    }

    private func toggle(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(Theme.label()).tracking(1.2)
                .foregroundStyle(on ? Theme.onPrimary : Theme.onSurfaceVariant)
                .padding(.horizontal, 10).padding(.vertical, 7)
                .background(on ? Theme.primary : Theme.surface)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius)
                    .strokeBorder(Theme.outline.opacity(0.4), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
        }
        .buttonStyle(.plain)
    }

    // Address form + background-audio behavior. Cycling chips keep the popover compact.
    private var settingsRow: some View {
        HStack(spacing: 10) {
            chip("ADDR · \(voice.addressMode.label)") {
                let all = VoiceController.AddressMode.allCases
                voice.addressMode = all[(all.firstIndex(of: voice.addressMode)! + 1) % all.count]
            }
            chip("AUDIO · \(voice.audioMode.label)") {
                let all = AudioMode.allCases
                voice.audioMode = all[(all.firstIndex(of: voice.audioMode)! + 1) % all.count]
            }
            if voice.audioMode == .dim {
                Slider(value: $voice.dimLevel, in: 5...90, step: 5)
                    .controlSize(.mini).tint(Theme.primary).frame(width: 70)
                Text("\(Int(voice.dimLevel))%").font(Theme.mono).foregroundStyle(Theme.onSurfaceVariant)
            }
            Spacer()
        }
    }

    private func chip(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(Theme.label()).tracking(1.0)
                .foregroundStyle(Theme.onSurfaceVariant)
                .padding(.horizontal, 8).padding(.vertical, 6)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius)
                    .strokeBorder(Theme.outline.opacity(0.4), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    // Piper TTS voice selection. The menu shows the current voice name; voices
    // not yet downloaded are marked "⤓" and fetched on selection (spinner shown).
    private var voicePickerRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "waveform")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.onSurfaceVariant)
            Picker("", selection: Binding(
                get: { piperVoices.selectedId },
                set: { id in Task { await piperVoices.select(id) } }
            )) {
                ForEach(piperVoices.voices) { v in
                    Text(v.downloaded ? v.name : "\(v.name)  ⤓").tag(v.id)
                }
            }
            .labelsHidden()
            .tint(Theme.primary)
            .font(Theme.body)
            .disabled(piperVoices.downloadingId != nil)

            if piperVoices.downloadingId != nil {
                ProgressView().controlSize(.mini)
            }
            Spacer()
            if let e = piperVoices.errorText {
                Text(e).font(Theme.mono).foregroundStyle(Theme.alert)
            }
        }
    }

    private var commandField: some View {
        HStack(spacing: 8) {
            TextField("Command Jarvis…", text: $input)
                .textFieldStyle(.plain).font(Theme.body)
                .foregroundStyle(Theme.onSurface)
                .focused($inputFocused)
                .onSubmit(submit)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .background(Theme.surface)
                .overlay(RoundedRectangle(cornerRadius: Theme.radius)
                    .strokeBorder(inputFocused ? Theme.primary.opacity(0.6) : Theme.outline.opacity(0.4), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius))

            Button(action: submit) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 22)).foregroundStyle(Theme.primary)
            }
            .buttonStyle(.plain)
        }
    }

    private func submit() {
        let text = input
        input = ""
        client.sendPrompt(text)
    }
}
