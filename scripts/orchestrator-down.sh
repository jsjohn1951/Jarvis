#!/usr/bin/env bash
# Stop the orchestrator daemon alone — the :7777 slice of stop-backend.sh.
# Port-based kill is the source of truth (catches the real listener regardless of
# the npm→tsx wrapper).
set -uo pipefail

pids=$(lsof -i :7777 -sTCP:LISTEN -t 2>/dev/null || true)
if [[ -n "$pids" ]]; then
  echo "[orchestrator-down] stopping :7777 → $pids"
  echo "$pids" | xargs kill 2>/dev/null || true
else
  echo "[orchestrator-down] nothing listening on :7777"
fi
rm -f /tmp/jarvis_orchestrator.pid 2>/dev/null || true
echo "[orchestrator-down] done"
