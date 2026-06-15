import AppKit

enum AudioMode: String, CaseIterable, Identifiable {
    case mix    // leave other audio untouched (never mutes)
    case dim    // lower Spotify/Music to dimLevel% while Jarvis speaks
    case mute   // drop them to 0 while Jarvis speaks
    var id: String { rawValue }
    var label: String { rawValue.uppercased() }
}

/// Dims background music while Jarvis speaks. macOS gives no per-app volume API to
/// third parties, so this drives the known players (Spotify, Apple Music) over
/// Apple Events — the only way to lower *only* background audio. Other sources
/// (browser, etc.) are left alone ("mix"). First use triggers the Automation prompt.
@MainActor
final class AudioDucker {
    var mode: AudioMode = .dim
    var dimLevel: Int = 30                 // 0–100, used in .dim
    private var saved: [String: Int] = [:] // player → volume before ducking
    private let players = ["Spotify", "Music"]

    func duck() {
        guard mode != .mix, saved.isEmpty else { return }
        let target = (mode == .mute) ? 0 : max(0, min(100, dimLevel))
        for app in players {
            guard let vol = volume(of: app) else { continue }  // not running → skip
            saved[app] = vol
            setVolume(app, target)
        }
    }

    func restore() {
        for (app, vol) in saved { setVolume(app, vol) }
        saved.removeAll()
    }

    // MARK: - AppleScript

    private func volume(of app: String) -> Int? {
        let src = "if application \"\(app)\" is running then tell application \"\(app)\" to get sound volume"
        guard let s = run(src)?.stringValue, let v = Int(s) else { return nil }
        return v
    }

    private func setVolume(_ app: String, _ v: Int) {
        _ = run("if application \"\(app)\" is running then tell application \"\(app)\" to set sound volume to \(v)")
    }

    @discardableResult
    private func run(_ source: String) -> NSAppleEventDescriptor? {
        var err: NSDictionary?
        let desc = NSAppleScript(source: source)?.executeAndReturnError(&err)
        if err != nil { return nil }   // not authorized / app absent → silently skip
        return desc
    }
}
