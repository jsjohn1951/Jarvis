import Foundation
import Combine

/// Slim iOS voice state machine: tap-to-talk with automatic end-of-utterance.
///
/// Deliberately much smaller than the Mac's VoiceController — no global hotkey, no
/// always-on wake word (iOS restricts background mic), no music ducking, no screen
/// context. Reuses the shared SpeechService (on-device STT) and KokoroTTSService
/// (Piper voice, synthesized ON-DEVICE via LocalPiperTTS — no Mac needed), with
/// TTSService (AVSpeech) as the fallback if the local engine can't load.
@MainActor
final class MobileVoiceController: ObservableObject {
    @Published var listening = false
    @Published var speaking = false
    @Published var partialText = ""
    @Published var micLevel: Float = 0
    @Published var permissionDenied = false

    var ttsEnabled: Bool {
        get { UserDefaults.standard.object(forKey: "jarvis.ttsEnabled") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "jarvis.ttsEnabled"); objectWillChange.send() }
    }
    /// "sir" | "maam" | "" — how Jarvis addresses the user (Settings picker).
    var honorific: String {
        get { UserDefaults.standard.string(forKey: "jarvis.honorific") ?? "sir" }
        set { UserDefaults.standard.set(newValue, forKey: "jarvis.honorific"); objectWillChange.send() }
    }
    /// Keep chat/research on-device even when the Mac is reachable (Settings toggle).
    var preferLocal: Bool {
        get { UserDefaults.standard.bool(forKey: "jarvis.preferLocal") }
        set { UserDefaults.standard.set(newValue, forKey: "jarvis.preferLocal"); objectWillChange.send() }
    }

    /// On-device tier (standalone mode). Weights load lazily on first local turn.
    let gemma = GemmaChat()
    let models = ModelManager()
    private let researchSkill = ResearchSkill()

    private let speech = SpeechService()
    private let tts = TTSService()          // on-device fallback voice (AVSpeech)
    private let kokoro = KokoroTTSService(synthesizer: LocalPiperTTS()) // on-device Piper (Joe)
    private let meter = AudioLevelMeter()
    private unowned let client: OrchestratorClient
    private var authorized = false
    /// End-of-utterance window. Keep ~1.2s: longer windows make the on-device
    /// recognizer return empty finals (same landmine as the Mac, see docs/VOICE.md).
    private let silenceMs: UInt64 = 1_200
    private var silenceTask: Task<Void, Never>?

    init(client: OrchestratorClient) {
        self.client = client
        speech.onPartial = { [weak self] in self?.handlePartial($0) }
        speech.onFinal = { [weak self] in self?.handleFinal($0) }
        let m = meter
        speech.onBuffer = { buffer in m.process(buffer) }
        meter.onLevel = { [weak self] level in
            Task { @MainActor in self?.micLevel = level }
        }
        tts.onSpeakingChange = { [weak self] in self?.speaking = $0 }
        kokoro.onSpeakingChange = { [weak self] in self?.speaking = $0 }
        kokoro.onUnavailable = { [weak self] raw in self?.tts.speak(raw) }
        client.onAck = { [weak self] text in
            guard let self, self.ttsEnabled, !text.isEmpty else { return }
            self.kokoro.speak(text)
        }
        client.onDone = { [weak self] result in
            guard let self, self.ttsEnabled else { return }
            self.kokoro.speak(result)
        }
        client.onCancelled = { [weak self] in self?.stopSpeaking() }
        AudioSessionController.shared.onInterruption = { [weak self] in
            self?.stopSpeaking()
            self?.abortListening()
        }
    }

    /// The mic button. Tap while idle → listen; while listening → send what was
    /// heard; while Jarvis is speaking → barge-in, then listen.
    func micTapped() {
        if speaking {
            stopSpeaking()
            client.sendCancel()
        }
        if listening { speech.stop() } else { startListening() }
    }

    func sendTyped(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        stopSpeaking()
        dispatch(trimmed)
    }

    // MARK: - Routing (Mac vs on-device)

    private func dispatch(_ text: String) {
        let route = TurnRouter.route(
            text: text,
            connected: client.connected,
            modelReady: ModelManager.installedModelURL() != nil,
            preferLocal: preferLocal
        )
        switch route {
        case .mac:
            client.sendPrompt(text, honorific: honorific.isEmpty ? nil : honorific)
        case .local(.chat):
            runLocal(text) { [gemma] deliver in
                try await gemma.reply(to: text) { delta in Task { @MainActor in deliver(delta) } }
            }
        case .local(.research):
            runLocal(text) { [gemma, researchSkill] deliver in
                try await researchSkill.run(text, gemma: gemma) { stage in deliver("· \(stage)\n") }
            }
        case .unavailable(let why):
            client.lastUserText = text
            client.transcript = why
            client.state = .alert
            if ttsEnabled { kokoro.speak(why) }
        }
    }

    /// Run a local turn, driving the same published HUD state the Mac path uses
    /// (the phone has one transcript surface, wherever the answer comes from).
    /// `work` receives a delta-sink for streaming progress/tokens and returns the
    /// final answer.
    private func runLocal(_ text: String, work: @escaping (@escaping @MainActor @Sendable (String) -> Void) async throws -> String) {
        client.lastUserText = text
        client.transcript = ""
        client.state = .thinking
        Task { @MainActor in
            do {
                let sink: @MainActor @Sendable (String) -> Void = { [weak client] delta in client?.transcript += delta }
                let result = try await work(sink)
                client.transcript = result
                client.state = ttsEnabled ? .speaking : .idle
                if ttsEnabled { kokoro.speak(result) }
            } catch {
                let msg = "Local model problem: \(error.localizedDescription)"
                client.transcript = "⚠︎ " + msg
                client.state = .alert
                if ttsEnabled { kokoro.speak(msg) }
            }
        }
    }

    private func startListening() {
        Task {
            if !authorized {
                authorized = await speech.requestAuthorization()
                permissionDenied = !authorized
                guard authorized else { return }
            }
            partialText = ""
            do { try speech.start(); listening = true } catch { listening = false }
        }
    }

    /// Cancel capture without sending (interruption / app background).
    private func abortListening() {
        silenceTask?.cancel()
        guard listening else { return }
        speech.onFinal = { [weak self] _ in self?.restoreFinalHandler() }
        speech.stop()
        listening = false
        partialText = ""
    }

    private func restoreFinalHandler() {
        speech.onFinal = { [weak self] in self?.handleFinal($0) }
    }

    private func handlePartial(_ text: String) {
        partialText = text
        // Restart the end-of-utterance window on every partial; silence ends the turn.
        silenceTask?.cancel()
        silenceTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: self.silenceMs * 1_000_000)
            if !Task.isCancelled { self.speech.stop() }
        }
    }

    private func handleFinal(_ text: String) {
        silenceTask?.cancel()
        listening = false
        partialText = ""
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        dispatch(trimmed)
    }

    private func stopSpeaking() {
        kokoro.stop()
        tts.stop()
        speaking = false
    }
}
