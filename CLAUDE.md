# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Jarvis is a **native-macOS control surface over an existing local/cloud LLM stack** — it adds voice/text I/O and agent orchestration, and deliberately does **not** re-implement the inference path. Three processes Jarvis owns, plus two it *reuses and depends on* (must already be working on the machine):

| Process | Port | Owned by Jarvis? |
|---------|------|------------------|
| `Jarvis.app` (SwiftUI menu-bar client) | — (connects to :7777) | yes (`app/`) |
| Orchestrator daemon (Node/TS) | 7777 (WebSocket) | yes (`orchestrator/`) |
| TTS server (Piper default / Kokoro) | 8082 | yes (`tts/`) |
| llama.cpp 2B "quick" tier | 8081 | yes (launched by `scripts/`) |
| llama.cpp 9B `llama-server` | 8080 | **external** (`~/llama.cpp`, the `claude-hybrid` stack) |
| Router proxy `proxy.py` | 9090 | **external** (`~/.claude/router/`) |

## The one mental model that explains everything: routing by model name

The external router (`~/.claude/router/proxy.py`, **not in this repo**) inspects each request's `model` field:
- `claude-*` → `api.anthropic.com` (cloud Sonnet, via the user's **Claude Pro OAuth**).
- a `qwen*` / `*.gguf` name → local `llama.cpp :8080` (zero API cost), with Qwen3 tool-call translation.

So **switching `options.model` between `config.cloudModel` and `config.localModel` is the entire mechanism** for choosing cloud vs. local — same Agent SDK tool loop either way. Every hybrid agent is a Claude Agent SDK session launched with `ANTHROPIC_BASE_URL=http://127.0.0.1:9090` so it inherits this routing. The app is a **dumb client**; all reasoning lives in the orchestrator.

## Hard constraints (these have bitten before)

- **Never set `ANTHROPIC_API_KEY`.** Cloud work uses the Claude Pro subscription via the `claude` CLI login. A stray key overrides the subscription (charges / failures). Don't add it to scripts, env, or tests.
- **`SpeechService` must stay NON-`@MainActor`** ([app/Jarvis/Voice/SpeechService.swift](app/Jarvis/Voice/SpeechService.swift)). SFSpeech/audio-tap callbacks fire off-main; making the type `@MainActor` makes Swift's runtime isolation check SIGTRAP on first mic use. See the comment in that file before touching it.
- **App Sandbox is intentionally OFF** (personal self-signed app) so it can send Apple Events (music dim) and capture the screen. macOS TCC still gates Microphone / Speech / Automation / Screen Recording.
- The orchestrator depends on the external `claude-hybrid` stack being healthy (`~/llama.cpp` + `~/.claude/router`); it supervises but does not vendor them.

## Commands

### Orchestrator (`orchestrator/`, Node ≥22, TypeScript, NodeNext ESM)
```bash
npm install
npm run dev        # tsx watch src/index.ts
npm start          # tsx src/index.ts (run the daemon)
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit (run after every change)
```
- **Tests are standalone `tsx` scripts** in `orchestrator/test/` (no framework — each uses `node:assert` and `process.exit`). Run one with `npx tsx test/<name>-test.ts`. `fallback-test.ts` is a pure unit test; `quick-test.ts` / `triage-test.ts` / `context-test.ts` / `wake-test.ts` are integration tests that need the local stack (:8081, :7777) running.
- **ESM gotcha:** local imports use a **`.js` extension** on `.ts` source (e.g. `import { config } from "./config.js"`).
- **Shell gotcha:** in this environment `npx` / `npm run` are sometimes rewritten and fail (e.g. `Missing script: tsx`). If that happens, call the binary directly: `./node_modules/.bin/tsx …`, `./node_modules/.bin/tsc …`. Likewise some git/`cat` output is filtered — use `rtk proxy <cmd>` or `git --no-pager show <sha>:<path>` for ground truth.

### App (`app/`, SwiftUI, Swift 6, macOS 26)
```bash
cd app && xcodegen generate && xcodebuild -scheme Jarvis -derivedDataPath ./DerivedData build
```
`project.yml` is the source of truth; `Jarvis.xcodeproj` is **generated** by `xcodegen` (don't hand-edit it).

### TTS (`tts/`, two interchangeable engines on :8082)
```bash
bash tts/smoke-piper.sh        # contract test: start Piper on a throwaway port, assert a valid WAV
```
Default engine is **Piper** (`en_GB-alan`, `tts/piper_server.py`, venv `tts/.venv-piper`). Kokoro (`bm_george`, `tts/server.py`, venv `tts/.venv`) is reachable via `JARVIS_TTS_ENGINE=kokoro`. Both serve the same OpenAI-compatible `/v1/audio/speech`; only one binds :8082 at a time. See [tts/README.md](tts/README.md). (Note: the system `python3.12` is x86_64, so these venvs run under Rosetta.)

### Whole stack
```bash
./scripts/start-jarvis.sh   # external 9B+router, 2B quick, TTS, orchestrator, opens the app
./scripts/stop-jarvis.sh
```

## Orchestrator internals (`orchestrator/src/`)

- `server.ts` — WebSocket API (:7777). In: `prompt` (+ optional `triage`/`honorific`/`image`/`nowPlaying`), `health`, `agents`, `models`, `swap`. Out: streamed `status`/`agent`/`text`/`tool`/`done`/`error`/`ignored` events.
- `dispatcher.ts` — picks an agent. Keyword fast-path, else classifies on the **local 2B** (free); `isAddressed()` does the wake-word addressee check. Images force a vision-capable hybrid agent.
- `agents/index.ts` — agent registry. Each agent is `tier: "hybrid"` (Claude Agent SDK + tools, via router) or `"local"` (the 2B quick tier, no tools).
- `runner.ts` — runs hybrid agents (`runHybrid`) and one-shot `cloudComplete`. **Cloud-unavailability fallback:** on a rate-limit/overload error it retries the same agent on the local 9B and trips a circuit breaker (`fallback.ts`) so subsequent requests skip the cloud during a cooldown, then probe again.
- `quick.ts` — streams from the 2B tier (:8081, OpenAI-compatible, thinking disabled).
- `memory.ts` + `personality.ts` — every system prompt = `personality/*.md` + retrieved long-term memory + short-term buffer. The 2B captures candidate facts continuously (free); cloud Sonnet consolidates periodically into `memory/long-term/*.md`. See [docs/MEMORY.md](docs/MEMORY.md).
- `lifecycle.ts` / `models.ts` — health checks and **hot-swapping** the 9B GGUF (local inference serializes on one `llama-server`; specialized models are swapped, not co-resident, because of the ~14.3 GB GPU working-set ceiling — see [docs/MODELS.md](docs/MODELS.md)).

## Planning docs

Design specs and implementation plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/` (dated). Deeper references: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/VOICE.md](docs/VOICE.md), [docs/MODELS.md](docs/MODELS.md), [docs/AGENTS.md](docs/AGENTS.md), [docs/MEMORY.md](docs/MEMORY.md).
