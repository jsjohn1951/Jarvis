import SwiftUI

/// Canonical "Aether HUD" tokens — the Obsidian palette from docs/DESIGN.md,
/// mapped to native SF fonts (no bundled typefaces).
enum Theme {
    // Palette
    static let base = Color(hex: 0x05070A)            // window background
    static let surface = Color(hex: 0x111417)
    static let surfaceContainer = Color(hex: 0x1D2023)
    static let surfaceHigh = Color(hex: 0x282A2E)
    static let onSurface = Color(hex: 0xE1E2E7)
    static let onSurfaceVariant = Color(hex: 0xB9CACB)
    static let outline = Color(hex: 0x3A494B)
    static let primary = Color(hex: 0x00F2FF)          // Arc Cyan
    static let onPrimary = Color(hex: 0x00363A)
    static let alert = Color(hex: 0xFFB4AA)            // alerts ONLY

    static let radius: CGFloat = 4                     // machined corners

    // Type roles → system fonts (Inter→SF Pro, Geist→SF Mono)
    static func display(_ size: CGFloat = 22) -> Font { .system(size: size, weight: .semibold) }
    static let body = Font.system(size: 13)
    static func label() -> Font { .system(size: 11, weight: .semibold) }   // UPPERCASE + tracking at call site
    static let mono = Font.system(.caption, design: .monospaced)           // fluctuating data

    /// Diffuse cyan emission for active elements.
    static func glow(_ color: Color = primary, _ radius: CGFloat = 12, _ opacity: Double = 0.35) -> some View {
        color.opacity(opacity).blur(radius: radius)
    }
}

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

/// Decorative L-shaped HUD corner brackets (Design-1 motif), used sparingly on
/// the primary panel.
struct CornerBrackets: View {
    var color: Color = Theme.primary.opacity(0.45)
    var len: CGFloat = 14
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            Path { p in
                p.move(to: CGPoint(x: 0, y: len)); p.addLine(to: .zero); p.addLine(to: CGPoint(x: len, y: 0))
                p.move(to: CGPoint(x: w - len, y: 0)); p.addLine(to: CGPoint(x: w, y: 0)); p.addLine(to: CGPoint(x: w, y: len))
                p.move(to: CGPoint(x: 0, y: h - len)); p.addLine(to: CGPoint(x: 0, y: h)); p.addLine(to: CGPoint(x: len, y: h))
                p.move(to: CGPoint(x: w - len, y: h)); p.addLine(to: CGPoint(x: w, y: h)); p.addLine(to: CGPoint(x: w, y: h - len))
            }
            .stroke(color, lineWidth: 1.5)
        }
        .allowsHitTesting(false)
    }
}

/// A glass panel with a 1px cyan-tinted border and one blur layer (per DESIGN.md
/// "single-layer glassmorphism").
struct GlassPanel<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(12)
            .background(Theme.surfaceContainer.opacity(0.6))
            .background(.ultraThinMaterial)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius)
                    .strokeBorder(Theme.primary.opacity(0.2), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
    }
}
