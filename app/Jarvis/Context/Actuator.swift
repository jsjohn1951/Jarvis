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
    static func run(action: String, app: String?, url: String?, script: String?, command: String?, cwd: String?) async -> Result {
        switch action {
        case "open":
            return openTarget(app: app, url: url)
        case "applescript":
            guard let script, !script.isEmpty else { return Result(ok: false, error: "applescript: missing script") }
            return runAppleScript(script)
        case "terminal":
            guard let command, !command.isEmpty else { return Result(ok: false, error: "terminal: missing command") }
            return await runTerminal(command: command, cwd: cwd)
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

    // MARK: - Terminal

    /// Run `command` VISIBLY in Terminal.app and capture its output. The command is written
    /// to a temp .sh file (so the user's command never has to be escaped into AppleScript),
    /// then `do script "bash <file>"` runs it in a real, reused Terminal window with output
    /// redirected to a temp file plus an exit-code sentinel we poll for. Needs only the
    /// Automation→Terminal grant (first-use prompt); no Accessibility required.
    @MainActor
    private static func runTerminal(command: String, cwd: String?) async -> Result {
        let id = "\(Int(Date().timeIntervalSince1970 * 1000))-\(Int.random(in: 1000...9999))"
        let base = "/tmp/jarvis_term_\(id)"
        let scriptPath = "\(base).sh", outPath = "\(base).out", donePath = "\(base).done"
        let cd = (cwd?.isEmpty == false) ? "cd \(shellQuote(cwd!)) 2>/dev/null || true\n" : ""
        // The script the visible Terminal runs: redirect stdout+stderr to .out, then write
        // the exit code to .done (our completion sentinel).
        let body = "\(cd){ \(command)\n} > \(shellQuote(outPath)) 2>&1\nprintf '%s' \"$?\" > \(shellQuote(donePath))\n"
        do {
            try body.write(toFile: scriptPath, atomically: true, encoding: .utf8)
        } catch {
            return Result(ok: false, error: "couldn't stage terminal script: \(error.localizedDescription)")
        }

        // Run it in a real Terminal window (reuse the front one if Terminal is already open).
        let osa = """
        tell application "Terminal"
            activate
            if (count of windows) is 0 then
                do script "bash \(scriptPath)"
            else
                do script "bash \(scriptPath)" in front window
            end if
        end tell
        """
        let started = runAppleScript(osa)
        if !started.ok { return Result(ok: false, error: started.error ?? "couldn't drive Terminal.app") }

        // Poll the sentinel (the command runs visibly meanwhile). ~170s budget; a longer
        // command keeps running in the window and we report it as still in progress.
        let fm = FileManager.default
        var waited = 0
        while !fm.fileExists(atPath: donePath) && waited < 170_000 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            waited += 250
        }
        let output = (try? String(contentsOfFile: outPath, encoding: .utf8)) ?? ""
        let finished = fm.fileExists(atPath: donePath)
        let code = finished ? (try? String(contentsOfFile: donePath, encoding: .utf8)) : nil
        // Clean up temp files (leave the Terminal window for the user to see).
        for p in [scriptPath, outPath, donePath] { try? fm.removeItem(atPath: p) }

        if !finished {
            return Result(ok: true, output: output.isEmpty
                ? "Command is running in Terminal (still in progress)."
                : output + "\n\n(still running in Terminal…)")
        }
        let exit = Int(code?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
        return Result(ok: exit == 0,
                      output: output,
                      error: exit == 0 ? nil : "command exited \(exit)")
    }

    /// Single-quote a string for safe embedding in a bash command.
    private static func shellQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}
