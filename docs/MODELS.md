# Models — speed work & selection

Goal: make local source-code work feel faster **without losing quality** vs. the current `Qwen3.5-9B-Q4_K_M`. Everything below was **measured on the target machine** (M3 Pro, 18 GB, llama.cpp b9559, Metal), not assumed.

## TL;DR

- The 9B's slowness is **memory-bandwidth bound** on Apple Silicon. Speculative decoding and batch tuning gave **~0% gain** here.
- The real win is **tiering**: serve a **Qwen3.5-2B** alongside the 9B and route easy work to it — **3.3× faster generation**, coherent answers, and it **co-resides** with the 9B inside the GPU budget (no hot-swap).
- Speculative decoding is kept (lossless, occasionally helps on repetitive output) but **defaults off**.

## Hardware ceiling

`llama-bench` reports `recommendedMaxWorkingSetSize = 14302 MB` — the **GPU working-set budget is ~14.3 GB**, not the full 18 GB. That's the true ceiling for weights + KV cache.

## Benchmarks (measured)

| Config | prompt-proc | token-gen | Output identical? |
|--------|------------:|----------:|:-----------------:|
| 9B baseline (`-c 32768`, fa, q4 KV) | ~253 t/s | **21.5 t/s** | — |
| 9B + 2B speculative draft | ~253 t/s | 21.2 t/s | ✅ identical |
| 9B + n-gram speculation | ~253 t/s | 18.9 t/s (slower) | ✅ identical |
| 9B ubatch 512 / 1024 / 2048 | all ~253 t/s | — | — |
| **2B standalone (quick tier)** | **1160 t/s** | **72.1 t/s** | n/a |

All speculative runs produced **byte-identical** output (same SHA) to baseline — confirming speculative decoding preserves quality exactly. It just doesn't help *speed* on this chip, because the co-resident draft competes for the same memory bandwidth that bounds the 9B.

**Co-residence verified:** 9B (:8080) + 2B (:8081) ran simultaneously, both healthy, ~10 GB resident (57% of 18 GB), 2B answering at ~62 t/s under load.

## What we actually do

### 1. Tiered serving (the win)
- **9B on `:8080`** — hard reasoning / real dev work, reached via the existing router. → [`scripts/llama-server-optimized.sh`](../scripts/llama-server-optimized.sh)
- **2B on `:8081`** — the "quick" tier: instant factual/system answers, simple edits. → [`scripts/llama-quick.sh`](../scripts/llama-quick.sh)
- The orchestrator's **dispatcher** routes each command to the right tier (Phase 3). Easy → 2B (feels instant), hard → 9B (or cloud Sonnet).

### 2. Context 70k → 32k
Smaller KV cache frees RAM and trims prompt-processing of the cache. Most code-analysis tasks don't need 70k; raise per-task when needed.

### 3. Prompt caching
The server's `cache_prompt` (on by default) reuses KV across requests — large speedup for **iterative re-analysis of the same files**. The bench disables it for fair measurement; production leaves it on.

### 4. Speculative decoding — available, off by default
`JARVIS_SPEC=draft ./scripts/llama-server-optimized.sh` enables the 2B-draft path (lossless). Try it for highly repetitive generation; expect little gain on this hardware. Flags verified for b9559: `-md/--spec-draft-model`, `-ngld`, `--spec-draft-n-max/-n-min`, `--spec-draft-p-min` (the old `--draft-max/--draft-min` were removed). N-gram mode: `JARVIS_SPEC=ngram` (`--spec-type ngram-cache`, no draft, vocab-agnostic).

## The draft / quick model

`unsloth/Qwen3.5-2B-GGUF:Q4_K_M` (1.18 GB). Verified **vocab-compatible** with the 9B: both are `qwen35` architecture, gpt2 tokenizer, **vocab 248,320** (a stock Qwen2.5/Qwen3 0.5B would be incompatible — different vocab). A smaller 0.8B draft would be punchier but no GGUF is published yet. Pull with [`models/pull-models.sh`](../models/pull-models.sh).

## Specialized models — hot-swap (implemented)
Anything larger than the 2B can't co-reside with the 9B under 14.3 GB, so additional specialists are **hot-swapped** on the `:8080` slot. This is wired end-to-end:
- Drop a GGUF in `~/models` (see [`models/pull-models.sh`](../models/pull-models.sh)).
- In the app's **Agent Registry** window → *Local Models* → **LOAD**, or send `{ "type": "swap", "model": "Foo.gguf" }` over the WebSocket.
- The orchestrator runs [`scripts/llama-swap.sh`](../scripts/llama-swap.sh), which restarts `llama-server` with the new GGUF on `:8080`.

