import Foundation
import AVFoundation
import Speech

/// On-device speech-to-text via AVAudioEngine + SFSpeechRecognizer.
///
/// NOT @MainActor on purpose: SFSpeech's authorization/recognition handlers and
/// the audio tap fire on background queues. If this type were main-actor-isolated,
/// those closures would inherit that isolation and Swift's runtime isolation check
/// would trap (SIGTRAP) the moment they ran off-main. So the class is non-isolated
/// and we hop to the main actor explicitly when invoking callbacks / touching state.
final class SpeechService: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))

    private(set) var isRunning = false      // mutated only on the main thread
    private var lastText = ""

    var onPartial: (@MainActor (String) -> Void)?
    var onFinal: (@MainActor (String) -> Void)?

    func requestAuthorization() async -> Bool {
        let speech = await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
        let mic = await AVCaptureDevice.requestAccess(for: .audio)
        return speech && mic
    }

    /// Begin capture. Call on the main thread.
    func start() throws {
        guard !isRunning, let recognizer, recognizer.isAvailable else { return }
        lastText = ""

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true   // fully local — no audio leaves the Mac
        request = req

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            req.append(buffer)                    // background audio thread — append only
        }
        engine.prepare()
        try engine.start()
        isRunning = true

        // resultHandler is invoked on a background queue — hop to main before
        // touching state or callbacks.
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            let text = result?.bestTranscription.formattedString
            let done = (result?.isFinal ?? false) || error != nil
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if let text { self.lastText = text; self.onPartial?(text) }
                    if done { self.cleanup(emitFinal: true) }
                }
            }
        }
    }

    /// End the current utterance — recognition flushes and emits the final text.
    func stop() {
        guard isRunning else { return }
        request?.endAudio()
    }

    @MainActor private func cleanup(emitFinal: Bool) {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        task?.cancel()
        task = nil
        request = nil
        isRunning = false
        if emitFinal { onFinal?(lastText) }
    }
}
