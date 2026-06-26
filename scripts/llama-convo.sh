#!/usr/bin/env bash
# Conversation tier — Gemma 3 4B served directly (OpenAI-compatible) on :8083. This is
# the USER-FACING dialog model (greetings, smalltalk, the instant ack, local factual
# answers); the cheaper 2B 'quick' tier (llama-quick.sh, :8081) stays for internal
# classifiers. Modeled on llama-quick.sh — small ctx keeps it light alongside the 9B.
set -euo pipefail
LLAMA_BIN="${LLAMA_BIN:-$HOME/llama.cpp/build/bin/llama-server}"
MODEL="${MODEL:-$HOME/models/gemma-3-4b-it-Q4_K_M.gguf}"
PORT="${PORT:-8083}"
CTX="${CTX:-16384}"
exec "$LLAMA_BIN" -m "$MODEL" -ngl 99 -fa on \
  --cache-type-k q4_0 --cache-type-v q4_0 \
  -c "$CTX" --host 127.0.0.1 --port "$PORT"
