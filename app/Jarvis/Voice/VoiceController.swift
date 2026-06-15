import Foundation
import Combine

/// Coordinates voice: push-to-talk, "Hey Jarvis" wake word, and TTS.
/// Feeds transcripts into the OrchestratorClient and speaks its replies.
@MainActor
final class VoiceController: ObservableObject {
    enum AddressMode: String, CaseIterable, Identifiable {
        case auto, sir, maam, none
        var id: String { rawValue }
        var label: String { self == .maam ? "MA'AM" : rawValue.uppercased() }
    }

    @Published var partial = ""
    @Published var isListening = false
    @Published var wakeWordEnabled = false
    @Published var ttsEnabled = true
    @Published var followUpEnabled = true     // stay conversational after a reply
    @Published var inFollowUp = false         // currently inside the follow-up window
    @Published var authorized = false
    @Published var permissionDenied = false
    // Settings (issues 3 & F)
    @Published var addressMode: AddressMode = .auto
    @Published var audioMode: AudioMode = .dim
    @Published var dimLevel: Double = 30      // % for dim mode

    private enum Mode { case off, pushToTalk, wakeListening, wakeCapturing, followUp }
    private var mode: Mode = .off
    private var wakeIndex: String.Index?      // where the command starts after "jarvis"
    private var silenceTask: Task<Void, Never>?
    private var followUpTask: Task<Void, Never>?
    private var conversationActive = false    // a turn happened; keep the window open
    private let followUpSeconds: UInt64 = 45  // stay conversational a bit longer
    private let wakeWords = ["jarvis"]   // bare name; addressee is judged by the 2B

    private let speech = SpeechService()
    private let tts = TTSService()          // AVSpeechSynthesizer — fallback voice
    private let kokoro = KokoroTTSService() // natural Jarvis voice (local server)
    private let ducker = AudioDucker()      // dim background music while speaking
    private let gender = VoiceGender()      // Sir/Ma'am from voice pitch
    private unowned let client: OrchestratorClient

    init(client: OrchestratorClient) {
        self.client = client
        speech.onPartial = { [weak self] in self?.handlePartial($0) }
        speech.onFinal = { [weak self] in self?.handleFinal($0) }
        let g = gender   // capture the non-isolated analyzer (audio thread, no main-actor hop)
        speech.onBuffer = { buffer in g.process(buffer) }
        tts.onSpeakingChange = { [weak self] speaking in self?.handleSpeaking(speaking) }
        kokoro.onSpeakingChange = { [weak self] speaking in self?.handleSpeaking(speaking) }
        // If the Kokoro server is down, speak with AVSpeechSynthesizer instead.
        kokoro.onUnavailable = { [weak self] raw in self?.tts.speak(raw) }
        client.onIgnored = { [weak self] in self?.handleIgnored() }
        client.onDone = { [weak self] result in
            guard let self else { return }
            self.conversationActive = true   // a turn completed → open a follow-up window after speaking
            guard self.ttsEnabled else {
                // No speech to wait on; open the window now.
                self.handleSpeaking(false)
                return
            }
            self.kokoro.speak(result)   // → falls back to tts on failure
        }
    }

    // MARK: - Authorization

    func ensureAuthorized() async {
        if authorized { return }
        authorized = await speech.requestAuthorization()
        permissionDenied = !authorized
    }

    // MARK: - Push-to-talk

    func pushToTalkDown() {
        Task {
            await ensureAuthorized()
            guard authorized else { return }
            pauseWake()
            startSpeech(mode: .pushToTalk)
        }
    }

    func pushToTalkUp() {
        guard mode == .pushToTalk else { return }
        speech.stop()   // emits final → handleFinal sends it
    }

    // MARK: - Wake word

    func toggleWakeWord() {
        wakeWordEnabled.toggle()
        if wakeWordEnabled {
            Task {
                await ensureAuthorized()
                guard authorized else { wakeWordEnabled = false; return }
                startWake()
            }
        } else {
            stopAll()
        }
    }

    private func startWake() {
        startSpeech(mode: .wakeListening)
    }

    private func pauseWake() {
        followUpTask?.cancel()
        if mode == .wakeListening || mode == .wakeCapturing || mode == .followUp { speech.stop() }
    }

    // MARK: - Follow-up window (stay conversational after a reply, no wake word)

    private func startFollowUp() {
        guard followUpEnabled, authorized, !speech.isRunning else { return }
        startSpeech(mode: .followUp)
        inFollowUp = true
        armFollowUpTimer()
    }

