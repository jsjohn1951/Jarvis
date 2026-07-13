import SwiftUI

/// iOS rendition of the Mac's Agent Registry window: cluster health, the live
/// agent graph for the current turn, the agent registry, and the rolling activity
/// log. Read-only — model hot-swap stays a desktop privilege (the server rejects
/// `swap` from mobile), so models are listed without LOAD buttons.
struct AgentPanelView: View {
    @EnvironmentObject private var client: OrchestratorClient

    private static let logTime: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "HH:mm:ss"; return f
    }()

    var body: some View {
        NavigationStack {
            List {
                clusterSection
                liveTurnSection
                registrySection
                modelsSection
                logSection
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Agents")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Clear Log") { client.clearLog() }
                        .disabled(client.agentLog.isEmpty)
                }
            }
            .onAppear { client.requestRegistry() }
            .refreshable { client.requestRegistry(); client.requestHealth() }
        }
    }

    // MARK: - Cluster

    private var clusterSection: some View {
        Section("Cluster") {
            HStack(spacing: 16) {
                stat("9B", client.health.llama)
                stat("ROUTER", client.health.router)
                stat("2B", client.health.quick)
                stat("CONVO", client.health.convo)
                Spacer()
                Text(client.activeAgent.isEmpty ? "—" : client.activeAgent)
                    .font(.caption.monospaced())
                    .foregroundStyle(.cyan)
            }
        }
    }

    private func stat(_ label: String, _ ok: Bool) -> some View {
        VStack(spacing: 3) {
            Circle().fill(ok ? Color.cyan : Color.red).frame(width: 7, height: 7)
            Text(label).font(.system(size: 9).monospaced()).foregroundStyle(.secondary)
        }
    }

    // MARK: - Live turn (agent graph as a compact list)

    private var liveTurnSection: some View {
        Section("This turn") {
            if client.agentGraph.isEmpty {
                Text("No agents active.").font(.caption).foregroundStyle(.tertiary)
            }
            ForEach(client.agentGraph) { node in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: nodeIcon(node.status))
                        .foregroundStyle(node.status == .done ? (node.ok ? .green : .red) : .orange)
                        .font(.caption)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(node.name).font(.callout.weight(.medium))
                            Text(node.role).font(.caption2).foregroundStyle(.secondary)
                            if node.tier == "local" {
                                Text("local").font(.caption2.monospaced())
                                    .padding(.horizontal, 5).padding(.vertical, 1)
                                    .background(Capsule().stroke(.cyan.opacity(0.5)))
                            }
                        }
                        if !node.tools.isEmpty {
                            Text(node.tools.joined(separator: " · "))
                                .font(.caption2.monospaced()).foregroundStyle(.tertiary)
                        }
                        if !node.thought.isEmpty {
                            Text(node.thought.suffix(140))
                                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
            }
        }
    }

    private func nodeIcon(_ status: AgentNode.Status) -> String {
        switch status {
        case .spawning: return "circle.dotted"
        case .thinking: return "brain"
        case .working: return "gearshape.2"
        case .done: return "checkmark.circle"
        }
    }

    // MARK: - Registry

    private var registrySection: some View {
        Section("Registry") {
            ForEach(client.agents) { agent in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(agent.name)
                            .font(.callout.weight(.medium))
                            .foregroundStyle(agent.name == client.activeAgent ? .cyan : .primary)
                        Spacer()
                        Text(agent.tier)
                            .font(.caption2.monospaced())
                            .foregroundStyle(agent.tier == "local" ? .cyan : .secondary)
                    }
                    Text(agent.description).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                }
            }
        }
    }

    private var modelsSection: some View {
        Section("Local models (:8080 slot on the Mac)") {
            if client.models.isEmpty {
                Text("No GGUFs reported.").font(.caption).foregroundStyle(.tertiary)
            }
            ForEach(client.models, id: \.self) { model in
                HStack {
                    Text(model).font(.caption.monospaced()).lineLimit(1)
                    Spacer()
                    if model == client.currentModel {
                        Text("LOADED").font(.caption2.monospaced()).foregroundStyle(.cyan)
                    }
                }
            }
        }
    }

    // MARK: - Log

    private var logSection: some View {
        Section("Activity log · \(client.agentLog.count)") {
            if client.agentLog.isEmpty {
                Text("No agent activity yet.").font(.caption).foregroundStyle(.tertiary)
            }
            // Newest first: on a phone you read the top of the section, not the bottom.
            ForEach(client.agentLog.reversed()) { entry in
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(Self.logTime.string(from: entry.time))
                            .font(.system(size: 9).monospaced()).foregroundStyle(.tertiary)
                        Text(entry.kind.rawValue.uppercased())
                            .font(.system(size: 9).monospaced().weight(.semibold))
                            .foregroundStyle(logColor(entry.kind))
                    }
                    .frame(width: 56, alignment: .leading)
                    VStack(alignment: .leading, spacing: 1) {
                        if !entry.agent.isEmpty {
                            Text(entry.agent).font(.caption2.monospaced()).foregroundStyle(.secondary)
                        }
                        Text(entry.text).font(.caption).lineLimit(4)
                    }
                }
            }
        }
    }

    private func logColor(_ kind: AgentLogEntry.Kind) -> Color {
        switch kind {
        case .prompt: return .primary
        case .dispatch, .spawn, .skill, .done: return .cyan
        case .think, .info: return .secondary
        case .tool: return .teal
        case .error: return .red
        }
    }
}
