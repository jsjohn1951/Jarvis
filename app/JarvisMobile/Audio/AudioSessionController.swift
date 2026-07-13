import AVFoundation

/// Single owner of the iOS audio session so mic capture (SpeechService) and TTS
/// playback (KokoroTTSService / AVSpeechSynthesizer) never fight over categories.
/// `.playAndRecord` + `.voiceChat` covers both directions with echo cancellation,
/// so the session is configured once and only interruptions (calls, Siri) touch it.
@MainActor
final class AudioSessionController {
    static let shared = AudioSessionController()
    /// Called on the main actor when the session is interrupted (incoming call) —
    /// the voice controller stops capture/playback rather than resuming into a
    /// half-dead session.
    var onInterruption: (@MainActor () -> Void)?

    private init() {}

    func configure() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try? session.setActive(true, options: .notifyOthersOnDeactivation)
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] note in
            guard let info = note.userInfo,
                  let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            Task { @MainActor in self?.onInterruption?() }
        }
    }
}
