# iOS Arc-Reactor Animation + Mac HUD Phone Chip & Service Controls

**Date:** 2026-07-13 · **Status:** implemented

## Problem

1. The JarvisMobile screen had dead space above the mic button; the app icon's
   arc-reactor identity appeared nowhere in the running UI.
2. The Mac HUD gave no indication when the phone connected to the orchestrator,
   and offered no way to start/stop the orchestrator (:7777) or the router proxy
   (:9090) without a terminal.

## Decisions (user-approved)

- **Animation:** the icon-matching arc reactor (rings, rotating segments,
  breathing core), with the core additionally modulated by live mic level while
  listening.
- **Sharing over copying:** `ArcReactorView` moved from `app/Jarvis/MenuBar/`
  (macOS-only) to `app/Jarvis/SharedUI/`, which both targets compile. Its
  `Theme.*` colors became parameters defaulting to the Obsidian palette values,
  and `Color(hex:)` moved with it (out of the iOS-excluded `Theme/**`). It
  gained `var level: Float = 0`; the macOS call site is unchanged.
- **Phone state is computed, not evented:** the orchestrator recomputes
  "any OPEN mobile socket?" from its existing `clientRole` map on every mobile
  connect/disconnect and broadcasts `{type:"phone", connected, device?}` to
  desktop clients; the welcome burst also carries it so a late-connecting Mac
  learns the state. Correct for reconnects and multiple phones by construction.
- **Controls scope: both** — a STACK toggle (whole stack) plus individual ORCH
  and PROXY toggles, rendered as a services row in the HUD.
- **Scripts stay the single source of truth:** the Mac app spawns the repo's
  own scripts via `Process` (start can't ride a WebSocket to a daemon that is
  down). New thin scripts/flags rather than shell logic in Swift:
  `orchestrator-up.sh` / `orchestrator-down.sh` (factored from start-jarvis.sh /
  stop-backend.sh), `hybrid-up.sh --router-only`, `hybrid-down.sh
  --router-only`, `stop-jarvis.sh --keep-app`. `orchestrator-up.sh` locates
  npm itself (nvm/brew) because a GUI-spawned process has a minimal PATH.
- **Blast-radius confirmations:** stopping PROXY or STACK requires a
  confirmation dialog — :9090 is shared with the claude-hybrid Claude Code
  stack, so those stops break more than Jarvis. ORCH stops without ceremony.
- **State probing:** `ServiceController.refresh` trusts the live WS
  (`client.connected` + health.router) when available, else raw loopback TCP
  probes of :7777/:9090 — truthful even with everything down.

## Touched

- `orchestrator/src/server.ts` — `phone` Outbound member, `mobileDevices`,
  `phoneStatus()`, `broadcastToDesktop()`, welcome/hello/close seams;
  `orchestrator/test/phone-broadcast-test.ts` (5 scenarios).
- `app/Jarvis/SharedUI/ArcReactorView.swift` (moved+extended),
  `app/Jarvis/Theme/Theme.swift` (Color(hex:) removed),
  `app/JarvisMobile/UI/MobileHUDView.swift` (reactor above mic, `reactorState`).
- `app/Jarvis/Orchestrator/OrchestratorClient.swift` — `phoneConnected` /
  `phoneDevice`, `case "phone"`, reset on reconnect.
- `app/Jarvis/MenuBar/HUDView.swift` — iPhone header chip, services row,
  confirmation dialog; `app/Jarvis/MenuBar/ServiceController.swift` (new).
- `scripts/` — orchestrator-up/down.sh (new), hybrid-up/down.sh + stop-jarvis.sh
  flags, start-jarvis.sh delegates to orchestrator-up.sh, ios-package.sh
  empty-array `set -u` fix for macOS bash 3.2.

## Known limitation

A script spawned from the app inherits the GUI environment, so mobile-exposure
vars (`JARVIS_WS_HOST` etc.) don't apply — LAN-exposed startup still happens
from a terminal via ios-package.sh.
