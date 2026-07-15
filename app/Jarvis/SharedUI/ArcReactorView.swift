import SwiftUI

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// The signature Iron-Man "arc reactor", drawn to match the app icon: bright rim,
/// a rotating ring of ten solid coil segments, an inner ring, and a rounded
/// triangle with vertex dots around a white-hot core. Colour and animation
/// reflect the HUD state. Pure SwiftUI shapes + glow, no assets.
/// Compiled into BOTH targets (Theme.swift is macOS-only, so the Obsidian palette
/// values are inlined here as defaults instead of referenced).
struct ArcReactorView: View {
    let state: HUDState
    /// Live mic level 0…1; modulates the core's scale and glow while listening.
    var level: Float = 0
    var tintPrimary: Color = Color(hex: 0x00F2FF)   // Theme.primary (Arc Cyan)
    var tintAlert: Color = Color(hex: 0xFFB4AA)     // Theme.alert
    @State private var spin = false
    @State private var breathe = false

    private var tint: Color { state == .alert ? tintAlert : tintPrimary }
    private var levelBoost: CGFloat {
        state == .listening ? CGFloat(min(max(level, 0), 1)) : 0
    }

    /// Coil ring: dash period = π·57 / 10 segments, ~3:1 segment-to-gap like the icon.
    private static let coilDash: [CGFloat] = [13.43, 4.48]
    /// Triangle circumradius (frame 28) and its vertex offsets, top point up.
    private static let vertexOffsets: [CGSize] = {
        let r: CGFloat = 14, s = r * sin(.pi / 3)
        return [CGSize(width: 0, height: -r), CGSize(width: s, height: r / 2), CGSize(width: -s, height: r / 2)]
    }()

    var body: some View {
        ZStack {
            // Outer glow
            Circle().fill(tint).opacity(glowOpacity + Double(levelBoost) * 0.35).blur(radius: 18)
                .frame(width: 78, height: 78)

            // Bright rim
            Circle().strokeBorder(tint.opacity(0.85), lineWidth: 2)
                .frame(width: 76, height: 76)
                .shadow(color: tint.opacity(0.5), radius: 3)

            // Rotating coil ring — ten solid segments (thick dashes of one stroked
            // circle), most alive while thinking.
            Circle()
                .stroke(tint.opacity(0.55), style: StrokeStyle(lineWidth: 11, lineCap: .butt, dash: Self.coilDash))
                .frame(width: 57, height: 57)
                .rotationEffect(.degrees(spin ? 360 : 0))
                .animation(spinAnim, value: spin)

            // Inner ring walling off the core chamber
            Circle().strokeBorder(tint.opacity(0.7), lineWidth: 1.5)
                .frame(width: 40, height: 40)

            // Rounded triangle + vertex dots (the icon's center motif)
            ReactorTriangle()
                .stroke(tint.opacity(0.95), style: StrokeStyle(lineWidth: 3, lineJoin: .round))
                .frame(width: 28, height: 28)
                .shadow(color: tint.opacity(0.8), radius: 4)
            ForEach(0..<3, id: \.self) { i in
                Circle().fill(tint)
                    .frame(width: 4.5, height: 4.5)
                    .offset(Self.vertexOffsets[i])
            }

            // White-hot core — slow breathe plus a fast voice-reactive boost.
            Circle().fill(.white.opacity(coreOpacity))
                .frame(width: 11, height: 11)
                .scaleEffect((breathe ? 1.15 : 0.9) + levelBoost * 0.35)
                .animation(breatheAnim, value: breathe)
                .animation(.easeOut(duration: 0.1), value: levelBoost)
                .shadow(color: tint.opacity(0.9), radius: 8)
        }
        .frame(width: 84, height: 84)
        .onAppear { spin = true; breathe = true }
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

/// Equilateral triangle, point up, centered on its circumcenter. Corners read as
/// rounded because it's stroked with a .round line join (see call site).
struct ReactorTriangle: Shape {
    func path(in rect: CGRect) -> Path {
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) / 2
        let s = r * sin(.pi / 3)
        var p = Path()
        p.move(to: CGPoint(x: c.x, y: c.y - r))
        p.addLine(to: CGPoint(x: c.x + s, y: c.y + r / 2))
        p.addLine(to: CGPoint(x: c.x - s, y: c.y + r / 2))
        p.closeSubpath()
        return p
    }
}
