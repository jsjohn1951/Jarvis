#!/usr/bin/env bash
# Stop the whole Jarvis stack: app + orchestrator + model/voice servers.
#   --keep-app   leave Jarvis.app running (used by the HUD's STACK toggle, which
#                would otherwise kill the app it was clicked from)
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--keep-app" ]]; then
  echo "[stop] leaving Jarvis.app running (--keep-app)"
else
  echo "[stop] quitting Jarvis.app"
  osascript -e 'tell application "Jarvis" to quit' 2>/dev/null || killall Jarvis 2>/dev/null || true
fi

echo "[stop] llama.cpp + router (via pid files)"
bash "$ROOT/scripts/hybrid-down.sh" 2>/dev/null || true

echo "[stop] Jarvis-owned services (2B, TTS, orchestrator)"
bash "$ROOT/scripts/stop-backend.sh" 2>/dev/null || true

echo "[stop] done"
