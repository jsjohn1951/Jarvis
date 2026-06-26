# Architecture

Jarvis is a thin, native control surface over an existing hybrid local/cloud LLM stack. It adds **voice + text I/O** and **agent orchestration** without re-implementing the inference path you already trust.

## The existing stack (reused, unchanged)

```
claude-hybrid (zsh)  →  starts:
   • llama.cpp llama-server   :8080   (Qwen3.5-9B-Q4_K_M, Metal, -ngl 99)
   • router proxy proxy.py    :9090   (FastAPI; Anthropic↔OpenAI translation)
```

The **router** (`~/.claude/router/proxy.py`) routes each `/v1/messages` request by the requested model name:
- `claude-*` → `api.anthropic.com` (cloud Sonnet) — the capable model for the main session.
- the local gguf / `qwen*` → `llama.cpp :8080` — for subagents (zero API cost).

It also handles Qwen3's tool-calling quirks (native `<tool_call>` tags, thinking-mode suppression). **Jarvis depends on this and does not duplicate it.**

**Auth:** cloud calls use the user's **Claude Pro subscription** (OAuth), not an API key. The `claude` runtime sends its subscription bearer + `anthropic-beta: oauth-*` headers, which the router passes through. The orchestrator never sets `ANTHROPIC_API_KEY` — doing so would override the subscription.

## What Jarvis adds

```
┌──────────────────────────────┐     WebSocket (:7777)      ┌───────────────────────────┐
│  Jarvis.app (SwiftUI)        │◄──────────────────────────►│ Orchestrator daemon (Node) │
│  • MenuBarExtra HUD          │   prompt / stream / status │ • Claude Agent SDK         │
│  • SpeechAnalyzer (STT)      │                            │ • Agent registry           │
│  • Wake word "Hey Jarvis"    │                            │ • Intent dispatcher        │
│  • Global hotkey (PTT)       │                            │ • Lifecycle supervisor     │
│  • AVSpeechSynthesizer (TTS) │                            └────────────┬──────────────┘
│  • Text input popover        │                                         │ spawns CC sessions
└──────────────────────────────┘                                         │ ANTHROPIC_BASE_URL=:9090
                                                                         ▼
                                              ┌──────────────────────────────────────────┐
                                              │ router :9090 ──┬─► Anthropic (Sonnet)      │
                                              │                └─► llama.cpp :8080 (Qwen)  │
                                              └──────────────────────────────────────────┘
```

### 1. Jarvis.app (SwiftUI, `app/`)
A menu-bar-only app (no Dock icon). It captures intent (voice or text), shows a HUD, and speaks responses. It is a **dumb but pretty client** — all reasoning lives in the orchestrator. Transport is a single `URLSessionWebSocketTask` to `ws://127.0.0.1:7777`.

### 2. Orchestrator daemon (Node/TS, `orchestrator/`)
The brain. Responsibilities:
- **Lifecycle supervisor** — ensures `llama-server` (:8080) and the router (:9090) are healthy before accepting work (shared scripts in `scripts/`).
- **Agent registry** — named agents, each a Claude Agent SDK session launched with `ANTHROPIC_BASE_URL=http://127.0.0.1:9090` so it inherits hybrid routing automatically.
- **Intent dispatcher** — classifies an incoming command and picks an agent. Classification itself runs on **local Qwen** (fast, free). Images force a vision-capable hybrid agent.
- **Memory + personality** — every prompt's system message is built from `personality/*.md` + retrieved long-term memory + the short-term buffer (see [MEMORY.md](MEMORY.md)). Turns are persisted and curated (2B capture + cloud consolidation).
- **WebSocket API** — streams `status` / `text` / `tool` / `done` / `error` / `ignored` / `session` / `cancelled` / `project` events; accepts `prompt` (with optional `triage`, `honorific`, `image`, `nowPlaying`), `health`, `agents`, `models`, `swap`, `cancel`, `session_open`/`session_close`.
- **Conversation sessions** — "Hey Jarvis" opens a persisted [session](../orchestrator/src/session.js); "goodbye" closes it (consolidate + clear). Additive over the short-term buffer (see [AGENTS.md](AGENTS.md#conversation-sessions)).
- **Tiered models** — user-facing **conversation** runs on Gemma 3 4B (`:8083`); cheap **internal** classification stays on the 2B (`:8081`); tool-using **hybrid** agents route cloud→local via the router. The **PM pipeline** runs local coder tasks + a cloud reviewer (see [AGENTS.md](AGENTS.md#pm-pipeline)).

### 3. App-side context & audio (`app/`)
- **Screen** ([ScreenContext.swift](../app/Jarvis/Context/ScreenContext.swift)) — ScreenCaptureKit screenshot → vision agent.
- **Now-playing** ([NowPlaying.swift](../app/Jarvis/Context/NowPlaying.swift)) + **music dim** ([AudioDucker.swift](../app/Jarvis/Voice/AudioDucker.swift)) — Apple Events to Spotify/Apple Music.
- **Form of address** ([VoiceGender.swift](../app/Jarvis/Voice/VoiceGender.swift)) — on-device pitch → Sir/Ma'am.

> **App Sandbox is intentionally OFF** (personal, self-signed app) so it can send Apple Events (music) and capture the screen. macOS TCC still gates Microphone, Speech, Automation, and Screen Recording via permission prompts.

## Data flow (one voice command)

1. User says "Hey Jarvis, summarize the changes in this repo."
2. App wakes on the keyword, transcribes the utterance on-device (`SpeechAnalyzer`).
3. App sends `{type:"prompt", text}` over the WebSocket.
4. Orchestrator dispatches → `dev` agent (a Claude Agent SDK session in the repo).
5. The session's main model is cloud Sonnet (via router); any subagents it spawns run on local Qwen (via router) — automatically.
6. Tokens stream back as `text` events; the app renders the transcript and speaks a summary via TTS.

## Concurrency model (18 GB reality)

- **Cloud agents** (Sonnet sessions) can run in parallel — they're remote.
- **Local agents** (Qwen) **serialize** on the single `llama-server` (`-np 1`). "Many agents" means many *sessions*, but local inference is one-at-a-time — **except** the PM pipeline's coder tier, which runs `--parallel 2 -cb` (continuous batching, one model in memory) so a few coder tasks fan out concurrently. Even then, decode is memory-bandwidth bound, so concurrency buys *pipelining* (a local coder ‖ the remote cloud reviewer/PM), not linear speedup.
- **Specialized local models** are **hot-swapped**, not co-resident — the orchestrator restarts `llama-server` with a different GGUF when an agent needs it (load-time cost, documented in [MODELS.md](MODELS.md)). The dedicated coder model swaps onto `:8080` for a project, then `restore9B()` hands the slot back.

## Ports

| Port | Service | Owner |
|------|---------|-------|
| 8080 | llama.cpp `llama-server` | existing |
| 9090 | router proxy `proxy.py` | existing |
| 8081 | llama.cpp 2B "quick" tier (internal classifiers) | new |
| 8083 | llama.cpp Gemma 3 4B conversation tier | new |
| 8082 | Kokoro/Piper TTS server | new |
| 7777 | Jarvis orchestrator WebSocket | new |
</content>
