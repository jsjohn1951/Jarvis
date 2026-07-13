# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Hub-and-spoke docs.** This file is the always-loaded hub: only what's true *every* session (the mental model + the landmines). Area detail lives in spokes — read the linked spoke when your task touches that area, rather than loading it all up front.

## What this is

Jarvis is a **native-macOS control surface over an existing local/cloud LLM stack** — it adds voice/text I/O and agent orchestration and deliberately does **not** re-implement the inference path. Three processes Jarvis owns, plus two it *reuses and depends on* (must already be working on the machine):

| Process | Port | Owned here? |
|---------|------|-------------|
| `Jarvis.app` (SwiftUI menu-bar client) | →:7777 | yes (`app/`) |
| `JarvisMobile.app` (iOS hybrid client, on-device Gemma fallback) | →:7777/:8082 via LAN/Tailscale | yes (`app/JarvisMobile/`) |
| Orchestrator daemon (Node/TS) | 7777 ws | yes (`orchestrator/`) |
| VS Code "Live Coder" extension (optional) | →:7777 | yes (`editor-extension/`) |
| TTS server (Piper default / Kokoro) | 8082 | yes (`tts/`) |
| llama.cpp 2B "quick" tier (internal classifiers) | 8081 | yes (`scripts/`) |
| llama.cpp Gemma 3 4B "conversation" tier | 8083 | yes (`scripts/`) |
| llama.cpp 9B `llama-server` (+ hot-swapped coder model) | 8080 | **external** (`~/llama.cpp`) |
| Router proxy `proxy.py` | 9090 | **external** (`~/.claude/router/`) |

## The one mental model: routing by model name

The external router (`~/.claude/router/proxy.py`, **not in this repo**) routes each request by its `model` field:
- `claude-*` → `api.anthropic.com` (cloud Sonnet, via the user's **Claude Pro OAuth**).
- a `qwen*` / `*.gguf` name → local `llama.cpp :8080` (zero API cost), with Qwen3 tool-call translation.

So **switching `options.model` between `config.cloudModel` and `config.localModel` is the entire mechanism** for choosing cloud vs. local — same Agent SDK tool loop either way. Every hybrid agent is a Claude Agent SDK session launched with `ANTHROPIC_BASE_URL=http://127.0.0.1:9090` so it inherits this routing. The app is a **dumb client**; all reasoning lives in the orchestrator.

## Hard constraints (these have bitten before)

- **Never set `ANTHROPIC_API_KEY`.** Cloud work uses the Claude Pro subscription via the `claude` CLI login; a stray key overrides it (charges / failures). Don't add it to scripts, env, or tests.
- **`SpeechService` must stay NON-`@MainActor`** ([app/Jarvis/Voice/SpeechService.swift](app/Jarvis/Voice/SpeechService.swift)). SFSpeech/audio-tap callbacks fire off-main; making the type `@MainActor` SIGTRAPs on first mic use. Read the comment there before touching it.
- **App Sandbox is intentionally OFF** (personal self-signed app) so it can send Apple Events (music dim) and capture the screen. macOS TCC still gates Mic / Speech / Automation / Screen Recording.
- The orchestrator **depends on the external `claude-hybrid` stack** (`~/llama.cpp` + `~/.claude/router`); it supervises but does not vendor them.

## Quick commands

```bash
cd orchestrator && npm run typecheck          # after every orchestrator change
npx tsx orchestrator/test/fallback-test.ts    # run one test (framework-less tsx scripts)
bash tts/smoke-piper.sh                        # TTS contract smoke test
./scripts/start-jarvis.sh                      # bring up the whole stack
```

If `npx`/`npm` misbehave in this shell, call `./node_modules/.bin/<tool>` directly. Full commands + conventions: **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

## Spokes — read when your task touches the area

| Working on… | Read |
|-------------|------|
| Any build/test/run, orchestrator internals, dev gotchas | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| System design, data flow, concurrency model | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| STT, wake word, TTS engines, screen/audio context, Sir/Ma'am | [docs/VOICE.md](docs/VOICE.md) · [tts/README.md](tts/README.md) |
| Local models, GGUF hot-swap, the 18 GB budget | [docs/MODELS.md](docs/MODELS.md) |
| Memory capture/retrieval/consolidation, personality | [docs/MEMORY.md](docs/MEMORY.md) |
| Agent registry, tiers, dispatch policy | [docs/AGENTS.md](docs/AGENTS.md) |
| Live coding into VS Code (coder agent, extension, token stream) | [docs/EDITOR.md](docs/EDITOR.md) |
| iOS companion: pairing, mobile auth, on-device model, packaging | [docs/IOS.md](docs/IOS.md) |
| Install / dependencies / first-run permissions | [README.md](README.md) · [docs/SETUP.md](docs/SETUP.md) |
| Past design specs & implementation plans (dated) | [docs/superpowers/](docs/superpowers/) |
