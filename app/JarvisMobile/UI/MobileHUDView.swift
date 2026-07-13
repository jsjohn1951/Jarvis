import SwiftUI

/// Single-screen HUD: status orb, live transcript, mic button, text input.
struct MobileHUDView: View {
    @EnvironmentObject private var client: OrchestratorClient
    @EnvironmentObject private var voice: MobileVoiceController
    @State private var typed = ""
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                statusHeader
                transcript
                Spacer(minLength: 0)
                ArcReactorView(state: reactorState, level: voice.micLevel)
                micButton
                inputBar
            }
            .padding()
            .navigationTitle("Jarvis")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsView() }
        }
    }

    /// Local voice activity wins over the (possibly stale) orchestrator state.
    private var reactorState: HUDState {
        if voice.listening { return .listening }
        if voice.speaking { return .speaking }
        return client.connected ? client.state : .idle
    }

    private var stateColor: Color {
        if !client.connected { return .gray }
        switch client.state {
        case .idle: return .cyan
        case .listening: return .green
        case .thinking: return .orange
        case .speaking: return .blue
        case .alert: return .red
        }
    }

    private var stateLabel: String {
        if !client.connected { return "OFFLINE" }
        if voice.listening { return "LISTENING" }
        return client.state.rawValue.uppercased()
    }

    private var statusHeader: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(stateColor)
                .frame(width: 12, height: 12)
                .shadow(color: stateColor.opacity(0.8), radius: 6)
            Text(stateLabel)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            Spacer()
            if !client.activeAgent.isEmpty {
                Text(client.activeAgent)
                    .font(.caption2.monospaced())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(.quaternary))
            }
        }
    }

    private var transcript: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if !client.lastUserText.isEmpty {
                    Text(client.lastUserText)
                        .font(.callout)
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 12).fill(.quaternary))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                if voice.listening && !voice.partialText.isEmpty {
                    Text(voice.partialText)
                        .font(.callout.italic())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                if !client.transcript.isEmpty {
                    Text(client.transcript)
                        .font(.callout)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                if !client.toolTrail.isEmpty {
                    Text(client.toolTrail.joined(separator: " · "))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .defaultScrollAnchor(.bottom)
    }

    private var micButton: some View {
        Button(action: { voice.micTapped() }) {
            ZStack {
                Circle()
                    .fill(voice.listening ? Color.green.opacity(0.25) : Color.cyan.opacity(0.15))
                    .frame(width: 96, height: 96)
                    .scaleEffect(voice.listening ? 1 + CGFloat(min(voice.micLevel, 1)) * 0.35 : 1)
                    .animation(.easeOut(duration: 0.1), value: voice.micLevel)
                Image(systemName: voice.listening ? "waveform" : (voice.speaking ? "stop.fill" : "mic.fill"))
                    .font(.system(size: 34))
                    .foregroundStyle(voice.listening ? .green : .cyan)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(voice.listening ? "Stop listening" : "Start listening")
    }

    private var inputBar: some View {
        HStack {
            TextField("Type to Jarvis…", text: $typed)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.send)
                .onSubmit(submitTyped)
            Button(action: submitTyped) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                .disabled(typed.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private func submitTyped() {
        voice.sendTyped(typed)
        typed = ""
    }
}
