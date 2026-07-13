import Foundation

/// The on-device conversation tier: the same Gemma 3 4B GGUF, persona files and
/// temperature (0.6) as the Mac's :8083 convo tier, so Jarvis sounds like Jarvis
/// whether or not the Mac is reachable.
///
/// Session-only memory: the phone keeps a short rolling history per app session
/// (mirroring the orchestrator's short-term buffer) but has no long-term memory —
/// that lives on the Mac. Documented degradation, not a bug.
@MainActor
final class GemmaChat: ObservableObject {
    @Published private(set) var loading = false
    @Published private(set) var loaded = false

    private var engine: LlamaEngine?
    private var history: [(role: String, content: String)] = []
    private let maxHistoryTurns = 12   // matches config.shortTermTurns on the Mac

    /// Persona = the bundled personality/*.md, concatenated in filename order +
    /// the same honesty suffix — mirrors orchestrator/src/personality.ts.
    static let persona: String = {
        let honesty = "Accuracy over confidence: never invent file paths, APIs, command names, numbers, or facts. "
            + "If you are not sure, say so plainly — do not guess or make something up."
        guard let urls = Bundle.main.urls(forResourcesWithExtension: "md", subdirectory: nil) else {
            return "You are Jarvis, the user's calm, capable AI assistant. Be concise; replies are read aloud.\n\n" + honesty
        }
        let parts = urls
            .filter { ["jarvis", "voice"].contains($0.deletingPathExtension().lastPathComponent) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .compactMap { try? String(contentsOf: $0, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) }
        let base = parts.isEmpty
            ? "You are Jarvis, the user's calm, capable AI assistant. Be concise; replies are read aloud."
            : parts.joined(separator: "\n\n")
        return base + "\n\n" + honesty
    }()

    /// Load weights (a few seconds for the 4B on an iPhone 17 Pro). Safe to call
    /// repeatedly; no-ops once loaded.
    func load() async throws {
        guard !loaded, !loading else { return }
        loading = true
        defer { loading = false }
        let path = ModelManager.installedModelURL()
        guard let path else { throw ModelManager.ModelError.notDownloaded }
        let engine = try LlamaEngine(modelPath: path)
        self.engine = engine
        loaded = true
    }

    func unload() {
        engine = nil
        loaded = false
    }

    /// One conversational turn against the local model, streaming deltas.
    func reply(to userText: String, onDelta: @escaping @Sendable (String) -> Void) async throws -> String {
        try await load()
        guard let engine else { throw ModelManager.ModelError.notDownloaded }

        var messages: [LlamaEngine.ChatMessage] = [.init(role: "system", content: Self.persona)]
        for turn in history.suffix(maxHistoryTurns) {
            messages.append(.init(role: turn.role, content: turn.content))
        }
        messages.append(.init(role: "user", content: userText))

        let answer = try await engine.generate(messages: messages, temperature: 0.6, maxTokens: 512, onToken: onDelta)
        history.append((role: "user", content: userText))
        history.append((role: "assistant", content: answer))
        if history.count > maxHistoryTurns * 2 { history.removeFirst(history.count - maxHistoryTurns * 2) }
        return answer.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// One-shot completion with no persona/history (research pipeline stages).
    func complete(system: String, user: String, grammarGBNF: String? = nil, maxTokens: Int32 = 512) async throws -> String {
        try await load()
        guard let engine else { throw ModelManager.ModelError.notDownloaded }
        return try await engine.generate(
            messages: [.init(role: "system", content: system), .init(role: "user", content: user)],
            temperature: 0.3,   // pipeline stages want faithfulness, not flair
            grammarGBNF: grammarGBNF,
            maxTokens: maxTokens
        )
    }

    func clearHistory() { history.removeAll() }
}
