import SwiftUI

/// The expanded HUD window — Design-1's "Agent Registry" + cluster overview, plus
/// model hot-swap. Opened from the popover; resizable.
struct RegistryView: View {
    @ObservedObject var client: OrchestratorClient

    private let columns = [GridItem(.adaptive(minimum: 220), spacing: 12)]

    var body: some View {
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
        .frame(minWidth: 560, minHeight: 480)
        .glassSurface()
        .allowsFullScreen()
        .onAppear { client.requestRegistry() }
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
