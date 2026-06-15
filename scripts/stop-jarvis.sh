#!/usr/bin/env bash
# Stop the whole Jarvis stack: app + orchestrator + model/voice servers.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[stop] quitting Jarvis.app"
osascript -e 'tell application "Jarvis" to quit' 2>/dev/null || killall Jarvis 2>/dev/null || true

echo "[stop] llama.cpp + router (via pid files)"
bash "$ROOT/scripts/hybrid-down.sh" 2>/dev/null || true

echo "[stop] remaining services (2B, Kokoro, orchestrator)"
for port in 8081 8082 7777; do
  pids=$(lsof -i ":$port" -sTCP:LISTEN -t 2>/dev/null || true)
  [[ -n "$pids" ]] && { echo "  :$port → $pids"; echo "$pids" | xargs kill 2>/dev/null || true; }
done

echo "[stop] done"
