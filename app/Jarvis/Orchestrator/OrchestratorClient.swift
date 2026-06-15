import Foundation
import Combine

/// Visual state of the arc-reactor indicator.
enum HUDState: String { case idle, listening, thinking, speaking, alert }

struct Health { var llama = false; var router = false; var quick = false }

struct AgentInfo: Identifiable, Hashable {
    var name: String
    var description: String
    var tier: String
    var id: String { name }
}

/// Single WebSocket connection to the orchestrator (ws://127.0.0.1:7777).
/// Publishes everything the HUD renders; auto-reconnects.
@MainActor
final class OrchestratorClient: ObservableObject {
    @Published var state: HUDState = .idle
    @Published var connected = false
    @Published var transcript = ""           // streamed assistant text for the current turn
    @Published var lastUserText = ""
    @Published var activeAgent = ""
    @Published var agentVia = ""
    @Published var health = Health()
    @Published var toolTrail: [String] = []  // tools the hybrid agent invoked
    @Published var agents: [AgentInfo] = []  // registry (for the expanded window)
    @Published var models: [String] = []     // available GGUFs
    @Published var currentModel = ""         // GGUF loaded on :8080

    /// Called when a turn completes — used by TTS.
    var onDone: ((String) -> Void)?
    /// Called when a wake capture was judged NOT addressed to Jarvis (no reply).
    var onIgnored: (() -> Void)?

    private var task: URLSessionWebSocketTask?
    private let url = URL(string: "ws://127.0.0.1:7777")!
    private var reconnectDelay: UInt64 = 1_000_000_000  // 1s, backs off

    func connect() {
        task = URLSession.shared.webSocketTask(with: url)
        task?.resume()
        connected = true
        reconnectDelay = 1_000_000_000
        send(json: ["type": "health"])
        requestRegistry()
        receive()
    }

    func sendPrompt(_ text: String, agent: String? = nil, triage: Bool = false) {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        lastUserText = text
        transcript = ""
        toolTrail = []
        state = .thinking
        var msg: [String: Any] = ["type": "prompt", "text": text]
        if let agent { msg["agent"] = agent }
        if triage { msg["triage"] = true }
        send(json: msg)
    }

    func requestHealth() { send(json: ["type": "health"]) }
    func requestRegistry() { send(json: ["type": "agents"]); send(json: ["type": "models"]) }
    func swapModel(_ file: String) { send(json: ["type": "swap", "model": file]) }

    // MARK: - Plumbing

    private func send(json: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: json),
              let str = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(str)) { _ in }
    }

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            Task { @MainActor in
                switch result {
                case .success(let message):
                    if case .string(let str) = message { self.handle(str) }
                    self.receive()
                case .failure:
                    self.reconnect()
                }
            }
        }
    }

    private func reconnect() {
        connected = false
        state = .idle
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 15_000_000_000)  // cap 15s
        Task { try? await Task.sleep(nanoseconds: delay); self.connect() }
    }

    private func handle(_ str: String) {
        guard let data = str.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        switch type {
        case "status":
            if let s = obj["state"] as? String { state = HUDState(rawValue: s) ?? .idle }
        case "agent":
            activeAgent = obj["name"] as? String ?? ""
            agentVia = obj["via"] as? String ?? ""
        case "text":
            if let delta = obj["delta"] as? String { transcript += delta }
        case "tool":
            if let name = obj["name"] as? String { toolTrail.append(name) }
        case "done":
            let result = (obj["result"] as? String) ?? transcript
            if !result.isEmpty { transcript = result }
            state = .speaking
            onDone?(result)
        case "ignored":
            // Wake heard but not addressed to Jarvis — stay quiet, keep listening.
            state = .idle
            lastUserText = ""
            onIgnored?()
        case "error":
            state = .alert
            transcript = "⚠︎ " + (obj["message"] as? String ?? "error")
        case "health":
            health = Health(
                llama: obj["llama"] as? Bool ?? false,
                router: obj["router"] as? Bool ?? false,
                quick: obj["quick"] as? Bool ?? false
            )
        case "agents":
            if let list = obj["list"] as? [[String: Any]] {
                agents = list.map {
                    AgentInfo(
                        name: $0["name"] as? String ?? "?",
                        description: $0["description"] as? String ?? "",
                        tier: $0["tier"] as? String ?? ""
                    )
                }
            }
        case "models":
            models = obj["list"] as? [String] ?? []
            currentModel = obj["current"] as? String ?? ""
        default: break
        }
    }
}
