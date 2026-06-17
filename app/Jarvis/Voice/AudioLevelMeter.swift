import AVFoundation
import Accelerate

/// Live microphone loudness for the speaking waveform.
///
/// Not actor-isolated (like `VoiceGender`): `process` runs on the audio thread —
/// the same tap that feeds gender analysis. It computes a normalized RMS level per
/// buffer and hands it to `onLevel`; the consumer hops to the main actor to publish
/// it for SwiftUI. Keeping the heavy DSP off-main matches `SpeechService`'s rule.
final class AudioLevelMeter: @unchecked Sendable {
    /// 0…1 loudness for the latest buffer. Called on the audio thread.
    var onLevel: ((Float) -> Void)?

    func process(_ buffer: AVAudioPCMBuffer) {
        guard let ch = buffer.floatChannelData?[0] else { return }
        let n = vDSP_Length(buffer.frameLength)
        guard n > 0 else { return }

        var rms: Float = 0
        vDSP_rmsqv(ch, 1, &rms, n)   // same Accelerate call VoiceGender uses

        // Speech RMS sits far below 1.0, so map decibels into a usable bar height:
        // ~-50 dBFS floor → 0, 0 dBFS → 1, clamped. log10(0) guarded with a tiny floor.
        let db = 20 * log10(max(rms, 1e-7))
        let level = min(1, max(0, (db + 50) / 50))
        onLevel?(level)
    }
}
