#!/usr/bin/env bash
# Hot-swap the model on :8080 (the 9B slot the router + local subagents use).
# Stops the current server and starts llama-server-optimized.sh with a new GGUF.
# Interrupts in-flight local work for ~model-load time. See docs/MODELS.md.
set -euo pipefail
MODEL_FILE="${1:?usage: llama-swap.sh <model.gguf>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${MODELS_DIR:-$HOME/models}"

[[ -f "$MODELS_DIR/$MODEL_FILE" ]] || { echo "[swap] not found: $MODELS_DIR/$MODEL_FILE" >&2; exit 1; }

echo "[swap] stopping current :8080 server"
lsof -i :8080 -sTCP:LISTEN -t 2>/dev/null | xargs kill 2>/dev/null || true
rm -f /tmp/llama_server.pid
sleep 1

echo "[swap] loading $MODEL_FILE on :8080${LLAMA_PARALLEL:+ (parallel=$LLAMA_PARALLEL)}"
MODEL="$MODELS_DIR/$MODEL_FILE" JARVIS_SPEC=off PORT=8080 LLAMA_PARALLEL="${LLAMA_PARALLEL:-1}" \
  "$ROOT/scripts/llama-server-optimized.sh" >/tmp/llama_server.log 2>&1 &
echo $! >/tmp/llama_server.pid

printf "[swap] loading"
t=0
until curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1; do
  printf '.'; sleep 2; t=$((t+2))
  [[ $t -ge 180 ]] && { echo " TIMEOUT — see /tmp/llama_server.log"; exit 1; }
done
echo " ready ($MODEL_FILE)"
