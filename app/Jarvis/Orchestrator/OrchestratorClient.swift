import Foundation
import Combine

/// Visual state of the arc-reactor indicator.
enum HUDState: String { case idle, listening, thinking, speaking, alert }

struct Health { var llama = false; var router = false; var quick = false; var convo = false }

struct AgentInfo: Identifiable, Hashable {
    var name: String
    var description: String
    var tier: String
    var id: String { name }
}

/// One line in the rolling agent activity log (the Registry window's LOG tab).
/// Unlike `agentGraph`, which resets every turn, the log accumulates across turns so
/// you can review what the agents did over a whole session.
struct AgentLogEntry: Identifiable, Hashable {
    enum Kind: String { case prompt, dispatch, spawn, think, tool, skill, done, error, info }
    let id = UUID()
    let time: Date
    let kind: Kind
    /// The spawn this line belongs to (its node name), shown as a column so you can see
    /// which agent is thinking / using a tool. Empty for turn-level lines (prompt, info).
    let agent: String
    let text: String
}

/// A live node in the agent graph — one phase the orchestrator drove this turn
/// (interpret / ack / plan / implement / fallback). Drives the node-graph view.
struct AgentNode: Identifiable, Hashable {
    enum Status: String { case spawning, thinking, working, done }
    let id: String
    var name: String
    var parent: String?
    var tier: String        // "hybrid" (cloud) | "local"
    var role: String        // interpret | ack | plan | implement | answer | fallback
    var status: Status = .spawning
    var thought: String = ""
    var tools: [String] = []
    var ok = true
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
    @Published var agentGraph: [AgentNode] = []  // live agent graph for the current turn
    @Published var agentLog: [AgentLogEntry] = []  // rolling cross-turn activity log (LOG tab)
    @Published var models: [String] = []     // available GGUFs
    @Published var currentModel = ""         // GGUF loaded on :8080
    @Published var sessionActive = false     // a "Hey Jarvis" conversation session is open
    @Published var phoneConnected = false    // a mobile client is connected to the orchestrator
    @Published var phoneDevice = ""          // its self-reported device name (may be empty)

    /// Cap so a long session can't grow the log unbounded.
    private let logCap = 500
    /// Per-spawn thinking accumulated since its last logged line. Flushed as one THINK
    /// entry when the spawn acts (a tool call) or finishes — so streamed thought deltas
    /// read as coherent reasoning chunks, not a flood of fragments. Keyed by node id.
    private var pendingThought: [String: String] = [:]
    /// node id → display name, so tool/done/think lines can name the spawn.
    private var nodeName: [String: String] = [:]

    /// Append one line to the rolling agent log, trimming to the cap.
    private func log(_ kind: AgentLogEntry.Kind, agent: String = "", _ text: String) {
        agentLog.append(AgentLogEntry(time: Date(), kind: kind, agent: agent, text: text))
        if agentLog.count > logCap { agentLog.removeFirst(agentLog.count - logCap) }
    }

