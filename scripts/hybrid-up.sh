#!/usr/bin/env bash
# Bring up the hybrid backend Jarvis depends on: llama.cpp (:8080) + router (:9090).
# Idempotent — if a service is already listening, it's left alone. This mirrors the
# claude-hybrid zsh function so the orchestrator and the shell share one source of truth.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LLAMA_PORT="${LLAMA_PORT:-8080}"
ROUTER_PORT="${ROUTER_PORT:-9090}"
LLAMA_LOG="${LLAMA_LOG:-/tmp/llama_server.log}"
LLAMA_PID_FILE="/tmp/llama_server.pid"
ROUTER_PID_FILE="/tmp/claude_router.pid"

listening() { lsof -i ":$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

# ── llama.cpp (optimized: speculative decoding) ───────────────────────────────
if ! listening "$LLAMA_PORT"; then
  echo "[hybrid-up] starting llama.cpp on :$LLAMA_PORT (optimized)"
  PORT="$LLAMA_PORT" "$SCRIPT_DIR/llama-server-optimized.sh" >"$LLAMA_LOG" 2>&1 &
  echo $! >"$LLAMA_PID_FILE"
  printf '[hybrid-up] loading model'
  t=0
  until curl -sf "http://127.0.0.1:$LLAMA_PORT/health" >/dev/null 2>&1; do
    printf '.'; sleep 2; t=$((t+2))
    if (( t >= 180 )); then
      echo " TIMEOUT — see $LLAMA_LOG"; kill "$(cat "$LLAMA_PID_FILE" 2>/dev/null)" 2>/dev/null || true
      rm -f "$LLAMA_PID_FILE"; exit 1
    fi
  done
  echo " ready"
else
  echo "[hybrid-up] llama.cpp already on :$LLAMA_PORT"
fi

# ── router proxy ──────────────────────────────────────────────────────────────
if ! listening "$ROUTER_PORT"; then
  echo "[hybrid-up] starting router on :$ROUTER_PORT"
  "$HOME/.claude/router/.venv/bin/python" "$HOME/.claude/router/proxy.py" \
    >"${ROUTER_PID_FILE}.log" 2>&1 &
  echo $! >"$ROUTER_PID_FILE"
  sleep 1
  listening "$ROUTER_PORT" || { echo "[hybrid-up] router failed — see ${ROUTER_PID_FILE}.log"; exit 1; }
else
  echo "[hybrid-up] router already on :$ROUTER_PORT"
fi

echo "[hybrid-up] backend ready (llama :$LLAMA_PORT, router :$ROUTER_PORT)"
