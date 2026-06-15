import AppKit

/// Global push-to-talk hotkey (default ⌥Space). Tapping it starts a one-shot
/// listen that auto-ends on silence.
///
/// Note: system-wide keyDown monitoring requires the "Input Monitoring" privacy
/// permission. Without it, only the local monitor (app focused) fires — the mic
/// button and wake word remain fully functional regardless.
@MainActor
final class Hotkey {
    private var global: Any?
    private var local: Any?
    var onTrigger: (() -> Void)?

    private let keyCode: UInt16 = 49        // space
    private let needsOption = true

    func enable() {
        let matches: (NSEvent) -> Bool = { [weak self] e in
            guard let self else { return false }
            return e.keyCode == self.keyCode && (!self.needsOption || e.modifierFlags.contains(.option))
        }
        global = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if matches(e) { self?.onTrigger?() }
        }
        local = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in
            if matches(e) { self?.onTrigger?(); return nil }
            return e
        }
    }

    func disable() {
        if let global { NSEvent.removeMonitor(global) }
        if let local { NSEvent.removeMonitor(local) }
        global = nil; local = nil
    }
}
