import AVFoundation
import Accelerate

/// Heuristic speaker form-of-address from voice pitch (fundamental frequency).
/// Male voices cluster low (~85–155 Hz), female higher (~185–255 Hz); the band
/// between is left as `.none` (we keep the previous result rather than guess).
/// On-device, free. Imperfect by nature — the HUD offers a manual override.
///
/// Not actor-isolated: `process` runs on the audio thread; `finalize`/`current`
/// are read on the main thread after the tap is removed, so they don't overlap.
final class VoiceGender: @unchecked Sendable {
    enum Honorific: String { case sir, maam, none }
    private(set) var current: Honorific = .none
    private var f0s: [Float] = []

    func reset() { f0s = [] }

    /// Feed each mic buffer during an utterance.
    func process(_ buffer: AVAudioPCMBuffer) {
        if let f0 = estimateF0(buffer), f0 > 70, f0 < 400 { f0s.append(f0) }
    }

    /// Call when the utterance ends; updates `current` only when confident.
    func finalize() {
        defer { f0s = [] }
        guard f0s.count >= 5 else { return }
        let median = f0s.sorted()[f0s.count / 2]
        if median <= 155 { current = .sir }
        else if median >= 185 { current = .maam }
        // 155–185 Hz: ambiguous → keep previous (sticky)
    }

    // Autocorrelation pitch estimate for one buffer.
    private func estimateF0(_ buffer: AVAudioPCMBuffer) -> Float? {
        guard let ch = buffer.floatChannelData?[0] else { return nil }
        let n = Int(buffer.frameLength)
        guard n >= 1024 else { return nil }
        let sr = Float(buffer.format.sampleRate)

        var rms: Float = 0
        vDSP_rmsqv(ch, 1, &rms, vDSP_Length(n))
        guard rms > 0.01 else { return nil }   // skip near-silence

        let minLag = Int(sr / 400), maxLag = Int(sr / 70)
        guard maxLag < n, minLag > 0 else { return nil }
        var bestLag = -1
        var bestVal: Float = 0
        for lag in minLag...maxLag {
            var sum: Float = 0
            vDSP_dotpr(ch, 1, ch + lag, 1, &sum, vDSP_Length(n - lag))
            if sum > bestVal { bestVal = sum; bestLag = lag }
        }
        return bestLag > 0 ? sr / Float(bestLag) : nil
    }
}
