#!/usr/bin/env bash
# Stop services started by hybrid-up.sh. Only kills what we started (by PID file).
set -uo pipefail

for svc in claude_router llama_server; do
  pidfile="/tmp/${svc}.pid"
  if [[ -f "$pidfile" ]]; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[hybrid-down] stopping $svc ($pid)"; kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
done
echo "[hybrid-down] done"
