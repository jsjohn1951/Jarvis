#!/usr/bin/env bash
# Jarvis 'quick' tier — Qwen3.5-2B served on :8081 for instant local answers.
# Benchmarked at 72 tok/s gen (3.3x the 9B) and 1160 tok/s prompt processing.
# At 1.18 GB it co-resides with the 9B (:8080) inside the ~14.3 GB GPU budget,
# so no hot-swap is needed. The orchestrator's 'quick' agent calls this directly.
set -euo pipefail
LLAMA_BIN="${LLAMA_BIN:-$HOME/llama.cpp/build/bin/llama-server}"
MODEL="${MODEL:-$HOME/models/Qwen3.5-2B-Q4_K_M.gguf}"
PORT="${PORT:-8081}"
CTX="${CTX:-16384}"   # quick tasks are short; small ctx keeps it light
exec "$LLAMA_BIN" -m "$MODEL" -ngl 99 -fa on \
  --cache-type-k q4_0 --cache-type-v q4_0 \
  -c "$CTX" --host 127.0.0.1 --port "$PORT"
