import Foundation

/// Decides where a prompt from the phone runs:
///
///   .mac          → send over the WebSocket; the Mac orchestrator does its full
///                   pipeline (Claude Agent SDK, agents, memory, coder…)
///   .local(_)     → run on-device (Gemma 3 4B): .chat for conversation,
///                   .research for the fixed search→fetch→summarize pipeline
///   .unavailable  → tell the user why nothing can run (spoken + shown)
///
/// Inputs the router can use:
///   - `connected`     the orchestrator WebSocket is up (Mac reachable)
///   - `modelReady`    the on-device GGUF is downloaded + loadable
///   - `preferLocal`   Settings toggle "Prefer local for chat" — keep plain
///                     conversation on-device even when the Mac is reachable
///                     (research is on-device regardless, by policy)
///   - the prompt text (for intent sniffing)
///
/// `looksLikeResearch` / `looksLikeAgentWork` are deliberately simple keyword
/// heuristics — there is no 2B triage tier on the phone, and misrouting is
/// cheap: .mac handles everything, and local chat answers anything Gemma can.
enum TurnRouter {
    enum LocalSkill { case chat, research }
    enum Route: Equatable {
        case mac
        case local(LocalSkill)
        case unavailable(String)

        static func == (a: Route, b: Route) -> Bool {
            switch (a, b) {
            case (.mac, .mac): return true
            case (.local(let x), .local(let y)): return x == y
            case (.unavailable, .unavailable): return true
            default: return false
            }
        }
    }

    /// "research the…", "look up…", "find out…", "search for…" — wants the web.
    static func looksLikeResearch(_ text: String) -> Bool {
        let t = text.lowercased()
        return ["research", "look up", "lookup", "find out", "search for", "what's the latest", "what is the latest"]
            .contains { t.contains($0) }
    }

    /// Work only the Mac can do: code, files, desktop control, long-term memory.
    static func looksLikeAgentWork(_ text: String) -> Bool {
        let t = text.lowercased()
        return ["code", "coder", "refactor", "fix the", "build", "deploy", "terminal", "screen",
                "open ", "file", "repo", "remember", "memory", "project"]
            .contains { t.contains($0) }
    }

    /// Policy (user-decided): research ALWAYS stays on-device when the model is
    /// ready — even with the Mac reachable — so casual lookups never load the
    /// Mac. Agent work always needs the Mac. Chat goes to the Mac by default,
    /// on-device when `preferLocal` is set or the Mac is away.
    static func route(text: String, connected: Bool, modelReady: Bool, preferLocal: Bool) -> Route {
        if looksLikeAgentWork(text) {
            return connected ? .mac
                : .unavailable("I need the Mac for that kind of work, and it isn't reachable right now.")
        }
        if looksLikeResearch(text) {
            if modelReady { return .local(.research) }   // research stays local
            return connected ? .mac
                : .unavailable("I can't research without the local model — download it in Settings first.")
        }
        if connected && !preferLocal { return .mac }
        if modelReady { return .local(.chat) }
        return connected ? .mac
            : .unavailable("I'm offline and the local model isn't downloaded yet — grab it in Settings first.")
    }
}