    /// Emit any buffered thinking for a node as a single THINK line, then clear it.
    private func flushThought(_ id: String) {
        let t = (pendingThought[id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        pendingThought[id] = ""
        if !t.isEmpty { log(.think, agent: nodeName[id] ?? "", t) }
    }

    /// Clear the activity log (LOG tab "CLEAR" button).
    func clearLog() { agentLog.removeAll() }

    /// Called when a turn completes — used by TTS.
    var onDone: ((String) -> Void)?
    /// Called when a wake capture was judged NOT addressed to Jarvis (no reply).
    var onIgnored: (() -> Void)?
    /// Instant local acknowledgment to speak immediately, before the cloud reply.
    var onAck: ((String) -> Void)?
    /// The 2B confirmed the speaker addressed Jarvis — reveal the floating HUD.
    var onAddressed: (() -> Void)?
    /// The in-flight turn was aborted (barge-in confirmed by the orchestrator).
    var onCancelled: (() -> Void)?

    private var task: URLSessionWebSocketTask?
    /// Computed per-connection so a Settings change applies on the next reconnect.
    private var url: URL { Endpoints.orchestratorURL }
    private var reconnectDelay: UInt64 = 1_000_000_000  // 1s, backs off

    func connect() {
        task = URLSession.shared.webSocketTask(with: url)
        task?.resume()
        // `connected` flips true on the first inbound frame (see handle) — setting
        // it here optimistically made the HUD strobe ONLINE/OFFLINE while the
        // server was unreachable (every retry claimed success for a moment).
        // Remote clients (the iOS app over LAN/tailnet) must authenticate before the
        // orchestrator will talk to them; loopback clients skip this (empty token).
        if !Endpoints.mobileToken.isEmpty {
            send(json: [
                "type": "hello", "role": "mobile",
                "token": Endpoints.mobileToken,
                "device": ProcessInfo.processInfo.hostName,
            ])
        }
        send(json: ["type": "health"])
        requestRegistry()
        receive()
    }

    func sendPrompt(
        _ text: String,
        agent: String? = nil,
        triage: Bool = false,
        honorific: String? = nil,
        imageBase64: String? = nil,
        nowPlaying: String? = nil
    ) {
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        lastUserText = text
        log(.prompt, text)
        pendingThought.removeAll()   // start each turn's thinking buffers fresh
        transcript = ""
        toolTrail = []
        agentGraph = []
        state = .thinking
        var msg: [String: Any] = ["type": "prompt", "text": text]
        if let agent { msg["agent"] = agent }
        if triage { msg["triage"] = true }
        if let honorific { msg["honorific"] = honorific }
        if let imageBase64 { msg["image"] = imageBase64 }
        if let nowPlaying { msg["nowPlaying"] = nowPlaying }
        send(json: msg)
    }

    func requestHealth() { send(json: ["type": "health"]) }
    func requestRegistry() { send(json: ["type": "agents"]); send(json: ["type": "models"]) }
    func swapModel(_ file: String) { send(json: ["type": "swap", "model": file]) }

    /// Barge-in: abort the in-flight turn so the user can interrupt Jarvis mid-reply.
    func sendCancel() { send(json: ["type": "cancel"]) }
    /// Explicit session controls (HUD buttons) — voice "Hey Jarvis" / "goodbye" do this too.
    func openSession() { send(json: ["type": "session_open"]) }
    func closeSession() { send(json: ["type": "session_close"]) }

    /// Push alternate-provider config (Ollama Cloud fallback) to the orchestrator.
    func sendProviderConfig(enabled: Bool, model: String, apiKey: String) {
        send(json: [
            "type": "provider_config", "provider": "ollama",
            "enabled": enabled, "model": model, "apiKey": apiKey,
        ])
    }

    /// Power off: ask the orchestrator to tear down the Jarvis-owned backend, then run
    /// `done` (used to quit the app). Fire-and-forget — if the socket is already down the
    /// send no-ops. We give the frame a moment to flush over the localhost socket, then
    /// run `done` so the app always quits whether or not the backend was reachable.
    func shutdownBackend(then done: @escaping () -> Void) {
        task?.send(.string(#"{"type":"shutdown"}"#)) { _ in }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)  // let the frame hit the wire
            done()
        }
    }

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
        phoneConnected = false   // a dead socket can't know the phone's state
        state = .idle
        let delay = reconnectDelay
        reconnectDelay = min(reconnectDelay * 2, 15_000_000_000)  // cap 15s
        Task { try? await Task.sleep(nanoseconds: delay); self.connect() }
    }

    private func handle(_ str: String) {
        guard let data = str.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return }
        // Any inbound frame proves the socket is really up (loopback clients get
        // the welcome burst immediately; mobile clients get hello_ok first).
        if !connected { connected = true; reconnectDelay = 1_000_000_000 }
        switch type {
        case "status":
            if let s = obj["state"] as? String { state = HUDState(rawValue: s) ?? .idle }
        case "agent":
            activeAgent = obj["name"] as? String ?? ""
            agentVia = obj["via"] as? String ?? ""
            log(.dispatch, agent: activeAgent, agentVia.isEmpty ? "dispatched" : "via \(agentVia)")
        case "reset":
            // The orchestrator switched to a fallback provider — discard the
            // partial answer so only the provider that completes is shown.
            transcript = ""
            toolTrail = []
        case "text":
            if let delta = obj["delta"] as? String { transcript += delta }
        case "tool":
            // Tool calls are logged per-spawn from `agent_tool` (which carries the node id);
            // here we only feed the compact tool trail shown in the popover transcript.
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
            log(.info, "wake ignored — not addressed to Jarvis")
            onIgnored?()
            pendingThought.removeAll()
        case "addressed":
            // The 2B confirmed Jarvis was addressed — reveal the floating HUD.
            onAddressed?()
        case "ack":
            // Instant local acknowledgment — speak it now, before the cloud reply.
            if let text = obj["text"] as? String, !text.isEmpty { onAck?(text) }
        case "session":
            // A conversation session opened ("Hey Jarvis") or closed ("goodbye").
            sessionActive = (obj["state"] as? String) == "open"
            log(.info, sessionActive ? "session opened" : "session closed")
        case "cancelled":
            // Barge-in confirmed — the in-flight turn was aborted.
            state = .idle
            log(.info, "turn cancelled (barge-in)")
            onCancelled?()
        case "agent_spawn":
            if let id = obj["id"] as? String {
                let name = obj["name"] as? String ?? "?"
                let role = obj["role"] as? String ?? ""
                agentGraph.append(AgentNode(
                    id: id,
                    name: name,
                    parent: obj["parent"] as? String,
                    tier: obj["tier"] as? String ?? "",
                    role: role,
                    status: .working
                ))
                nodeName[id] = name
                log(.spawn, agent: name, role.isEmpty ? "spawned" : "spawned · \(role)")
            }
        case "agent_thought":
            if let id = obj["id"] as? String, let i = agentGraph.firstIndex(where: { $0.id == id }) {
                let delta = obj["text"] as? String ?? ""
                agentGraph[i].thought += delta
                agentGraph[i].status = .thinking
                // Buffer the reasoning; it's flushed to the log as one THINK line when the
                // spawn next acts or finishes (see flushThought).
                pendingThought[id, default: ""] += delta
            }
        case "agent_tool":
            if let id = obj["id"] as? String, let i = agentGraph.firstIndex(where: { $0.id == id }) {
                let name = obj["name"] as? String ?? "?"
                let detail = obj["detail"] as? String
                agentGraph[i].tools.append(name)
                agentGraph[i].status = .working
                flushThought(id)   // log the thinking that led to this action first
                let who = agentGraph[i].name
                if name == "Skill" {
                    log(.skill, agent: who, detail ?? "skill")
                } else {
                    log(.tool, agent: who, detail.map { "\(name) · \($0)" } ?? name)
                }
            }
        case "agent_done":
            if let id = obj["id"] as? String, let i = agentGraph.firstIndex(where: { $0.id == id }) {
                let ok = obj["ok"] as? Bool ?? true
                agentGraph[i].status = .done
                agentGraph[i].ok = ok
                flushThought(id)   // emit any trailing reasoning / final answer
                // The plumbing nodes (interpret/ack) finish every turn — skip the DONE line
                // for them so the log reads as the substantive agents' completions.
                let node = agentGraph[i]
                if node.role != "interpret" && node.role != "ack" {
                    log(.done, agent: node.name, ok ? "completed" : "failed")
                }
            }
        case "error":
            state = .alert
            let message = obj["message"] as? String ?? "error"
            transcript = "⚠︎ " + message
            log(.error, message)
        case "health":
            health = Health(
                llama: obj["llama"] as? Bool ?? false,
                router: obj["router"] as? Bool ?? false,
                quick: obj["quick"] as? Bool ?? false,
                convo: obj["convo"] as? Bool ?? false
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
        case "hello_ok":
            // The orchestrator accepted our mobile token (remote clients only).
            log(.info, "mobile role authenticated")
        case "phone":
            let was = phoneConnected
            phoneConnected = obj["connected"] as? Bool ?? false
            phoneDevice = obj["device"] as? String ?? ""
            if phoneConnected != was {
                log(.info, phoneConnected
                    ? "phone connected" + (phoneDevice.isEmpty ? "" : " (\(phoneDevice))")
                    : "phone disconnected")
            }
        case "act":
            // The orchestrator's desktop/web agent is asking the app to perform a
            // system action (open app/URL, run AppleScript, capture screen). Execute
            // it here — the app holds the Automation / Screen Recording grants — and
            // reply with the matching id so the agent's tool call resolves. The server
            // never sends this to mobile sockets; iOS builds have no Actuator.
            #if os(macOS)
            handleAct(obj)
            #endif
        default: break
        }
    }

    #if os(macOS)
    private func handleAct(_ obj: [String: Any]) {
        guard let id = obj["id"] as? String else { return }
        let action = obj["action"] as? String ?? ""
        let app = obj["app"] as? String
        let url = obj["url"] as? String
        let script = obj["script"] as? String
        let command = obj["command"] as? String
        let cwd = obj["cwd"] as? String
        Task { @MainActor in
            let r = await Actuator.run(action: action, app: app, url: url, script: script, command: command, cwd: cwd)
            var msg: [String: Any] = ["type": "act_result", "id": id, "ok": r.ok]
            if let o = r.output { msg["output"] = o }
            if let img = r.image { msg["image"] = img }
            if let e = r.error { msg["error"] = e }
            self.send(json: msg)
        }
    }
    #endif
}
