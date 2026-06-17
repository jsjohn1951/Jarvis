import AppKit

/// Executes desktop actions on behalf of the orchestrator's `desktop`/`web` agents:
/// opening apps & URLs, running AppleScript (System Events keystrokes / menu clicks
/// for UI control), and re-capturing the screen so the agent can re-observe.
///
/// AppleScript runs via `NSAppleScript` — the same Apple-Events path `AudioDucker`
/// already uses, so it inherits the app's Automation permission (the app is
/// deliberately un-sandboxed). System Events keystrokes into *other* apps additionally
/// need Accessibility, granted once in System Settings ▸ Privacy & Security ▸ Accessibility.
enum Actuator {
    struct Result {
        var ok: Bool
        var output: String?
        var image: String?
        var error: String?
    }

    @MainActor
    static func run(action: String, app: String?, url: String?, script: String?) async -> Result {
        switch action {
        case "open":
            return openTarget(app: app, url: url)
        case "applescript":
            guard let script, !script.isEmpty else { return Result(ok: false, error: "applescript: missing script") }
            return runAppleScript(script)
        case "capture":
            let img = await ScreenContext.captureMainDisplayPNGBase64()
            return Result(ok: img != nil, image: img, error: img == nil ? "capture failed" : nil)
        default:
            return Result(ok: false, error: "unknown action: \(action)")
        }
    }

    // MARK: - open

    /// Launch an app and/or open a URL via `/usr/bin/open` (handles both uniformly:
    /// `open -a "Google Chrome" "https://…"`).
    private static func openTarget(app: String?, url: String?) -> Result {
        var args: [String] = []
        if let app, !app.isEmpty { args += ["-a", app] }
        if let url, !url.isEmpty { args.append(url) }
        guard !args.isEmpty else { return Result(ok: false, error: "open: nothing to open") }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        proc.arguments = args
        do {
            try proc.run()
            proc.waitUntilExit()
            let ok = proc.terminationStatus == 0
            return Result(ok: ok,
                          output: ok ? "opened \(args.joined(separator: " "))" : nil,
                          error: ok ? nil : "open exited \(proc.terminationStatus)")
        } catch {
            return Result(ok: false, error: error.localizedDescription)
        }
    }

    // MARK: - AppleScript

    private static func runAppleScript(_ source: String) -> Result {
        var err: NSDictionary?
        let desc = NSAppleScript(source: source)?.executeAndReturnError(&err)
        if let err {
            let msg = (err[NSAppleScript.errorMessage] as? String) ?? "AppleScript error"
            return Result(ok: false, error: msg)
        }
        return Result(ok: true, output: desc?.stringValue)
    }
}
