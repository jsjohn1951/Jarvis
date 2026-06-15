import AVFoundation

/// Jarvis's voice. Speaks summaries, never raw code — code fences and overly long
/// output are stripped/capped so it sounds like an assistant, not a dictation bot.
@MainActor
final class TTSService: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    var enabled = true
    var rate: Float = 0.48          // slightly measured — a calm, deliberate Jarvis cadence
    /// Called on the main actor when speech starts / ends — used to pause the mic
    /// during wake-word mode so Jarvis doesn't hear itself.
    var onSpeakingChange: ((Bool) -> Void)?

    /// The chosen voice (best available; user-overridable). nil → system default.
    private(set) var voice: AVSpeechSynthesisVoice?

    override init() {
        super.init()
        synth.delegate = self
        voice = Self.bestJarvisVoice()
    }

    /// Pick the most natural English voice that's actually installed: prefer a
    /// British male premium/enhanced voice (the Jarvis feel), then any premium /
    /// enhanced English voice, then a sensible default. Premium voices must be
    /// downloaded in System Settings → Accessibility → Spoken Content → Manage
    /// Voices; until then this falls back gracefully. See docs/VOICE.md.
    static func bestJarvisVoice() -> AVSpeechSynthesisVoice? {
        let all = AVSpeechSynthesisVoice.speechVoices()
        let english = all.filter { $0.language.hasPrefix("en") }
        // Character first (British, male-sounding), THEN quality — so you get the
        // Jarvis voice immediately and it auto-upgrades when you download the
        // enhanced/premium version of that voice.
        let jarvisNames = ["oliver", "daniel", "arthur", "jamie", "malcolm", "rishi"]
        func rank(_ v: AVSpeechSynthesisVoice) -> Int {
            var score = 0
            if v.language == "en-GB" { score += 1000 }              // British
            if v.language.hasPrefix("en-AU") || v.language.hasPrefix("en-IE") { score += 300 }
            let n = v.name.lowercased()
            if jarvisNames.contains(where: n.contains) { score += 500 }   // male, Jarvis-ish
            switch v.quality {                                     // tie-break on naturalness
            case .premium: score += 100
            case .enhanced: score += 50
            default: break
            }
            return score
        }
        return english.max { rank($0) < rank($1) }
            ?? AVSpeechSynthesisVoice(language: "en-GB")
    }

    func speak(_ raw: String) {
        guard enabled else { return }
        let text = Self.spoken(from: raw)
        guard !text.isEmpty else { return }
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        let u = AVSpeechUtterance(string: text)
        u.rate = rate
        u.pitchMultiplier = 0.96        // a touch lower — calm, composed
        u.prefersAssistiveTechnologySettings = false
        u.voice = voice
        synth.speak(u)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }

    // AVSpeechSynthesizerDelegate — bridge to the main actor.
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) {
        Task { @MainActor in onSpeakingChange?(true) }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        Task { @MainActor in onSpeakingChange?(false) }
    }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        Task { @MainActor in onSpeakingChange?(false) }
    }

    /// Strip fenced code, collapse whitespace, cap length for a natural spoken line.
    static func spoken(from raw: String) -> String {
        var s = raw
        // Remove ```code blocks``` and `inline code`.
        s = s.replacingOccurrences(of: "(?s)```.*?```", with: " (code shown above) ", options: .regularExpression)
        s = s.replacingOccurrences(of: "`[^`]*`", with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: "[#*_>•]", with: "", options: .regularExpression)
        // Drop emoji & pictographs — otherwise the synth reads "robot face" etc.
        s = String(s.unicodeScalars.filter { !$0.properties.isEmoji || ($0.value >= 0x30 && $0.value <= 0x39) })
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if s.count > 500 {
            let end = s.index(s.startIndex, offsetBy: 500)
            s = String(s[..<end]) + "…"
        }
        return s
    }
}
