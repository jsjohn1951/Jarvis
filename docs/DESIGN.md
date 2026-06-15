# Design — "Aether HUD" (merged)

Two stitch concepts were generated in [Design-1/](Design-1/) and [Design-2/](Design-2/). The canonical Jarvis look is a **merge**:

- **Design-2 (Obsidian) = the visual/typographic system.** Cleaner, more whitespace, fonts that map onto native SF, red reserved for alerts, and it already drew stack-telemetry badges. (Only its agent screen rendered — the other two PNGs are broken stubs.)
- **Design-1 (Deep Space) = the screen/information architecture.** It rendered the full set we need: the wake-word "LISTENING" command center, the ACTIVE_AGENTS row, and the VOICE_INTERACTION_PROTOCOL config.

Net: build Design-1's screens using Design-2's tokens, adapted to a menu-bar form factor.

## Form factors

| Surface | Size | Contents |
|---------|------|----------|
| **Menu-bar popover** (primary) | ~380 × 520 pt | Mic/arc-reactor state, live transcript, top-3 active agents, health row, text input |
| **Expanded HUD window** (optional) | resizable | Full agent registry + per-agent controls, voice config, process streams |

The full-window dashboards from the concepts are the *expanded HUD*; the popover is a distilled subset.

## Color tokens (canonical — from Design-2, Obsidian)

Define these as a SwiftUI `Color` asset catalog (`app/Jarvis/Assets.xcassets`) / a `Theme` enum.

| Token | Hex | Use |
|-------|-----|-----|
| `base` | `#05070A` | window background (vantablack) |
| `surface` | `#111417` | base panel |
| `surfaceContainer` | `#1D2023` | elevated glass panel (40–60% opacity + blur) |
| `surfaceContainerHigh` | `#282A2E` | active panel |
| `onSurface` | `#E1E2E7` | primary text |
| `onSurfaceVariant` | `#B9CACB` | secondary text |
| `outline` | `#849495` | borders |
| `primary` (Arc Cyan) | `#00F2FF` | active state, focal data, glow |
| `onPrimary` | `#00363A` | text on cyan fills |
| `alert` (Emergency Red) | `#FFB4AA` / container `#C5020B` | **alerts only** |

**Glow** = the signature. Active elements emit a diffuse cyan outer shadow, e.g. `shadow(color: primary.opacity(0.3), radius: 12)`. Depth via tonal layering + one `.ultraThinMaterial` blur, **not** stacked drop shadows.

## Typography (native mapping)

Concept used Inter + Geist; we map to system fonts so nothing is bundled:

| Role | Concept font | Native | SwiftUI |
|------|-------------|--------|---------|
| Display / headline | Inter | **SF Pro** | `.system(size:, weight:)` |
| Body | Inter | SF Pro | `.body` |
| Labels (UPPERCASE, tracked) | Geist | SF Pro | `.font(.caption).textCase(.uppercase).tracking(1.2)` |
| Data / telemetry (monospaced) | Geist mono | **SF Mono** | `.system(.body, design: .monospaced)` |

Rule: any fluctuating value (latency, token counts, %, GB) uses **monospaced** to prevent layout jitter.

## Shape & spacing

- Corner radius **4 pt** (`0.25rem`) for panels — machined, not rounded.
- Circles reserved for the **arc-reactor mic indicator** and progress/status rings.
- 4 pt base spacing unit; 16 pt gutters; 24 pt panel padding.
- Optional L-shaped **corner brackets** on the primary panel only (borrowed from Design-1) — used sparingly so the popover stays clean.

## Key components

- **Arc-reactor mic indicator** — a circular ring that reflects state via color + animation:
  - `idle` dim cyan, slow breath · `listening` bright cyan pulse + live waveform · `thinking` rotating segmented ring · `speaking` amplitude-reactive · `alert` red.
- **Agent card** — glass panel, top accent line, monospaced `[SEC-0x]`/id tag, name, one-line current task, status chip, optional load gauge. Controls (pause/restart/kill) appear in the expanded HUD.
- **Status row** — three monospaced telemetry chips: `llama.cpp`, `router`, `orchestrator`, each dot-coded (cyan = healthy, red = down) with latency — directly from Design-2's top bar.
- **Status chip** — 1px outline, no fill; status by text color (cyan active / red alert / white standby).
- **Buttons** — ghost by default (1px cyan border, fills 10% cyan on hover/press); primary action filled Arc Cyan with dark text.
- **Text input** — bottom-border field; on focus the border glows cyan and the label rises to the uppercase `label-caps` style.

## Screen blueprints (from Design-1, restyled)

1. **Command Center (popover home)** — arc-reactor center showing "LISTENING — waiting for wake word" with live waveform; `MANUAL COMMAND` / text input below; ACTIVE_AGENTS (top 3) and the health row.
2. **Voice config** — primary trigger word (default "JARVIS"), input-sensitivity slider, voice profile + rate, live waveform preview.
3. **Agent registry (expanded HUD)** — grid of agent cards with per-agent pause/restart/kill and a cluster-overview telemetry strip.

Reference renders: [Design-1/a.r.v.i.s._command_center/screen.png](Design-1/a.r.v.i.s._command_center/screen.png), [Design-1/v.o.i.c.e._configuration/screen.png](Design-1/v.o.i.c.e._configuration/screen.png), [Design-2/agent_oversight_iron_man_hud/screen.png](Design-2/agent_oversight_iron_man_hud/screen.png).
</content>
