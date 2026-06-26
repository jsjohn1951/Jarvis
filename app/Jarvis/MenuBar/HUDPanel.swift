import SwiftUI
import AppKit
import Combine

/// Borderless, always-on-top, non-activating glass panel that hosts the HUD and is
/// revealed when Jarvis is addressed by voice. Independent of the menu-bar popover,
/// so it can be shown/hidden programmatically (which a `MenuBarExtra` popover can't).
/// `.nonactivatingPanel` means revealing/dismissing it never steals focus from the
/// app the user was in.
final class HUDPanel: NSPanel {
    var onEscape: (() -> Void)?

    init(content: NSView) {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 412, height: 600),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false
        )
        isFloatingPanel = true
        level = .floating
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovableByWindowBackground = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        contentView = content
    }

    // Allow the command text field to focus and Esc to work without activating the app.
    override var canBecomeKey: Bool { true }
    override func cancelOperation(_ sender: Any?) { onEscape?() }
}

/// Reveals / dismisses the floating HUD. Reveals when the orchestrator confirms the
/// user addressed Jarvis; auto-hides when the turn ends and no follow-up is open,
/// with an idle-timeout backstop. The user can also dismiss it manually (Esc or the
/// HUD's close button) without ending wake-word listening.
@MainActor
final class HUDPanelController: ObservableObject {
    private var panel: HUDPanel?
    private let client: OrchestratorClient
    private let voice: VoiceController
    private var hideWork: DispatchWorkItem?
    private var bag = Set<AnyCancellable>()

    /// True while the menu-bar popover (the manually-opened HUD) is on screen. When it is,
    /// revealing the floating panel would stack a second, identical HUD behind it — so we
    /// suppress the reveal and let the already-open popover serve as the visible HUD.
    var popoverOpen = false

    init(client: OrchestratorClient, voice: VoiceController) {
        self.client = client
        self.voice = voice
        client.onAddressed = { [weak self] in self?.reveal() }

        // Auto-hide policy: while a turn is active the panel stays; once it goes idle
        // and we're not in a follow-up exchange, fade it out after a short grace.
        client.$state
            .sink { [weak self] state in
                guard let self else { return }
                if state == .idle { self.armIdleHide() } else { self.cancelIdleHide() }
            }
            .store(in: &bag)
    }

    func reveal() {
        // The user already has a HUD up (the menu-bar popover) — don't stack a second one
        // behind it. The open popover is the visual acknowledgment of being addressed.
        if popoverOpen { return }
        cancelIdleHide()
        let panel = ensurePanel()
        position(panel)
        if !panel.isVisible {
            // Sound the chime as the HUD opens on being addressed — same cue as launch.
            // Only on the hidden→visible transition, so a re-reveal mid-turn won't re-chime.
            StartupSound.play()
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.22
                panel.animator().alphaValue = 1
            }
        }
    }

    func dismiss() {
        cancelIdleHide()
        guard let panel, panel.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.18
            panel.animator().alphaValue = 0
        }, completionHandler: { panel.orderOut(nil) })
    }

    // MARK: - internals

    private func ensurePanel() -> HUDPanel {
        if let panel { return panel }
        let host = NSHostingView(rootView: HUDView(client: client, voice: voice, onClose: { [weak self] in self?.dismiss() }))
        host.frame = NSRect(x: 0, y: 0, width: 412, height: 600)
        let p = HUDPanel(content: host)
        p.onEscape = { [weak self] in self?.dismiss() }
        panel = p
        return p
    }

    /// Top-right of the active screen, tucked under the menu bar.
    private func position(_ panel: HUDPanel) {
        guard let screen = NSScreen.main else { return }
        let vf = screen.visibleFrame
        let size = panel.frame.size
        let origin = NSPoint(x: vf.maxX - size.width - 20, y: vf.maxY - size.height - 12)
        panel.setFrameOrigin(origin)
    }

    private func armIdleHide() {
        cancelIdleHide()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            // Still idle and not mid follow-up conversation → hide.
            if self.client.state == .idle && !self.voice.inFollowUp { self.dismiss() }
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 6, execute: work)
    }

    private func cancelIdleHide() {
        hideWork?.cancel()
        hideWork = nil
    }
}
