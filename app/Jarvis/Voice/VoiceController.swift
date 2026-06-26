import Foundation
import Combine
import os

/// Coordinates voice: push-to-talk, "Hey Jarvis" wake word, and TTS.
/// Feeds transcripts into the OrchestratorClient and speaks its replies.
@MainActor
final class VoiceController: ObservableObject {
    static let log = Logger(subsystem: "com.jarvis.voice", category: "controller")
    enum AddressMode: String, CaseIterable, Identifiable {
        case auto, sir, maam, none
        var id: String { rawValue }
        var label: String { self == .maam ? "MA'AM" : rawValue.uppercased() }
    }

    @Published var partial = ""
    @Published var isListening = false
    @Published var micLevels: [Float] = Array(repeating: 0, count: VoiceController.waveBars)
    static let waveBars = 28
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
    private var speakingAck = false           // speaking the instant ack; cloud reply still coming
    private let followUpSeconds: UInt64 = 45  // stay conversational a bit longer
    // End-of-utterance (endpointing): how long the mic may stay silent before we treat the
    // utterance as finished. Longer than the old fixed 1.2s so a normal thinking pause no
    // longer cuts the user off; extended further when the words trail off mid-clause (a
    // copula/preposition/conjunction/article/number — the user is clearly mid-thought).
    // End-of-utterance silence window. KEEP THIS ~1.2s. Confirmed by A/B (2026-06-24): a
    // longer window (the earlier 2–4s adaptive "anti-cutoff" endpointing) makes the on-device
    // SFSpeechRecognizer finalize with an EMPTY 0-char transcript — the capture session runs
    // long enough that the recognizer discards its own hypothesis. Both values are equal for
    // now (no adaptive extension is active); the endpointDelayMs scaffolding below is retained
    // for a future anti-cutoff attempt, but only raise these in SMALL steps with on-device
    // testing, watching the logs for `speech done: 0 chars` regressions.
    private let baseSilenceMs: UInt64 = 1_200
    private let midClauseSilenceMs: UInt64 = 1_200
    private let wakeWords = ["jarvis"]   // bare name; addressee is judged by the 2B

    private let speech = SpeechService()
    private let tts = TTSService()          // AVSpeechSynthesizer — fallback voice
    private let kokoro = KokoroTTSService() // natural Jarvis voice (local server)
    private let ducker = AudioDucker()      // dim background music while speaking
    private let gender = VoiceGender()      // Sir/Ma'am from voice pitch
    private let meter = AudioLevelMeter()   // mic loudness → HUD waveform
    private unowned let client: OrchestratorClient

