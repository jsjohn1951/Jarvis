#!/usr/bin/env bash
# Bring up the full Jarvis stack, then leave the orchestrator in the foreground.
#   1. hybrid backend  : llama 9B (:8080) + router (:9090)   [shared with claude-hybrid]
#   2. quick tier      : llama 2B (:8081)                     [fast local answers]
#   3. orchestrator    : WebSocket (:7777)                    [the brain]
# Then launch Jarvis.app (menu bar) yourself, or it auto-connects if already open.
#
# Auth note: hybrid agents use your Claude Pro subscription via the router — make
# sure you're logged in (`claude` → /login) and ANTHROPIC_API_KEY is NOT set.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/3] hybrid backend (9B + router)…"
bash "$ROOT/scripts/hybrid-up.sh"

echo "[2/4] quick tier (2B :8081)…"
if ! lsof -i :8081 -sTCP:LISTEN -t >/dev/null 2>&1; then
  PORT=8081 "$ROOT/scripts/llama-quick.sh" >/tmp/jarvis_quick.log 2>&1 &
  until curl -sf http://127.0.0.1:8081/health >/dev/null 2>&1; do sleep 1; done
  echo "      ready"
else
  echo "      already running"
fi

echo "[3/4] Kokoro voice (:8082)…"
if [[ -x "$ROOT/tts/.venv/bin/python" ]]; then
  if ! lsof -i :8082 -sTCP:LISTEN -t >/dev/null 2>&1; then
    "$ROOT/tts/.venv/bin/python" "$ROOT/tts/server.py" >/tmp/jarvis_tts.log 2>&1 &
    until curl -sf http://127.0.0.1:8082/health >/dev/null 2>&1; do sleep 1; done
    echo "      ready (natural Jarvis voice)"
  else
    echo "      already running"
  fi
else
  echo "      skipped — venv not set up (app falls back to AVSpeech). See docs/VOICE.md"
fi

# Build the app if it isn't built yet, then open it.
APP="$ROOT/app/DerivedData/Build/Products/Debug/Jarvis.app"
if [[ -d "$APP" ]]; then
  echo "[app] opening Jarvis.app"
  open "$APP" || true
else
  echo "[app] not built — run: cd app && xcodegen generate && xcodebuild -scheme Jarvis build"
fi

echo "[4/4] orchestrator (:7777) — Ctrl-C to stop"
cd "$ROOT/orchestrator"
exec npm start
