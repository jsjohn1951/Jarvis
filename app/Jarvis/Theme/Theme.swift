import SwiftUI
import AppKit

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

/// Real behind-window blur (AppKit). SwiftUI's `.ultraThinMaterial` only blurs
/// content *within* the app; for genuine glassmorphism the hosting window must be
/// non-opaque and an NSVisualEffectView must sample what's behind it. Used as the
/// base layer of `glassSurface()` on whole-window surfaces (HUD + registry).
struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material = .hudWindow
    var blending: NSVisualEffectView.BlendingMode = .behindWindow

    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = blending
        v.state = .active
        // Clear the host window's opacity so the blur shows the desktop behind it.
        DispatchQueue.main.async {
            if let win = v.window { win.isOpaque = false; win.backgroundColor = .clear }
        }
        return v
    }
    func updateNSView(_ v: NSVisualEffectView, context: Context) {
        v.material = material
        v.blendingMode = blending
    }
}

/// Reach the hosting `NSWindow` from SwiftUI to apply AppKit-only configuration
/// (fullscreen capability, transparency) that SwiftUI scene modifiers don't expose.
struct WindowAccessor: NSViewRepresentable {
    var configure: (NSWindow) -> Void
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { if let w = v.window { configure(w) } }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {}
}

extension View {
    /// Allow the hosting window to enter native fullscreen (green button) and be
    /// freely resized — `.windowResizability(.contentMinSize)` alone pins it down.
    func allowsFullScreen() -> some View {
        background(WindowAccessor { w in
            w.styleMask.insert(.resizable)
            w.collectionBehavior.insert(.fullScreenPrimary)
        })
    }

    /// Whole-surface glassmorphism: behind-window blur + a translucent Obsidian
    /// tint + the cyan hairline. Apply to a view's root in place of a solid
    /// `.background(Theme.base)`.
    func glassSurface(tint: Double = 0.55, cornerRadius: CGFloat = 0) -> some View {
        background {
            ZStack {
                VisualEffectBackground()
                Theme.base.opacity(tint)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius)
                .strokeBorder(Theme.primary.opacity(0.18), lineWidth: cornerRadius > 0 ? 1 : 0)
        )
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
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