    init(client: OrchestratorClient) {
        self.client = client
        speech.onPartial = { [weak self] in self?.handlePartial($0) }
        speech.onFinal = { [weak self] in self?.handleFinal($0) }
        // Capture the non-isolated analyzers (audio thread, no main-actor hop). Both
        // the gender estimator and the loudness meter read each mic buffer.
        let g = gender
        let m = meter
        speech.onBuffer = { buffer in g.process(buffer); m.process(buffer) }
        meter.onLevel = { [weak self] level in
            Task { @MainActor in self?.pushLevel(level) }
        }
        tts.onSpeakingChange = { [weak self] speaking in self?.handleSpeaking(speaking) }
        kokoro.onSpeakingChange = { [weak self] speaking in self?.handleSpeaking(speaking) }
        // If the Kokoro server is down, speak with AVSpeechSynthesizer instead.
        kokoro.onUnavailable = { [weak self] raw in self?.tts.speak(raw) }
        client.onIgnored = { [weak self] in self?.handleIgnored() }
        // Instant local acknowledgment: speak it immediately while the cloud works.
        // It is NOT a turn completion, so it must not open the follow-up window or
        // flip state to idle (handleSpeaking honors `speakingAck`).
        client.onAck = { [weak self] text in
            guard let self, self.ttsEnabled, !text.isEmpty else { return }
            self.speakingAck = true
            self.kokoro.speak(text)
        }
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
            micLevels = Array(repeating: 0, count: Self.waveBars)
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

    /// Append the latest mic loudness, scrolling the bar window (newest on the right).
    private func pushLevel(_ level: Float) {
        guard isListening else { return }
        micLevels.removeFirst()
        micLevels.append(level)
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
        Self.log.info("handleFinal: mode \(String(describing: wasMode), privacy: .public), \(text.count, privacy: .public) chars")

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

    /// Fires when the mic has been silent long enough to treat the utterance as done.
    /// The delay adapts to the transcript so far: if the user trailed off mid-clause
    /// ("…and", "…with", a trailing comma, a filler word) we wait longer before ending,
    /// so a natural pause to gather a thought doesn't cut them off.
    private func scheduleSilenceEnd() {
        silenceTask?.cancel()
        let delayMs = endpointDelayMs()
        silenceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
            guard let self, !Task.isCancelled else { return }
            self.speech.stop()   // → handleFinal
        }
    }

    /// Choose the silence window from the current partial transcript. If the utterance so
    /// far trails off mid-clause, the user is mid-thought — wait longer before ending.
    private func endpointDelayMs() -> UInt64 {
        let p = partial.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        guard !p.isEmpty else { return baseSilenceMs }
        // A comma/colon/dash, or a connective with no sentence-final punctuation ⇒ more is coming.
        if p.hasSuffix(",") || p.hasSuffix(":") || p.hasSuffix("-") { return midClauseSilenceMs }
        let last = String(p.split(separator: " ").last ?? "")
        // A trailing number ("started around 2019", "about 5") — people pause near a figure.
        if last.range(of: #"^\d[\d,.]*$"#, options: .regularExpression) != nil { return midClauseSilenceMs }
        // Words that almost never END a spoken sentence — trailing one ⇒ mid-thought.
        if Self.continuationWords.contains(last) { return midClauseSilenceMs }
        return baseSilenceMs
    }

    /// Tokens that signal the speaker isn't done (used by endpointDelayMs).
    private static let continuationWords: Set<String> = [
        // articles / determiners / possessives
        "a", "an", "the", "my", "your", "his", "her", "its", "our", "their",
        "this", "that", "these", "those", "some", "any", "no", "every",
        // conjunctions
        "and", "or", "but", "nor", "so", "yet", "because", "although", "while", "whereas", "plus",
        // prepositions
        "to", "of", "for", "with", "in", "on", "at", "by", "from", "as", "into", "onto",
        "about", "around", "over", "under", "after", "before", "between", "through", "via", "near",
        // copulas / auxiliaries / modals
        "is", "am", "are", "was", "were", "be", "been", "being", "has", "have", "had",
        "do", "does", "did", "will", "would", "can", "could", "should", "may", "might", "must", "shall",
        // subordinators / relatives / interrogatives left dangling
        "if", "then", "which", "who", "whom", "whose", "when", "where", "what", "how",
        // fillers / hedges, plus "called" ("a company called …" expects a name next)
        "um", "uh", "er", "erm", "like", "well", "i", "called",
    ]

    /// Send a voice command with the resolved honorific, attaching a screenshot
    /// (screen intent) or now-playing track (music intent) when relevant.
    private func dispatchVoice(_ text: String, triage: Bool) {
        let cmd = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // An empty capture (recognition heard nothing usable) must NEVER strand the app on
        // "listening": reset the HUD to idle and re-arm wake listening so the user can retry.
        // Previously the triage path returned without re-arming, leaving the mic off while the
        // HUD still showed "listening" (and the wake never resumed).
        guard !cmd.isEmpty else {
            Self.log.info("dispatchVoice: empty transcript (triage \(triage, privacy: .public)) — re-arming")
            client.state = .idle
            resumeWakeIfEnabled()
            return
        }
        Self.log.info("dispatchVoice: sending prompt (triage \(triage, privacy: .public), \(cmd.count, privacy: .public) chars)")
        let h = resolvedHonorific()
        // Screen questions ("look at my screen") AND desktop-control commands ("in
        // VSCode…", "click…") both attach a screenshot so the vision-capable agent
        // can see the foreground app before acting on it.
        if isScreenIntent(cmd) || isDesktopIntent(cmd) {
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
            // "take a screenshot" → attach the REAL screen (ScreenCaptureKit) so Jarvis
            // never substitutes a browser screenshot.
            || l.contains("screenshot") || l.contains("screen shot")
            || l.contains("take a picture") || (l.contains("capture") && l.contains("screen"))
    }
    /// App-control phrasing — routes to the `desktop` agent and attaches a screenshot
    /// so Jarvis can see the UI it's about to act on.
    private func isDesktopIntent(_ t: String) -> Bool {
        let l = t.lowercased()
        return l.contains("vscode") || l.contains("vs code")
            || l.contains("in chrome") || l.contains("in safari")
            || l.contains("click ") || l.contains("type ")
            || l.contains("switch to") || l.contains("the menu")
            || (l.contains("edit") && l.contains("this"))
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
            // The ack just finished, but the real (cloud) reply is still coming — keep
            // the turn alive: don't go idle, don't resume listening yet.
            if speakingAck {
                speakingAck = false
                return
            }
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
