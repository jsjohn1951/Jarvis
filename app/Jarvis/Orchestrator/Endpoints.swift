import Foundation

/// Where the orchestrator (:7777 ws) and TTS server (:8082 http) live, plus the
/// pairing token for the remote "mobile" role.
///
/// On macOS everything defaults to loopback and an empty token — identical to the
/// hardcoded URLs this replaces. The iOS client points `host` at the Mac (LAN or
/// Tailscale MagicDNS name) and stores the token from the pairing QR; a non-empty
/// token makes `OrchestratorClient` authenticate with `hello role:"mobile"` and
/// adds `X-Jarvis-Token` to TTS requests. Values persist in UserDefaults and are
/// read per-connection, so a Settings change applies on the next reconnect.
enum Endpoints {
    static var host: String {
        get { UserDefaults.standard.string(forKey: "jarvis.host") ?? "127.0.0.1" }
        set { UserDefaults.standard.set(newValue, forKey: "jarvis.host") }
    }
    static var wsPort: Int {
        get { (UserDefaults.standard.object(forKey: "jarvis.wsPort") as? Int) ?? 7777 }
        set { UserDefaults.standard.set(newValue, forKey: "jarvis.wsPort") }
    }
    static var ttsPort: Int {
        get { (UserDefaults.standard.object(forKey: "jarvis.ttsPort") as? Int) ?? 8082 }
        set { UserDefaults.standard.set(newValue, forKey: "jarvis.ttsPort") }
    }
    /// Shared secret for the remote "mobile" role. Empty → trusted loopback client,
    /// no hello sent (the Mac app).
    static var mobileToken: String {
        get { UserDefaults.standard.string(forKey: "jarvis.mobileToken") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "jarvis.mobileToken") }
    }

    static var orchestratorURL: URL { URL(string: "ws://\(host):\(wsPort)")! }
    static var ttsBaseURL: URL { URL(string: "http://\(host):\(ttsPort)")! }
}
