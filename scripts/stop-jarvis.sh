#!/usr/bin/env bash
# Stop the whole Jarvis stack: app + orchestrator + model/voice servers.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[stop] quitting Jarvis.app"
osascript -e 'tell application "Jarvis" to quit' 2>/dev/null || killall Jarvis 2>/dev/null || true

echo "[stop] llama.cpp + router (via pid files)"
bash "$ROOT/scripts/hybrid-down.sh" 2>/dev/null || true

echo "[stop] Jarvis-owned services (2B, TTS, orchestrator)"
bash "$ROOT/scripts/stop-backend.sh" 2>/dev/null || true

echo "[stop] done"
