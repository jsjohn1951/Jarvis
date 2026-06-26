import SwiftUI
import AppKit
import UniformTypeIdentifiers

/// The expanded HUD window — Design-1's "Agent Registry" + cluster overview, plus
/// model hot-swap. Opened from the popover; resizable.
struct RegistryView: View {
    @ObservedObject var client: OrchestratorClient

    private let columns = [GridItem(.adaptive(minimum: 220), spacing: 12)]

    /// Compact wall-clock stamp for log rows.
    private static let logTime: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f
    }()

    var body: some View {
        TabView {
            registryTab
                .tabItem { Label("Registry", systemImage: "square.grid.2x2") }
            logTab
                .tabItem { Label("Log", systemImage: "list.bullet.rectangle") }
        }
        .frame(minWidth: 560, minHeight: 480)
        .glassSurface()
        .allowsFullScreen()
        .onAppear { client.requestRegistry() }
    }

    // MARK: - Registry tab (cluster overview, live graph, agent cards, models)

    private var registryTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                title
                clusterOverview
                sectionLabel("LIVE_CLUSTER  ·  agents this turn")
                GlassPanel { AgentGraphView(nodes: client.agentGraph) }
                sectionLabel("AGENT_REGISTRY")
                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(client.agents) { agent in agentCard(agent) }
                }
                sectionLabel("LOCAL_MODELS  ·  :8080 slot")
                modelList
            }
            .padding(24)
        }
    }

    // MARK: - Log tab (rolling cross-turn agent activity)

    private var logTab: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                sectionLabel("AGENT_LOG  ·  \(client.agentLog.count) events")
                Spacer()
                logButton("EXPORT") { exportLog() }
                logButton("CLEAR") { client.clearLog() }
            }
            if client.agentLog.isEmpty {
                Text("No agent activity yet. Issue a command and it will be logged here.")
                    .font(Theme.body).foregroundStyle(Theme.outline)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 4) {
                            ForEach(client.agentLog) { entry in logRow(entry) }
                            // Anchor so we can keep the newest line in view.
                            Color.clear.frame(height: 1).id("log-end")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    // Auto-scroll to the newest entry as the log grows.
                    .onChange(of: client.agentLog.count) { _ in
                        withAnimation { proxy.scrollTo("log-end", anchor: .bottom) }
                    }
                    .onAppear { proxy.scrollTo("log-end", anchor: .bottom) }
                }
            }
        }
        .padding(24)
    }

    private func logRow(_ entry: AgentLogEntry) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(Self.logTime.string(from: entry.time))
                .font(Theme.mono).foregroundStyle(Theme.outline)
            Text(logTag(entry.kind))
                .font(Theme.label()).tracking(1)
                .foregroundStyle(logColor(entry.kind))
                .frame(width: 68, alignment: .leading)
            // Which spawn this line belongs to (blank for turn-level lines).
            Text(entry.agent)
                .font(Theme.mono).foregroundStyle(Theme.onSurfaceVariant)
                .frame(width: 76, alignment: .leading)
                .lineLimit(1)
            Text(entry.text)
                .font(entry.kind == .think ? Theme.body : Theme.mono)
                .foregroundStyle(entry.kind == .think ? Theme.onSurfaceVariant : Theme.onSurface)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 2)
    }

    private func logTag(_ kind: AgentLogEntry.Kind) -> String {
        switch kind {
        case .prompt: return "PROMPT"
        case .dispatch: return "DISPATCH"
        case .spawn: return "SPAWN"
        case .think: return "THINK"
        case .tool: return "TOOL"
        case .skill: return "SKILL"
        case .done: return "DONE"
        case .error: return "ERROR"
        case .info: return "INFO"
        }
    }

    private func logColor(_ kind: AgentLogEntry.Kind) -> Color {
        switch kind {
        case .prompt: return Theme.onSurface
        case .dispatch, .spawn: return Theme.primary
        case .think: return Theme.onSurfaceVariant
        case .tool: return Theme.primary.opacity(0.75)
        case .skill: return Theme.primary
        case .done: return Theme.primary
        case .error: return Theme.alert
        case .info: return Theme.onSurfaceVariant
        }
    }

    private func logButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.plain)
            .font(Theme.label()).tracking(1.2)
            .foregroundStyle(Theme.onSurfaceVariant)
            .padding(.horizontal, 10).padding(.vertical, 5)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius)
                .strokeBorder(Theme.outline.opacity(0.4), lineWidth: 1))
            .disabled(client.agentLog.isEmpty)
    }

    /// Render the log as plain text and save it via a standard save panel. The app runs
    /// unsandboxed, so a user-chosen destination writes without extra entitlements.
    private func exportLog() {
        let df = DateFormatter(); df.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let body = client.agentLog.map { e -> String in
            let who = e.agent.isEmpty ? "" : " [\(e.agent)]"
            return "\(df.string(from: e.time))  \(logTag(e.kind).padding(toLength: 8, withPad: " ", startingAt: 0))\(who)  \(e.text)"
        }.joined(separator: "\n")
        let text = "J.A.R.V.I.S agent log — exported \(df.string(from: Date()))\n"
            + "\(client.agentLog.count) events\n\n\(body)\n"

        let stamp = DateFormatter(); stamp.dateFormat = "yyyy-MM-dd-HHmmss"
        let panel = NSSavePanel()
        panel.title = "Export Agent Log"
        panel.nameFieldStringValue = "jarvis-agent-log-\(stamp.string(from: Date())).txt"
        panel.allowedContentTypes = [.plainText]
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let url = panel.url {
            try? text.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    private var title: some View {
        HStack {
            Text("J.A.R.V.I.S — CONTROL").font(Theme.display(20)).tracking(2)
                .foregroundStyle(Theme.onSurface)
            Spacer()
            HStack(spacing: 4) {
                Circle().fill(client.connected ? Theme.primary : Theme.alert).frame(width: 7, height: 7)
                Text(client.connected ? "ONLINE" : "OFFLINE").font(Theme.label()).tracking(1.5)
                    .foregroundStyle(Theme.onSurfaceVariant)
            }
        }
    }

    private func sectionLabel(_ s: String) -> some View {
        Text(s).font(Theme.label()).tracking(2).foregroundStyle(Theme.primary.opacity(0.8))
    }

    private var clusterOverview: some View {
        GlassPanel {
            HStack(spacing: 28) {
                stat("LLAMA 9B", client.health.llama)
                stat("ROUTER", client.health.router)
                stat("QUICK 2B", client.health.quick)
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text("ACTIVE AGENT").font(Theme.label()).tracking(1.5).foregroundStyle(Theme.onSurfaceVariant)
                    Text(client.activeAgent.isEmpty ? "—" : client.activeAgent)
                        .font(Theme.mono).foregroundStyle(Theme.primary)
                }
            }
        }
    }

    private func stat(_ label: String, _ ok: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(Theme.label()).tracking(1.2).foregroundStyle(Theme.onSurfaceVariant)
            HStack(spacing: 5) {
                Circle().fill(ok ? Theme.primary : Theme.alert).frame(width: 7, height: 7)
                    .shadow(color: (ok ? Theme.primary : Theme.alert).opacity(0.7), radius: 3)
                Text(ok ? "ONLINE" : "DOWN").font(Theme.mono)
                    .foregroundStyle(ok ? Theme.onSurface : Theme.alert)
            }
        }
    }

    private func agentCard(_ agent: AgentInfo) -> some View {
        let active = agent.name == client.activeAgent
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(agent.name.uppercased()).font(Theme.display(15)).tracking(1)
                    .foregroundStyle(active ? Theme.primary : Theme.onSurface)
                Spacer()
                Text(agent.tier).font(Theme.mono)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .overlay(RoundedRectangle(cornerRadius: Theme.radius)
                        .strokeBorder((agent.tier == "local" ? Theme.primary : Theme.outline).opacity(0.5), lineWidth: 1))
                    .foregroundStyle(agent.tier == "local" ? Theme.primary : Theme.onSurfaceVariant)
            }
            Text(agent.description).font(Theme.body).foregroundStyle(Theme.onSurfaceVariant)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            // Push the optional badge to the bottom so every card matches height.
            Spacer(minLength: 0)
            if active {
                Text("● ACTIVE").font(Theme.label()).tracking(1.5).foregroundStyle(Theme.primary)
            }
        }
        .padding(14)
        // Uniform card height regardless of description length (3-line cap above).
        .frame(maxWidth: .infinity, minHeight: 132, alignment: .topLeading)
        .background(Theme.surfaceContainer.opacity(0.5))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius)
            .strokeBorder(active ? Theme.primary.opacity(0.6) : Theme.outline.opacity(0.3), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
    }

    private var modelList: some View {
        VStack(spacing: 8) {
            if client.models.isEmpty {
                Text("No GGUFs found in ~/models").font(Theme.mono).foregroundStyle(Theme.outline)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(client.models, id: \.self) { model in
                HStack {
                    Circle().fill(model == client.currentModel ? Theme.primary : Theme.outline)
                        .frame(width: 6, height: 6)
                    Text(model).font(Theme.mono)
                        .foregroundStyle(model == client.currentModel ? Theme.onSurface : Theme.onSurfaceVariant)
                    Spacer()
                    if model == client.currentModel {
                        Text("LOADED").font(Theme.label()).tracking(1.2).foregroundStyle(Theme.primary)
                    } else {
                        Button("LOAD") { client.swapModel(model) }
                            .buttonStyle(.plain)
                            .font(Theme.label())
                            .foregroundStyle(Theme.onPrimary)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .background(Theme.primary)
                            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Theme.surface.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
            }
        }
    }
}
