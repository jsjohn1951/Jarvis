import SwiftUI

/// Live microphone waveform shown while the user is speaking — it replaces the
/// transcribed-command echo in the HUD, so only Jarvis's reply remains as text.
/// Bars scroll left as new mic levels arrive (newest on the right).
struct WaveformView: View {
    let levels: [Float]

    var body: some View {
        GeometryReader { geo in
            let count = max(levels.count, 1)
            let spacing: CGFloat = 3
            let barW = max(2, (geo.size.width - spacing * CGFloat(count - 1)) / CGFloat(count))
            HStack(alignment: .center, spacing: spacing) {
                ForEach(Array(levels.enumerated()), id: \.offset) { _, level in
                    Capsule()
                        .fill(Theme.primary)
                        .frame(width: barW, height: barHeight(level, maxH: geo.size.height))
                        .opacity(0.45 + Double(level) * 0.55)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            .shadow(color: Theme.primary.opacity(0.5), radius: 4)
            .animation(.easeOut(duration: 0.08), value: levels)
        }
        .frame(height: 36)
    }

    private func barHeight(_ level: Float, maxH: CGFloat) -> CGFloat {
        let minH: CGFloat = 3
        return minH + CGFloat(level) * (maxH - minH)
    }
}
