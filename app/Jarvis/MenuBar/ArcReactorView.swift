import SwiftUI

/// The signature Iron-Man "arc reactor" — a circular indicator whose colour and
/// animation reflect the HUD state. Pure SwiftUI shapes + glow, no assets.
struct ArcReactorView: View {
    let state: HUDState
    @State private var spin = false
    @State private var breathe = false

    private var tint: Color { state == .alert ? Theme.alert : Theme.primary }

    var body: some View {
        ZStack {
            // Outer glow
            Circle().fill(tint).opacity(glowOpacity).blur(radius: 18)
                .frame(width: 78, height: 78)

            // Static outer ring
            Circle().strokeBorder(tint.opacity(0.25), lineWidth: 1)
                .frame(width: 74, height: 74)

            // Rotating segmented ring (most alive while thinking)
            Circle()
                .trim(from: 0, to: 0.72)
                .stroke(tint.opacity(0.9), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [10, 6]))
                .frame(width: 60, height: 60)
                .rotationEffect(.degrees(spin ? 360 : 0))
                .animation(spinAnim, value: spin)

            // Core
            Circle().fill(tint.opacity(coreOpacity))
                .frame(width: 26, height: 26)
                .scaleEffect(breathe ? 1.12 : 0.9)
                .animation(breatheAnim, value: breathe)
                .shadow(color: tint.opacity(0.8), radius: 10)

            Image(systemName: icon)
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Theme.base)
        }
        .frame(width: 84, height: 84)
        .onAppear { spin = true; breathe = true }
    }

    private var icon: String {
        switch state {
        case .idle: "moon.zzz.fill"
        case .listening: "waveform"
        case .thinking: "gearshape.fill"
        case .speaking: "speaker.wave.2.fill"
        case .alert: "exclamationmark.triangle.fill"
        }
    }
    private var glowOpacity: Double { state == .idle ? 0.15 : 0.4 }
    private var coreOpacity: Double { state == .idle ? 0.5 : 0.95 }
    private var spinAnim: Animation {
        switch state {
        case .thinking: .linear(duration: 2).repeatForever(autoreverses: false)
        case .listening, .speaking: .linear(duration: 6).repeatForever(autoreverses: false)
        default: .linear(duration: 12).repeatForever(autoreverses: false)
        }
    }
    private var breatheAnim: Animation {
        switch state {
        case .speaking, .listening: .easeInOut(duration: 0.5).repeatForever(autoreverses: true)
        case .thinking: .easeInOut(duration: 1).repeatForever(autoreverses: true)
        default: .easeInOut(duration: 2.6).repeatForever(autoreverses: true)
        }
    }
}
