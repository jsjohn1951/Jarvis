import Foundation

/// Fetch a page and reduce it to readable text for summarization. Heuristic, not
/// a real readability engine: drop script/style/nav blocks, strip tags, collapse
/// whitespace, cap the length — good enough as LLM input, tiny enough to audit.
struct PageExtractor {
    static let maxChars = 6000

    func extract(from url: URL) async throws -> String {
        var req = URLRequest(url: url)
        req.timeoutInterval = 15
        req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)", forHTTPHeaderField: "User-Agent")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        guard let html = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin1) else { throw URLError(.cannotDecodeContentData) }
        return Self.text(fromHTML: html)
    }

    static func text(fromHTML html: String) -> String {
        var s = html
        for block in ["script", "style", "noscript", "svg", "nav", "header", "footer", "form"] {
            s = s.replacingOccurrences(
                of: "<\(block)[^>]*>[\\s\\S]*?</\(block)>",
                with: " ",
                options: [.regularExpression, .caseInsensitive]
            )
        }
        // Keep paragraph boundaries so the summarizer sees structure.
        s = s.replacingOccurrences(of: "</p>|<br ?/?>|</div>|</h[1-6]>|</li>", with: "\n",
                                   options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
        // Collapse whitespace; keep only substantial lines (menus/breadcrumbs are short).
        let lines = s.components(separatedBy: .newlines)
            .map { $0.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                     .trimmingCharacters(in: .whitespaces) }
            .filter { $0.count > 40 }
        return String(lines.joined(separator: "\n").prefix(maxChars))
    }
}
