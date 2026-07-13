import Foundation

/// The JSON encoded in the pairing QR that scripts/ios-package.sh prints in the
/// terminal. Scanning it configures everything the phone needs in one step.
struct PairingPayload: Codable {
    var v: Int
    var host: String          // Tailscale MagicDNS name (or LAN IP)
    var wsPort: Int
    var ttsPort: Int
    var token: String         // ~/.jarvis/mobile-token
    var modelURL: String?     // where to download the on-device GGUF (M3)
    var modelSHA256: String?

    static func decode(_ string: String) -> PairingPayload? {
        guard let data = string.data(using: .utf8),
              let p = try? JSONDecoder().decode(PairingPayload.self, from: data),
              p.v == 1, !p.host.isEmpty, !p.token.isEmpty else { return nil }
        return p
    }

    /// Persist into the shared endpoint settings (used by OrchestratorClient and
    /// the TTS clients on their next connection).
    func apply() {
        Endpoints.host = host
        Endpoints.wsPort = wsPort
        Endpoints.ttsPort = ttsPort
        Endpoints.mobileToken = token
        if let modelURL { UserDefaults.standard.set(modelURL, forKey: "jarvis.modelURL") }
        if let modelSHA256 { UserDefaults.standard.set(modelSHA256, forKey: "jarvis.modelSHA256") }
    }
}
