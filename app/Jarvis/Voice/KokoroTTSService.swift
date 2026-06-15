import AVFoundation

/// Natural Jarvis voice via the local Kokoro server (:8082).
///
/// Streams by sentence: it synthesizes + plays the first sentence while the rest
/// are still being generated, so speech starts fast on long replies. If the server
/// is unreachable on the first sentence, calls `onUnavailable` so the caller can
/// fall back to AVSpeechSynthesizer.
@MainActor
final class KokoroTTSService: NSObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var queue: [String] = []
    private var rawForFallback = ""
    private var speaking = false
    private let url = URL(string: "http://127.0.0.1:8082/v1/audio/speech")!

    var onSpeakingChange: ((Bool) -> Void)?   // pauses the mic during playback
    var onUnavailable: ((String) -> Void)?    // → caller speaks via AVSpeechSynthesizer

    func speak(_ raw: String) {
        let text = TTSService.spoken(from: raw)
        guard !text.isEmpty else { return }
        rawForFallback = raw
        queue = Self.sentences(from: text)
        guard !queue.isEmpty else { return }
        Task { await playNext(isFirst: true) }
    }

    func stop() {
        queue = []
        player?.stop()
        player = nil
        if speaking { speaking = false; onSpeakingChange?(false) }
    }

    private func playNext(isFirst: Bool) async {
        guard !queue.isEmpty else {
            if speaking { speaking = false; onSpeakingChange?(false) }
            return
        }
        let sentence = queue.removeFirst()
        do {
            let data = try await synth(sentence)
            let p = try AVAudioPlayer(data: data)
            p.delegate = self
            player = p
            if !speaking { speaking = true; onSpeakingChange?(true) }
            p.play()
        } catch {
            if isFirst {
                onUnavailable?(rawForFallback)   // server down → AVSpeech fallback
            } else if speaking {
                speaking = false; onSpeakingChange?(false)
            }
            queue = []
        }
    }

    private func synth(_ text: String) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 30
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["input": text])
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200, !data.isEmpty else {
            throw URLError(.badServerResponse)
        }
        return data
    }

    nonisolated func audioPlayerDidFinishPlaying(_ p: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in await playNext(isFirst: false) }
    }

    /// Split into sentences, merging very short fragments so we don't fire a
    /// request per word.
    static func sentences(from text: String) -> [String] {
        let parts = text.split(whereSeparator: { ".!?".contains($0) }).map { $0.trimmingCharacters(in: .whitespaces) }
        var out: [String] = []
        for part in parts where !part.isEmpty {
            if let last = out.last, last.count < 40 {
                out[out.count - 1] = last + ". " + part
            } else {
                out.append(part)
            }
        }
        return out.isEmpty ? [text] : out
    }
}
