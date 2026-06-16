# Development

Commands and conventions per component. The always-loaded essentials (mental model, hard constraints) live in the root [CLAUDE.md](../CLAUDE.md); this is the on-demand spoke — read the relevant section when you start working in that component.

## Shell quirks (read once)

- In this environment `npx` / `npm run` are sometimes rewritten and fail (e.g. `Missing script: tsx`). If that happens, call the binary directly: `./node_modules/.bin/tsx …`, `./node_modules/.bin/tsc …`.
- Some `git` / `cat` output is filtered and can look truncated or stale. For ground truth use `rtk proxy <cmd>` (e.g. `rtk proxy cat .gitignore`) or `git --no-pager show <sha>:<path>`.

## Orchestrator (`orchestrator/`)

Node ≥22, TypeScript, **NodeNext ESM** — local imports use a `.js` extension on `.ts` source (e.g. `import { config } from "./config.js"`).

```bash
npm install
npm run dev        # tsx watch src/index.ts
npm start          # tsx src/index.ts (run the daemon)
npm run build      # tsc → dist/
npm run typecheck  # tsc --noEmit — run after every change
```

**Tests** are standalone `tsx` scripts in `orchestrator/test/` (no framework — each uses `node:assert` and `process.exit`). Run one with `npx tsx test/<name>-test.ts` (or `./node_modules/.bin/tsx …`).
- `fallback-test.ts` — pure unit test (no stack needed).
- `quick-test.ts`, `triage-test.ts`, `context-test.ts`, `wake-test.ts` — integration tests that need the local stack running (:8081 quick tier, :7777 orchestrator).

### Source map (`orchestrator/src/`)

- `server.ts` — WebSocket API (:7777). In: `prompt` (+ optional `triage`/`honorific`/`image`/`nowPlaying`), `health`, `agents`, `models`, `swap`. Out: streamed `status`/`agent`/`text`/`tool`/`done`/`error`/`ignored`.
- `dispatcher.ts` — picks an agent. Keyword fast-path, else classifies on the **local 2B** (free); `isAddressed()` is the wake-word addressee check. Images force a vision-capable hybrid agent.
- `agents/index.ts` — agent registry. Each agent is `tier: "hybrid"` (Claude Agent SDK + tools, via router) or `"local"` (the 2B quick tier, no tools).
- `runner.ts` — `runHybrid` (hybrid agents) and one-shot `cloudComplete`. **Cloud-unavailability fallback:** on a rate-limit/overload error it retries the same agent on the local 9B and trips a circuit breaker (`fallback.ts`), so subsequent requests skip the cloud during a cooldown, then probe again.
- `fallback.ts` — the circuit breaker (`isOpen`/`trip`/`reset`) + `isClaudeUnavailable(err)` predicate.
- `quick.ts` — streams from the 2B tier (:8081, OpenAI-compatible, thinking disabled).
- `memory.ts` + `personality.ts` — build every system prompt from `personality/*.md` + retrieved long-term memory + the short-term buffer. The 2B captures candidate facts continuously (free); cloud Sonnet consolidates periodically into `memory/long-term/*.md`. See [MEMORY.md](MEMORY.md).
- `lifecycle.ts` / `models.ts` — health checks and **hot-swapping** the 9B GGUF. Local inference serializes on one `llama-server` (`-np 1`); specialized models are swapped, not co-resident (~14.3 GB GPU working-set ceiling — see [MODELS.md](MODELS.md)).

## App (`app/`)

SwiftUI, Swift 6, macOS 26. Menu-bar-only (no Dock icon).

```bash
cd app && xcodegen generate && xcodebuild -scheme Jarvis -derivedDataPath ./DerivedData build
```

`project.yml` is the source of truth; `Jarvis.xcodeproj` is **generated** by `xcodegen` — don't hand-edit it. App-side detail (STT, wake word, screen/audio context, Sir/Ma'am) is in [VOICE.md](VOICE.md).

## TTS (`tts/`)

Two interchangeable engines on `:8082`, same OpenAI-compatible `/v1/audio/speech`; only one binds the port at a time.

```bash
bash tts/smoke-piper.sh        # contract test: Piper on a throwaway port, assert a valid WAV
```

- **Piper** (default) — `en_GB-alan`, `tts/piper_server.py`, venv `tts/.venv-piper`.
- **Kokoro** — `bm_george`, `tts/server.py`, venv `tts/.venv`; selected with `JARVIS_TTS_ENGINE=kokoro`.

The launcher warns if a different engine already holds `:8082`. The system `python3.12` is x86_64, so these venvs run under Rosetta. Setup + switching: [../tts/README.md](../tts/README.md).

## Whole stack

```bash
./scripts/start-jarvis.sh   # external 9B+router, 2B quick, TTS, orchestrator, opens the app
./scripts/stop-jarvis.sh
```

Full install / dependencies: [../README.md](../README.md).
