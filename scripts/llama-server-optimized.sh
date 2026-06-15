#!/usr/bin/env bash
# Jarvis — optimized llama.cpp launcher
#
# Faster local inference for the SAME Qwen3.5-9B, without losing quality, via
# speculative decoding. Two modes (set JARVIS_SPEC):
#
#   draft  (default) : Qwen3.5-2B verifies-by-9B speculative decoding.
#                      Lossless vs. the 9B's greedy output; ~zero quality change.
#   ngram            : draft-free n-gram speculation. No extra model, ~zero extra
#                      RAM, strong on repetitive source code. Vocab-agnostic.
#   off              : plain 9B (baseline, for benchmarking).
#
# Verified against llama.cpp build b9559 (flags renamed: --spec-draft-n-max, etc).
# Serves an OpenAI-compatible API on :8080 — drop-in for the existing router.
set -euo pipefail

LLAMA_BIN="${LLAMA_BIN:-$HOME/llama.cpp/build/bin/llama-server}"
MODEL="${MODEL:-$HOME/models/Qwen3.5-9B-Q4_K_M.gguf}"
DRAFT="${DRAFT:-$HOME/models/Qwen3.5-2B-Q4_K_M.gguf}"   # vocab 248320, matches 9B
DRAFT_HF="${DRAFT_HF:-unsloth/Qwen3.5-2B-GGUF:Q4_K_M}"  # fallback: auto-fetch
PORT="${PORT:-8080}"
CTX="${CTX:-32768}"            # 70k→32k: smaller KV cache, faster prompt processing
# Default OFF: benchmarked on M3 Pro, speculative decoding gives ~0% gen speedup
# here (token-gen is memory-bandwidth bound; the draft competes for it). It stays
# available — lossless, and helps on highly repetitive output — but isn't the win.
# The real speedup is the 2B 'quick' tier (scripts/llama-quick.sh). See docs/MODELS.md.
SPEC="${JARVIS_SPEC:-off}"

common=(
  -m "$MODEL"
  -ngl 99 -fa on
  --cache-type-k q4_0 --cache-type-v q4_0
  -c "$CTX" --host 127.0.0.1 --port "$PORT"
)

case "$SPEC" in
  draft)
    if [[ -f "$DRAFT" ]]; then draft_arg=(-md "$DRAFT"); else
      echo "[jarvis] local draft not found; auto-fetching $DRAFT_HF"; draft_arg=(-hfd "$DRAFT_HF"); fi
    echo "[jarvis] mode=draft  target=9B  draft=2B  ctx=$CTX"
    exec "$LLAMA_BIN" "${common[@]}" "${draft_arg[@]}" \
      -ngld 99 \
      --spec-draft-n-max 16 --spec-draft-n-min 2 --spec-draft-p-min 0.4
    ;;
  ngram)
    echo "[jarvis] mode=ngram  target=9B  (no draft model)  ctx=$CTX"
    exec "$LLAMA_BIN" "${common[@]}" \
      --spec-type ngram-cache --spec-draft-n-max 16 --spec-draft-n-min 1
    ;;
  off)
    echo "[jarvis] mode=off  baseline 9B  ctx=$CTX"
    exec "$LLAMA_BIN" "${common[@]}"
    ;;
  *) echo "[jarvis] unknown JARVIS_SPEC=$SPEC (use draft|ngram|off)" >&2; exit 1 ;;
esac
