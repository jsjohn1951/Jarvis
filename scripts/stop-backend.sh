#!/usr/bin/env bash
# Stop Jarvis-owned services only: orchestrator (:7777), 2B quick (:8081), Gemma convo
# (:8083), TTS (:8082).
# Leaves the shared hybrid 9B + router (:8080/:9090) up — claude-hybrid still needs them.
# Port-based kill is the source of truth: it catches the real listener regardless of the
# npm→tsx wrapper around the orchestrator. Invoked by the ⏻ power-off path and reusable
# standalone.
set -uo pipefail

echo "[stop-backend] Jarvis-owned services (orchestrator, 2B, Gemma convo, TTS)"
for port in 8081 8083 8082 7777; do
  pids=$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)
  [[ -n "$pids" ]] && { echo "  :$port → $pids"; echo "$pids" | xargs kill 2>/dev/null || true; }
done
rm -f /tmp/jarvis_orchestrator.pid 2>/dev/null || true
echo "[stop-backend] done"
