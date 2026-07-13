import Foundation

/// Web search for the on-device research skill.
///
/// Default backend is DuckDuckGo's HTML endpoint — no API key, parsed with two
/// small regexes. If the user supplies a Brave Search API key in Settings
/// (UserDefaults "jarvis.braveKey"), that JSON API is used instead (more robust,
/// but opt-in). Both return the same minimal hit shape.
struct SearchClient {
    struct Hit {
        var title: String
        var url: URL
    }

    // A realistic UA keeps the HTML endpoint from serving the JS-only page.
    private static let userAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"

    func search(_ query: String, limit: Int = 5) async throws -> [Hit] {
        if let key = UserDefaults.standard.string(forKey: "jarvis.braveKey"), !key.isEmpty {
            return try await brave(query, key: key, limit: limit)
        }
        return try await duckDuckGo(query, limit: limit)
    }

    // MARK: - DuckDuckGo HTML

    private func duckDuckGo(_ query: String, limit: Int) async throws -> [Hit] {
        var comps = URLComponents(string: "https://html.duckduckgo.com/html/")!
        comps.queryItems = [URLQueryItem(name: "q", value: query)]
        var req = URLRequest(url: comps.url!)
        req.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        req.timeoutInterval = 15
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200,
              let html = String(data: data, encoding: .utf8) else {
            throw URLError(.badServerResponse)
        }
        // Result links look like: <a class="result__a" href="…uddg=<pct-encoded-url>&…">Title</a>
        let pattern = #"<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#
        let regex = try NSRegularExpression(pattern: pattern, options: [.dotMatchesLineSeparators])
        var hits: [Hit] = []
        for m in regex.matches(in: html, range: NSRange(html.startIndex..., in: html)) {
            guard hits.count < limit,
                  let hrefR = Range(m.range(at: 1), in: html),
                  let titleR = Range(m.range(at: 2), in: html) else { continue }
            let href = String(html[hrefR])
            let title = Self.stripTags(String(html[titleR]))
            guard let url = Self.resolveDuckLink(href), !title.isEmpty else { continue }
            hits.append(Hit(title: title, url: url))
        }
        return hits
    }

    /// DDG hrefs are redirect wrappers: //duckduckgo.com/l/?uddg=<encoded>&…
    static func resolveDuckLink(_ href: String) -> URL? {
        if let r = href.range(of: "uddg=") {
            let tail = href[r.upperBound...]
            let encoded = tail.split(separator: "&").first.map(String.init) ?? String(tail)
            if let decoded = encoded.removingPercentEncoding, let url = URL(string: decoded),
               url.scheme?.hasPrefix("http") == true { return url }
        }
        if let url = URL(string: href), url.scheme?.hasPrefix("http") == true { return url }
        return nil
    }

    static func stripTags(_ s: String) -> String {
        s.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&#x27;", with: "'")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Brave (optional key)

    private func brave(_ query: String, key: String, limit: Int) async throws -> [Hit] {
        var comps = URLComponents(string: "https://api.search.brave.com/res/v1/web/search")!
        comps.queryItems = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "count", value: String(limit))]
        var req = URLRequest(url: comps.url!)
        req.setValue(key, forHTTPHeaderField: "X-Subscription-Token")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 15
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        struct BraveResponse: Decodable {
            struct Web: Decodable { let results: [Result] }
            struct Result: Decodable { let title: String; let url: String }
            let web: Web?
        }
        let decoded = try JSONDecoder().decode(BraveResponse.self, from: data)
        return (decoded.web?.results ?? []).prefix(limit).compactMap { r in
            URL(string: r.url).map { Hit(title: r.title, url: $0) }
        }
    }
}
