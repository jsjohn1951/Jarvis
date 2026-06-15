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
