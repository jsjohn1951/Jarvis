import SwiftUI

/// Connection + voice settings. M1: manual entry of the Mac's host and pairing
/// token; the QR pairing scanner (M2) fills the same fields.
struct SettingsView: View {
    @EnvironmentObject private var client: OrchestratorClient
    @EnvironmentObject private var voice: MobileVoiceController
    @Environment(\.dismiss) private var dismiss

    @State private var host = Endpoints.host
    @State private var wsPort = String(Endpoints.wsPort)
    @State private var ttsPort = String(Endpoints.ttsPort)
    @State private var token = Endpoints.mobileToken
    @StateObject private var piperVoices = PiperVoiceModel()
    @State private var honorific = ""
    @State private var ttsOn = true
    @State private var preferLocal = false
    @State private var showScanner = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        showScanner = true
                    } label: {
                        Label("Scan pairing QR from Mac", systemImage: "qrcode.viewfinder")
                    }
                } footer: {
                    Text("Run scripts/ios-package.sh on your Mac and point the camera at the QR it prints.")
                }
                Section("Mac") {
                    TextField("Host (Tailscale name or LAN IP)", text: $host)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    TextField("Orchestrator port", text: $wsPort)
                        .keyboardType(.numberPad)
                    TextField("TTS port", text: $ttsPort)
                        .keyboardType(.numberPad)
                    SecureField("Pairing token", text: $token)
                    LabeledContent("Status", value: client.connected ? "connected" : "offline")
                }
                Section("Voice") {
                    Toggle("Speak replies", isOn: $ttsOn)
                    Picker("Address me as", selection: $honorific) {
                        Text("Sir").tag("sir")
                        Text("Ma'am").tag("maam")
                        Text("Neither").tag("")
                    }
                    // Same Piper catalog as the Mac HUD dropdown — served by the
                    // Mac's :8082, so it needs the connection; selection persists
                    // in "piperVoice" and KokoroTTSService uses it per request.
                    if piperVoices.voices.isEmpty {
                        LabeledContent("Jarvis voice", value: client.connected ? "loading…" : "connect to the Mac to choose")
                    } else {
                        Picker("Jarvis voice", selection: Binding(
                            get: { piperVoices.selectedId },
                            set: { id in Task { await piperVoices.select(id) } }
                        )) {
                            ForEach(piperVoices.voices) { v in
                                Text(v.downloaded ? v.name : "\(v.name)  ↓").tag(v.id)
                            }
                        }
                        .disabled(piperVoices.downloadingId != nil)
                        if piperVoices.downloadingId != nil {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Downloading voice on the Mac…").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if let err = piperVoices.errorText {
                            Text(err).font(.caption).foregroundStyle(.red)
                        }
                    }
                }
                ModelManagerView(manager: voice.models)
                Section {
                    Toggle("Prefer local for chat", isOn: $preferLocal)
                } footer: {
                    Text("When on, plain conversation runs on the phone's own model even while the Mac is reachable. Research always runs on-device once the model is downloaded; agent work (code, desktop, memory) always uses the Mac.")
                }
                Section {
                    Button("Save & Reconnect") { saveAndReconnect() }
                        .frame(maxWidth: .infinity)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
            }
            .onAppear {
                honorific = voice.honorific
                ttsOn = voice.ttsEnabled
                preferLocal = voice.preferLocal
                Task { await piperVoices.refresh() }
            }
            .sheet(isPresented: $showScanner) {
                PairingScannerView { payload in
                    showScanner = false
                    payload.apply()
                    host = payload.host
                    wsPort = String(payload.wsPort)
                    ttsPort = String(payload.ttsPort)
                    token = payload.token
                    client.connect()
                }
                .ignoresSafeArea()
            }
        }
    }

    private func saveAndReconnect() {
        Endpoints.host = host.trimmingCharacters(in: .whitespaces)
        if let p = Int(wsPort) { Endpoints.wsPort = p }
        if let p = Int(ttsPort) { Endpoints.ttsPort = p }
        Endpoints.mobileToken = token.trimmingCharacters(in: .whitespaces)
        voice.honorific = honorific
        voice.ttsEnabled = ttsOn
        voice.preferLocal = preferLocal
        client.connect()   // new URL/token picked up per-connection
        dismiss()
    }
}