    private func armFollowUpTimer() {
        followUpTask?.cancel()
        followUpTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: self.followUpSeconds * 1_000_000_000)
            guard !Task.isCancelled else { return }
            self.closeFollowUp()
        }
    }

    private func closeFollowUp() {
        followUpTask?.cancel()
        inFollowUp = false
        conversationActive = false
        if mode == .followUp { speech.stop(); isListening = false; mode = .off }
        resumeWakeIfEnabled()
    }

    // MARK: - Engine control

    private func startSpeech(mode newMode: Mode) {
        guard !speech.isRunning else { return }
        do {
            try speech.start()
            gender.reset()
            mode = newMode
            isListening = true
            partial = ""
            wakeIndex = nil
            if newMode != .wakeListening { client.state = .listening }
        } catch {
            isListening = false
            mode = .off
        }
    }

    private func stopAll() {
        silenceTask?.cancel()
        followUpTask?.cancel()
        speech.stop()
        isListening = false
        inFollowUp = false
        conversationActive = false
        mode = .off
        partial = ""
    }

    // MARK: - Recognition callbacks

    private func handlePartial(_ text: String) {
        partial = text
        switch mode {
        case .wakeListening:
            if let idx = matchWake(in: text) {
                mode = .wakeCapturing
                wakeIndex = idx
                client.state = .listening
            }
        case .wakeCapturing, .pushToTalk, .followUp:
            break
        case .off: return
        }
        // Any speech resets the silence countdown (used to auto-end an utterance).
        if mode == .wakeCapturing || mode == .pushToTalk || mode == .followUp {
            scheduleSilenceEnd()
            if mode == .followUp { armFollowUpTimer() }   // active talking keeps the window open
        }
    }

    private func handleFinal(_ text: String) {
        isListening = false
        let wasMode = mode
        mode = .off
        silenceTask?.cancel()
        gender.finalize()   // resolve Sir/Ma'am from this utterance's pitch

        switch wasMode {
        case .pushToTalk:
            dispatchVoice(text, triage: false)   // follow-up opens after the reply is spoken
        case .wakeCapturing:
            // Send the whole utterance (incl. the name) for addressee triage;
            // the orchestrator decides if Jarvis was actually addressed.
            dispatchVoice(text, triage: true)
        case .followUp:
            let cmd = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if cmd.isEmpty { startFollowUp() }   // nothing said — keep the window open
            else { dispatchVoice(cmd, triage: false) }
        default:
            resumeWakeIfEnabled()
        }
    }

    /// Fires when the mic has been silent for ~1.2s mid-utterance.
    private func scheduleSilenceEnd() {
        silenceTask?.cancel()
        silenceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard let self, !Task.isCancelled else { return }
            self.speech.stop()   // → handleFinal
        }
    }

    /// Send a voice command with the resolved honorific, attaching a screenshot
    /// (screen intent) or now-playing track (music intent) when relevant.
    private func dispatchVoice(_ text: String, triage: Bool) {
        let cmd = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cmd.isEmpty else { if !triage { resumeWakeIfEnabled() }; return }
        let h = resolvedHonorific()
        if isScreenIntent(cmd) {
            Task {
                let img = await ScreenContext.captureMainDisplayPNGBase64()
                client.sendPrompt(cmd, triage: triage, honorific: h, imageBase64: img)
            }
            return
        }
        let np = isMusicIntent(cmd) ? NowPlaying.current() : nil
        client.sendPrompt(cmd, triage: triage, honorific: h, nowPlaying: np)
    }

    /// HUD eye button — capture the screen and ask Jarvis to look.
    func lookAtScreen() {
        Task {
            let img = await ScreenContext.captureMainDisplayPNGBase64()
            client.sendPrompt("Look at my screen and tell me what's on it and anything notable.",
                              honorific: resolvedHonorific(), imageBase64: img)
        }
    }

    private func resolvedHonorific() -> String? {
        switch addressMode {
        case .auto: return gender.current == .none ? nil : gender.current.rawValue
        case .sir: return "sir"
        case .maam: return "maam"
        case .none: return nil
        }
    }

    private func isScreenIntent(_ t: String) -> Bool {
        let l = t.lowercased()
        return l.contains("my screen") || l.contains("on screen") || l.contains("looking at")
            || (l.contains("look at") && (l.contains("this") || l.contains("screen")))
    }
    private func isMusicIntent(_ t: String) -> Bool {
        let l = t.lowercased()
        return l.contains("what's playing") || l.contains("what is playing")
            || l.contains("this song") || l.contains("current track") || l.contains("what song")
    }

    // MARK: - TTS coordination

    private func handleSpeaking(_ speaking: Bool) {
        if speaking {
            // Dim background music (per setting) and don't let the mic hear Jarvis.
            ducker.mode = audioMode
            ducker.dimLevel = Int(dimLevel)
            ducker.duck()
            followUpTask?.cancel()
            if mode != .off && mode != .pushToTalk { speech.stop(); isListening = false; mode = .off }
        } else {
            ducker.restore()
            client.state = .idle
            // After a reply, stay conversational for a window (no wake word needed),
            // otherwise fall back to wake-word listening.
            if followUpEnabled, authorized, conversationActive {
                startFollowUp()
            } else {
                resumeWakeIfEnabled()
            }
        }
    }

    private func resumeWakeIfEnabled() {
        guard wakeWordEnabled, !speech.isRunning else { return }
        startWake()
    }

    /// Wake heard but the 2B judged it wasn't addressed to Jarvis — stay silent
    /// and resume listening (no reply, no follow-up window).
    private func handleIgnored() {
        isListening = false
        partial = ""
        resumeWakeIfEnabled()
    }

    // MARK: - Wake-word helpers

    private func matchWake(in text: String) -> String.Index? {
        let lower = text.lowercased()
        for w in wakeWords {
            if let r = lower.range(of: w, options: .backwards) {
                return text.index(text.startIndex, offsetBy: lower.distance(from: lower.startIndex, to: r.upperBound))
            }
        }
        return nil
    }

    private func command(from text: String) -> String {
        guard let idx = wakeIndex, idx <= text.endIndex else { return text }
        return String(text[idx...])
    }
}
