import Foundation

/// The on-device research skill: a FIXED pipeline, not a free-form tool loop —
/// a 4B model's tool-calling is too unreliable for open-ended ReAct, so Swift
/// owns the control flow and Gemma only generates (queries in, summaries out):
///
///   1. query gen   Gemma, GBNF-constrained to {"queries":[…]} — can't go rogue
///   2. search      DuckDuckGo HTML (or Brave with a key), top hits
///   3. fetch       up to 4 pages, 3-way concurrent, 15 s timeouts
///   4. map         per-page summary (Gemma, low temperature)
///   5. reduce      one spoken answer + numbered source list
///
/// Each stage reports progress so the HUD can narrate what's happening.
@MainActor
final class ResearchSkill {
    private let search = SearchClient()
    private let extractor = PageExtractor()

    /// Constrains stage 1 to a parseable JSON object with 1–3 short queries.
    static let queryGrammar = #"""
    root ::= "{" ws "\"queries\"" ws ":" ws "[" ws string (ws "," ws string)? (ws "," ws string)? ws "]" ws "}"
    string ::= "\"" [^"\\]{3,80} "\""
    ws ::= [ \t\n]?
    """#

    func run(_ request: String, gemma: GemmaChat, onStage: @escaping @MainActor (String) -> Void) async throws -> String {
        onStage("thinking about search queries…")
        let queryJSON = try await gemma.complete(
            system: "You turn a research request into 1-3 short web search queries. Output ONLY the JSON.",
            user: request,
            grammarGBNF: Self.queryGrammar,
            maxTokens: 96
        )
        struct Queries: Decodable { let queries: [String] }
        let queries = (try? JSONDecoder().decode(Queries.self, from: Data(queryJSON.utf8)))?.queries
            ?? [request]

        onStage("searching…")
        var seen = Set<String>()
        var hits: [SearchClient.Hit] = []
        for q in queries.prefix(2) {
            for hit in (try? await search.search(q, limit: 5)) ?? [] where seen.insert(hit.url.host ?? hit.url.absoluteString).inserted {
                hits.append(hit)
            }
        }
        guard !hits.isEmpty else { return "I couldn't find any web results for that, I'm afraid." }

        onStage("reading \(min(hits.count, 4)) pages…")
        let picked = Array(hits.prefix(4))
        var pages: [(hit: SearchClient.Hit, text: String)] = []
        await withTaskGroup(of: (Int, String?).self) { group in
            for (i, hit) in picked.enumerated() {
                group.addTask { [extractor] in (i, try? await extractor.extract(from: hit.url)) }
            }
            var byIndex = [Int: String]()
            for await (i, text) in group {
                if let text, text.count > 200 { byIndex[i] = text }
            }
            pages = byIndex.keys.sorted().map { (picked[$0], byIndex[$0]!) }
        }
        guard !pages.isEmpty else { return "I found results but couldn't read any of the pages — they may be blocking me." }

        var notes: [String] = []
        for (i, page) in pages.enumerated() {
            onStage("summarizing \(page.hit.url.host ?? "page") (\(i + 1)/\(pages.count))…")
            let note = try await gemma.complete(
                system: "Summarize the key facts from this page that answer: \"\(request)\". 3-5 dense sentences, facts only.",
                user: page.text,
                maxTokens: 200
            )
            notes.append("[\(i + 1)] \(page.hit.title)\n\(note.trimmingCharacters(in: .whitespacesAndNewlines))")
        }

        onStage("composing answer…")
        let answer = try await gemma.complete(
            system: "You are Jarvis. Using ONLY these research notes, answer the user's question in a few spoken-friendly "
                + "sentences. Cite sources as [1], [2] where used. If the notes don't answer it, say so.",
            user: "Question: \(request)\n\nNotes:\n\(notes.joined(separator: "\n\n"))",
            maxTokens: 320
        )
        let sources = pages.enumerated()
            .map { "[\($0.offset + 1)] \($0.element.hit.url.host ?? $0.element.hit.url.absoluteString)" }
            .joined(separator: "  ")
        return answer.trimmingCharacters(in: .whitespacesAndNewlines) + "\n\nSources: " + sources
    }
}
