import ScreenCaptureKit
import AppKit

/// Captures the main display as a PNG (base64) for the vision agent.
/// Requires Screen Recording permission (prompted on first use).
enum ScreenContext {
    static func captureMainDisplayPNGBase64() async -> String? {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { return nil }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let cfg = SCStreamConfiguration()
            cfg.width = display.width      // 1x point size — modest payload, plenty for vision
            cfg.height = display.height
            let cg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
            let rep = NSBitmapImageRep(cgImage: cg)
            guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
            return data.base64EncodedString()
        } catch {
            return nil
        }
    }
}
