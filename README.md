# JARVIS

A minimal, **native macOS** voice + text front-end that orchestrates local and cloud AI agents — an Iron-Man-themed control surface for your existing `claude-hybrid` local-LLM dev setup.

Jarvis does **not** replace your stack. It sits on top of it:

```
You ──voice/text──► Jarvis.app ──ws──► Orchestrator ──► router :9090 ─┬─► Anthropic (Sonnet)
                    (SwiftUI)          (Node/Agent SDK)               └─► llama.cpp :8080 (Qwen)
```

- **Jarvis.app** — a `MenuBarExtra` SwiftUI app. Push-to-talk hotkey, "Hey Jarvis" wake word, a text box, and a HUD that speaks back. ~50 MB footprint.
- **Orchestrator** — a small Node/TypeScript daemon (Claude Agent SDK) that turns a command into the right agent session, reusing your hybrid router so the main session runs on cloud Sonnet and subagents run on local Qwen.
- **Model tooling** — speculative-decoding launch script + model-pull scripts to make local source analysis faster *without losing quality*.

## Why native

Target hardware is a **MacBook Pro M3 Pro, 18 GB unified memory**. Every megabyte counts when a 9B model + KV cache is already resident, so Jarvis is SwiftUI (not Electron), uses on-device Speech/AVFoundation (no Whisper build, no Python audio), and relies on the system SF fonts (no bundling).

## Quickstart

See [docs/SETUP.md](docs/SETUP.md). First time:

```bash
cd orchestrator && npm install && cd ..        # orchestrator deps
./models/pull-models.sh                        # fetch the 2B (draft + quick tier)
#  natural Jarvis voice (Kokoro) — venv + model files, see tts/README.md:
cd tts && uv venv --python 3.12 .venv && uv pip install -r requirements.txt && cd ..
cd app && xcodegen generate && \
  xcodebuild -scheme Jarvis -derivedDataPath ./DerivedData build && cd ..
```

Then, every time:

```bash
./scripts/start-jarvis.sh    # backend + 2B + Kokoro voice + orchestrator, opens the app
./scripts/stop-jarvis.sh     # stop everything (or the ⏻ Quit button / ⌘Q in the HUD)
```

The app appears in your menu bar (no Dock icon). Type a command in the popover; voice lands in Phase 5.

> Auth: hybrid (`dev`) agents use your **Claude Pro subscription** — be logged in via `claude` and keep `ANTHROPIC_API_KEY` unset. The `quick` agent and all model work are 100% local.

## Layout

| Path | What |
|------|------|
| [app/](app/) | SwiftUI menu-bar app |
| [orchestrator/](orchestrator/) | Node/TS daemon (Agent SDK) |
| [scripts/](scripts/) | llama.cpp launch + hybrid lifecycle |
| [tts/](tts/) | Kokoro neural voice server (natural Jarvis TTS) |
| [models/](models/) | model-pull helpers (not the GGUF blobs) |
| [docs/](docs/) | architecture, design, setup, voice, models, agents |

## Documentation

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit and reuse the router
- [DESIGN.md](docs/DESIGN.md) — the HUD visual system
- [SETUP.md](docs/SETUP.md) — prerequisites and first run
- [MODELS.md](docs/MODELS.md) — speed work + model selection
- [VOICE.md](docs/VOICE.md) — STT / wake word / TTS
- [AGENTS.md](docs/AGENTS.md) — how to add an agent
- [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
</content>
