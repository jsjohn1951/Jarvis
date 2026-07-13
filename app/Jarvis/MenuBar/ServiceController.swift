import Foundation

/// Starts/stops the Jarvis backend from the HUD by spawning the repo's own
/// scripts (one source of truth with the terminal workflow). macOS-only — lives
/// in MenuBar/, which the iOS target excludes.
///
/// Known limitation: a script spawned from the app inherits the app's (GUI)
/// environment, so mobile-exposure vars like JARVIS_WS_HOST don't apply — the
/// LAN-exposed orchestrator is still started from a terminal (ios-package.sh).
@MainActor
final class ServiceController: ObservableObject {
    @Published var orchestratorUp = false
    @Published var proxyUp = false
    /// Which action is running ("stack"/"orch"/"proxy"), nil when idle. The HUD
    /// disables the toggles and shows a spinner while set.
    @Published var busy: String? = nil

    var stackUp: Bool { orchestratorUp && proxyUp }

    /// Repo root — mirrors the orchestrator's config.root (JARVIS_ROOT ?? ~/Desktop/jarvis).
    static var repoRoot: URL {
        if let p = UserDefaults.standard.string(forKey: "jarvis.root"), !p.isEmpty {
            return URL(fileURLWithPath: (p as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Desktop/jarvis")
    }

    /// Re-derive running state. When the orchestrator socket is up its health frame
    /// covers the router; otherwise fall back to raw TCP probes so the toggles are
    /// truthful even with everything down.
    func refresh(connected: Bool, routerHealthy: Bool) async {
        orchestratorUp = connected ? true : await Self.probeTCP(7777)
        proxyUp = connected ? routerHealthy : await Self.probeTCP(9090)
    }

    func startStack() async { await run("start-jarvis.sh", tag: "stack") }
    func stopStack() async { await run("stop-jarvis.sh", ["--keep-app"], tag: "stack") }
    func startOrchestrator() async { await run("orchestrator-up.sh", tag: "orch") }
    func stopOrchestrator() async { await run("orchestrator-down.sh", tag: "orch") }
    func startProxy() async { await run("hybrid-up.sh", ["--router-only"], tag: "proxy") }
    func stopProxy() async { await run("hybrid-down.sh", ["--router-only"], tag: "proxy") }

    /// Run a repo script to completion (Actuator-style Process), then re-probe.
    @discardableResult
    private func run(_ script: String, _ args: [String] = [], tag: String) async -> Bool {
        busy = tag
        defer { busy = nil }
        let path = Self.repoRoot.appendingPathComponent("scripts/\(script)").path
        let ok: Bool = await withCheckedContinuation { cont in
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: "/bin/bash")
            proc.arguments = [path] + args
            proc.standardOutput = FileHandle.nullDevice
            proc.standardError = FileHandle.nullDevice
            // Handler is set before run() so a fast exit can't slip past it.
            proc.terminationHandler = { p in cont.resume(returning: p.terminationStatus == 0) }
            do { try proc.run() } catch { cont.resume(returning: false) }
        }
        orchestratorUp = await Self.probeTCP(7777)
        proxyUp = await Self.probeTCP(9090)
        return ok
    }

    /// True if something is listening on 127.0.0.1:port. A blocking connect is fine
    /// here: loopback either accepts or refuses immediately.
    private static func probeTCP(_ port: UInt16) async -> Bool {
        await Task.detached {
            let fd = socket(AF_INET, SOCK_STREAM, 0)
            guard fd >= 0 else { return false }
            defer { close(fd) }
            var addr = sockaddr_in()
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = port.bigEndian
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            let result = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            return result == 0
        }.value
    }
}
