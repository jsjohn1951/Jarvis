#!/usr/bin/env bash
# Bring up the full Jarvis stack. The orchestrator runs as a background daemon, so
# this script returns your terminal once everything is up (stop it with the ⏻ button
# in the HUD or scripts/stop-jarvis.sh).
#   1. hybrid backend  : llama 9B (:8080) + router (:9090)   [shared with claude-hybrid]
#   2. quick tier      : llama 2B (:8081)                     [fast local answers]
#   3. orchestrator    : WebSocket (:7777)                    [the brain, daemonized]
# Then launch Jarvis.app (menu bar) yourself, or it auto-connects if already open.
#
# Flags:
#   --logs   capture orchestrator output to /tmp/jarvis_orchestrator.log
#            (default: suppressed — the daemon writes to /dev/null)
#
# Auth note: hybrid agents use your Claude Pro subscription via the router — make
# sure you're logged in (`claude` → /login) and ANTHROPIC_API_KEY is NOT set.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

LOGS=0
for arg in "$@"; do
  case "$arg" in
    --logs) LOGS=1 ;;
    *) echo "unknown flag: $arg (supported: --logs)" >&2; exit 2 ;;
  esac
done

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

echo "[2b/4] conversation tier (Gemma 3 4B :8083)…"
if [[ -f "$HOME/models/gemma-3-4b-it-Q4_K_M.gguf" ]]; then
  if ! lsof -i :8083 -sTCP:LISTEN -t >/dev/null 2>&1; then
    PORT=8083 "$ROOT/scripts/llama-convo.sh" >/tmp/jarvis_convo.log 2>&1 &
    until curl -sf http://127.0.0.1:8083/health >/dev/null 2>&1; do sleep 1; done
    echo "      ready"
  else
    echo "      already running"
  fi
else
  echo "      skipped — gemma-3-4b-it-Q4_K_M.gguf not in ~/models (conversation falls back to the 2B). Run models/pull-models.sh"
fi

# TTS engine is selectable: piper (default, en_GB-alan) or kokoro (bm_george).
TTS_ENGINE="${JARVIS_TTS_ENGINE:-piper}"
if [[ "$TTS_ENGINE" == "kokoro" ]]; then
  TTS_PY="$ROOT/tts/.venv/bin/python";       TTS_SCRIPT="$ROOT/tts/server.py";        TTS_LABEL="Kokoro voice (bm_george)"
else
  TTS_PY="$ROOT/tts/.venv-piper/bin/python"; TTS_SCRIPT="$ROOT/tts/piper_server.py";  TTS_LABEL="Piper voice (en_GB-alan)"
fi
echo "[3/4] $TTS_LABEL (:8082)…"
if [[ -x "$TTS_PY" ]]; then
  if ! lsof -i :8082 -sTCP:LISTEN -t >/dev/null 2>&1; then
    "$TTS_PY" "$TTS_SCRIPT" >/tmp/jarvis_tts.log 2>&1 &
    until curl -sf http://127.0.0.1:8082/health >/dev/null 2>&1; do sleep 1; done
    echo "      ready"
  else
    # Something already holds :8082. If it's the OTHER engine, the switch would
    # silently no-op (wrong voice), so warn instead of claiming success.
    RUNNING_ENGINE="$(curl -sf http://127.0.0.1:8082/health | sed -n 's/.*"engine":"\([a-z]*\)".*/\1/p')"
    if [[ -n "$RUNNING_ENGINE" && "$RUNNING_ENGINE" != "$TTS_ENGINE" ]]; then
      echo "      ⚠️  $RUNNING_ENGINE is already on :8082 — run scripts/stop-jarvis.sh first to switch to $TTS_ENGINE"
    else
      echo "      already running"
    fi
  fi
else
  echo "      skipped — $TTS_ENGINE venv not set up (app falls back to AVSpeech). See docs/VOICE.md"
fi

# Build the app if it isn't built yet, then open it.
APP="$ROOT/app/DerivedData/Build/Products/Debug/Jarvis.app"
if [[ -d "$APP" ]]; then
  echo "[app] opening Jarvis.app"
  open "$APP" || true
else
  echo "[app] not built — run: cd app && xcodegen generate && xcodebuild -scheme Jarvis build"
fi

# Mobile exposure (set by scripts/ios-package.sh): JARVIS_WS_HOST / PIPER_HOST /
# KOKORO_HOST / PIPER_TOKEN simply inherit into the TTS server and orchestrator
# daemons launched below — nothing to plumb, just surface it.
if [[ -n "${JARVIS_WS_HOST:-}" && "${JARVIS_WS_HOST}" != "127.0.0.1" ]]; then
  echo "[mobile] orchestrator binding ${JARVIS_WS_HOST} — remote clients must present ~/.jarvis/mobile-token"
fi

echo "[4/4] orchestrator (:7777) — starting as daemon"
cd "$ROOT/orchestrator"
LOG_DEST=/dev/null
[[ "$LOGS" == 1 ]] && LOG_DEST=/tmp/jarvis_orchestrator.log
nohup npm start >"$LOG_DEST" 2>&1 &
echo $! > /tmp/jarvis_orchestrator.pid
until lsof -i :7777 -sTCP:LISTEN -t >/dev/null 2>&1; do sleep 1; done
echo "      ready — orchestrator running in background (pid $(cat /tmp/jarvis_orchestrator.pid))"
if [[ "$LOGS" == 1 ]]; then
  echo "      logs → /tmp/jarvis_orchestrator.log"
else
  echo "      logs suppressed (re-run with --logs to capture)"
fi
echo "[done] stop with the ⏻ button in the HUD or scripts/stop-jarvis.sh"
