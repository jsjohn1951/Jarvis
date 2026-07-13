#!/usr/bin/env bash
# Stop services started by hybrid-up.sh. Only kills what we started (by PID file).
#   --router-only   stop just the router proxy, leave llama.cpp up
set -uo pipefail

svcs=(claude_router llama_server)
[[ "${1:-}" == "--router-only" ]] && svcs=(claude_router)

for svc in "${svcs[@]}"; do
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