Trade-off: the swap restarts the 9B slot, so it **interrupts in-flight local-subagent work for ~model-load time**, and the router routes local subagent calls to whatever GGUF is currently loaded there. The 2B quick tier (`:8081`) is unaffected.

### Google Gemma 3 4B — the conversation tier (`:8083`, always-on)
`models/pull-models.sh` pulls **`gemma-3-4b-it-Q4_K_M.gguf`** (~3 GB). It now serves the
**default conversation tier** — a dedicated always-on `llama-server` on **`:8083`**
([scripts/llama-convo.sh](../scripts/llama-convo.sh), started by `start-jarvis.sh`), used for
**user-facing dialog**: the instant ack, greetings, smalltalk, and local factual answers
([convo.ts](../orchestrator/src/convo.ts), `config.convoUrl`/`convoModel`). The cheaper 2B
(`:8081`) stays reserved for **internal** classifiers (dispatch routing, addressee triage, memory
retrieve/capture, completion self-check) — so the capable-but-slower conversation model never
blocks the fast routing path. If `:8083` is down, conversation degrades to the 2B. Tool use on
Gemma is **best-effort** (the router's Qwen3 `<tool_call>` bridge isn't Gemma-native) — fine, since
conversation doesn't call tools. Memory budget: 2B (~2 GB) + Gemma (~3 GB) always-on, leaving the
`:8080` slot for the 9B / a hot-swapped specialist.

### Qwen2.5-Coder-7B — the local coder model (`:8080` hot-swap, `-np 2`)
`models/pull-models.sh` pulls **`qwen2.5-coder-7b-instruct-q4_k_m.gguf`** (~4.7 GB,
`config.coderModel`). The PM pipeline hot-swaps it onto `:8080` (displacing the 9B) for a coding
project, served with **continuous batching** (`--parallel 2 -cb`, via `LLAMA_PARALLEL` →
[llama-server-optimized.sh](../scripts/llama-server-optimized.sh)) so coder tasks fan out
concurrently against the one model. `ensureCoderLoaded()`/`restore9B()`
([models.ts](../orchestrator/src/models.ts)) manage the slot; the 9B is restored when the project
ends. Implementation runs **locally** on this model (sparing the cloud session); PM reasoning and
review prefer the cloud with a local fallback. See [AGENTS.md](AGENTS.md#pm-pipeline).

### Other specialists (selectable)
Any other GGUF in `~/models` auto-appears in the Registry's *Local Models* list and is
hot-swappable via **LOAD** (or `{ "type": "swap", "model": "Foo.gguf" }`). Qwen3.5-9B stays the
wired auto-fallback for tool-using agents.

## Resilient fallback chain — Claude → Ollama Cloud → local

Hybrid agents try providers in order and degrade gracefully so a Claude rate-limit never shows a
raw error ([runner.ts](../orchestrator/src/runner.ts) `runHybrid` + `buildChain`):

1. **Claude** (cloud Sonnet via the router → Pro subscription).
2. **Ollama Cloud** — *only if configured* (the app's **Settings** ▸ gear: enable + model +
   API key). Inserted between Claude and local; keeps tool use.
3. **Local GGUF** (`Qwen3.5-9B`, or whatever is loaded on `:8080`).

An `isClaudeUnavailable` error (capacity/rate-limit/transient — [fallback.ts](../orchestrator/src/fallback.ts))
advances to the next provider and trips the circuit breaker; a `reset` event discards any partial
output so the HUD/TTS only reflect the provider that completes. If a side-effecting tool already
ran this turn, Jarvis stops instead of repeating it. If the whole chain is unavailable, it speaks a
calm "try again shortly" line — never the raw API error.

### Ollama Cloud wiring (router-level)
The app stores the key in the Keychain and pushes `{provider_config}` over the WebSocket; the
orchestrator writes `~/.claude/router/providers.json` (0600), which the **router** reads lazily
(mtime-cached) to route the configured model to Ollama Cloud's OpenAI-compatible endpoint
(`https://ollama.com/v1`) with `Authorization: Bearer <key>`, reusing the same Anthropic↔OpenAI +
`<tool_call>` translation as the local path. The router additions are mirrored in
[scripts/router-ollama.patch](../scripts/router-ollama.patch) for reproducibility
(`patch ~/.claude/router/proxy.py < scripts/router-ollama.patch`); restart the router afterward
(`scripts/hybrid-down.sh && scripts/hybrid-up.sh`).
