import Foundation

/// Thin client for the Piper server's voice catalog (:8082) backing the HUD
/// dropdown. The server owns the catalog + download URLs; this only lists,
/// triggers downloads, and polls status. The chosen voice id is persisted under
/// UserDefaults "piperVoice" and read by KokoroTTSService when it synthesizes.
@MainActor
final class PiperVoiceModel: ObservableObject {
    struct Voice: Identifiable, Decodable {
        let id: String
        let name: String
        let gender: String
        let downloaded: Bool
    }

    static let defaultId = "en_GB-alan-medium"

    @Published var voices: [Voice] = []
    @Published var downloadingId: String?
    @Published var errorText: String?
    @Published var selectedId: String =
        UserDefaults.standard.string(forKey: "piperVoice") ?? PiperVoiceModel.defaultId

    private let base = URL(string: "http://127.0.0.1:8082")!

    private struct Catalog: Decodable { let voices: [Voice] }
    private struct Status: Decodable { let state: String; let error: String? }

    /// Load the catalog into `voices`. Silent no-op if the server is unreachable
    /// (the HUD just shows the persisted selection).
    func refresh() async {
        guard let cat: Catalog = try? await get("/voices") else { return }
        voices = cat.voices
    }

    /// Select a voice: if it isn't downloaded, kick off the server download and
    /// poll until ready before persisting. Reverts to the prior choice on failure.
    func select(_ id: String) async {
        errorText = nil
        guard let v = voices.first(where: { $0.id == id }) else { persist(id); return }
        if v.downloaded { persist(id); return }

        let previous = selectedId
        downloadingId = id
        defer { downloadingId = nil }
        do {
            try await post("/voices/\(id)/download")
            try await pollReady(id)
            await refresh()
            persist(id)
        } catch {
            errorText = "Couldn\u{2019}t download \(v.name)"
            selectedId = previous
        }
    }

    private func persist(_ id: String) {
        selectedId = id
        UserDefaults.standard.set(id, forKey: "piperVoice")
    }

    private func pollReady(_ id: String) async throws {
        for _ in 0..<180 {                       // ~180 s ceiling (~60 MB voice)
            let s: Status = try await get("/voices/\(id)/status")
            if s.state == "ready" { return }
            if s.state == "error" { throw URLError(.cannotLoadFromNetwork) }
            try await Task.sleep(for: .seconds(1))
        }
        throw URLError(.timedOut)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, resp) = try await URLSession.shared.data(from: base.appending(path: path))
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post(_ path: String) async throws {
        var req = URLRequest(url: base.appending(path: path))
        req.httpMethod = "POST"
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    }
}
