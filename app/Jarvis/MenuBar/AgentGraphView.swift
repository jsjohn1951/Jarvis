import SwiftUI

/// Live node-graph of the agents working this turn: the local interpreter fronts
/// every turn, spawns an ack and the cloud worker, and cloud→local fallback appears
/// as a child node — so you can watch the cloud-plans/local-implements structure as
/// it happens. Nodes glow by status; edges show who spawned whom.
struct AgentGraphView: View {
    let nodes: [AgentNode]

    var body: some View {
        if nodes.isEmpty {
            Text("Idle — no agents running.")
                .font(Theme.mono).foregroundStyle(Theme.outline)
                .frame(maxWidth: .infinity, minHeight: 80)
        } else {
            GeometryReader { geo in
                let layout = layout(in: geo.size)
                ZStack {
                    edges(layout)
                    ForEach(nodes) { node in
                        if let pt = layout[node.id] {
                            nodeView(node).position(pt)
                        }
                    }
                }
            }
            .frame(height: graphHeight)
        }
    }

    // MARK: - layout

    /// Depth = distance from a root (no parent). Layered top→bottom by depth, nodes
    /// in a layer spread evenly across the width.
    private func depth(of node: AgentNode, byId: [String: AgentNode]) -> Int {
        var d = 0
        var cur = node
        var guardCount = 0
        while let pid = cur.parent, let parent = byId[pid], guardCount < 16 {
            d += 1; cur = parent; guardCount += 1
        }
        return d
    }

    private var byId: [String: AgentNode] { Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) }) }
    private var maxDepth: Int { nodes.map { depth(of: $0, byId: byId) }.max() ?? 0 }
    private var graphHeight: CGFloat { CGFloat(maxDepth + 1) * 96 + 24 }

    private func layout(in size: CGSize) -> [String: CGPoint] {
        let ids = byId
        var layers: [Int: [AgentNode]] = [:]
        for n in nodes { layers[depth(of: n, byId: ids), default: []].append(n) }
        var pts: [String: CGPoint] = [:]
        let rows = (layers.keys.max() ?? 0) + 1
        for (d, layer) in layers {
            let y = size.height * (CGFloat(d) + 0.5) / CGFloat(rows)
            for (i, node) in layer.enumerated() {
                let x = size.width * (CGFloat(i) + 0.5) / CGFloat(layer.count)
                pts[node.id] = CGPoint(x: x, y: y)
            }
        }
        return pts
    }

    private func edges(_ layout: [String: CGPoint]) -> some View {
        ForEach(nodes) { node in
            if let pid = node.parent, let a = layout[pid], let b = layout[node.id] {
                Path { p in p.move(to: a); p.addLine(to: b) }
                    .stroke(Theme.primary.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            }
        }
    }

    // MARK: - node

    private func tint(_ node: AgentNode) -> Color {
        node.status == .done ? (node.ok ? Theme.outline : Theme.alert)
            : node.tier == "local" ? Theme.primary : Theme.onSurface
    }

    private func nodeView(_ node: AgentNode) -> some View {
        let color = tint(node)
        let active = node.status == .thinking || node.status == .working
        return VStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(color.opacity(node.status == .done ? 0.15 : 0.22))
                    .frame(width: 54, height: 54)
                    .overlay(Circle().strokeBorder(color.opacity(0.8), lineWidth: 1.5))
                    .shadow(color: active ? color.opacity(0.7) : .clear, radius: active ? 10 : 0)
                Image(systemName: icon(node.role))
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(color)
            }
            .modifier(Pulse(active: active))
            Text(node.name.uppercased()).font(Theme.label()).tracking(1)
                .foregroundStyle(color == Theme.outline ? Theme.onSurfaceVariant : color)
            Text(node.role).font(Theme.mono).foregroundStyle(Theme.onSurfaceVariant.opacity(0.8))
            if active, !node.thought.isEmpty {
                Text(node.thought).font(Theme.mono).foregroundStyle(Theme.onSurfaceVariant)
                    .lineLimit(2).multilineTextAlignment(.center).frame(width: 130)
            }
            if !node.tools.isEmpty {
                Text(node.tools.joined(separator: " → "))
                    .font(Theme.mono).foregroundStyle(Theme.primary.opacity(0.7))
                    .lineLimit(1).frame(width: 130)
            }
        }
        .frame(width: 140)
        .help(node.thought)
    }

    private func icon(_ role: String) -> String {
        switch role {
        case "interpret": return "waveform"
        case "ack": return "bubble.left"
        case "plan": return "brain"
        case "implement": return "hammer"
        case "fallback": return "cpu"
        default: return "circle.hexagongrid"
        }
    }
}

/// A gentle breathing pulse for active nodes.
private struct Pulse: ViewModifier {
    let active: Bool
    @State private var on = false
    func body(content: Content) -> some View {
        content
            .scaleEffect(active && on ? 1.06 : 1.0)
            .opacity(active && on ? 1.0 : 0.92)
            .animation(active ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default, value: on)
            .onAppear { on = true }
    }
}
