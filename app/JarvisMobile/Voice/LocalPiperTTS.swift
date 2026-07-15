import Foundation

/// On-device Piper voice (en_US-joe-medium) via sherpa-onnx — no Mac required.
///
/// TTSSynthesizer backend for the shared KokoroTTSService sentence pipeline.
/// An actor so the blocking ONNX `generate` call never runs on the main actor
/// (same precedent as LlamaEngine). The engine loads lazily on the first
/// sentence; the voice + espeak-ng-data ship in the app bundle, put there by
/// scripts/build-sherpa-tts.sh + project.yml.
actor LocalPiperTTS: TTSSynthesizer {
    enum Error: Swift.Error {
        case voiceMissingFromBundle
        case engineInitFailed
        case emptyAudio
    }

    static let voiceID = "vits-piper-en_US-joe-medium"

    private var engine: SherpaOnnxOfflineTtsWrapper?

    func synth(_ text: String) async throws -> Data {
        let tts = try loadEngine()
        let audio = tts.generate(text: text, sid: 0, speed: 1.0)
        let samples = audio.samples
        guard !samples.isEmpty else { throw Error.emptyAudio }
        return Self.wavData(samples: samples, sampleRate: Int(audio.sampleRate))
    }

    private func loadEngine() throws -> SherpaOnnxOfflineTtsWrapper {
        if let engine { return engine }
        guard let dir = Bundle.main.resourceURL?.appending(path: Self.voiceID),
              case let model = dir.appending(path: "en_US-joe-medium.onnx").path,
              case let tokens = dir.appending(path: "tokens.txt").path,
              case let dataDir = dir.appending(path: "espeak-ng-data").path,
              FileManager.default.fileExists(atPath: model),
              FileManager.default.fileExists(atPath: tokens),
              FileManager.default.fileExists(atPath: dataDir)
        else { throw Error.voiceMissingFromBundle }

        let vits = sherpaOnnxOfflineTtsVitsModelConfig(model: model, tokens: tokens, dataDir: dataDir)
        let modelConfig = sherpaOnnxOfflineTtsModelConfig(vits: vits, numThreads: 2)
        var config = sherpaOnnxOfflineTtsConfig(model: modelConfig)
        let tts = SherpaOnnxOfflineTtsWrapper(config: &config)
        guard tts.tts != nil else { throw Error.engineInitFailed }
        engine = tts
        return tts
    }

    /// Float PCM [-1, 1] → 16-bit mono WAV, playable by AVAudioPlayer(data:).
    static func wavData(samples: [Float], sampleRate: Int) -> Data {
        let pcm = samples.map { Int16(max(-1, min(1, $0)) * Float(Int16.max)) }
        let dataSize = pcm.count * 2
        var wav = Data(capacity: 44 + dataSize)
        func put(_ s: String) { wav.append(contentsOf: s.utf8) }
        func put32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { wav.append(contentsOf: $0) } }
        func put16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { wav.append(contentsOf: $0) } }
        put("RIFF"); put32(36 + dataSize); put("WAVE")
        put("fmt "); put32(16); put16(1); put16(1)               // PCM, mono
        put32(sampleRate); put32(sampleRate * 2)                 // byte rate
        put16(2); put16(16)                                      // block align, bits
        put("data"); put32(dataSize)
        pcm.withUnsafeBytes { wav.append(contentsOf: $0) }
        return wav
    }
}
