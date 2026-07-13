#!/usr/bin/env bash
# Start the orchestrator daemon (:7777) alone. Idempotent. Factored out of
# start-jarvis.sh so the HUD's service toggle and the terminal share one invocation.
#   JARVIS_ORCH_LOG   log destination (default /dev/null)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if lsof -i :7777 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "[orchestrator-up] already running on :7777"
  exit 0
fi

# When spawned from Jarvis.app the GUI PATH has no node/npm — find one (nvm, brew).
if ! command -v npm >/dev/null 2>&1; then
  for d in "$HOME/.nvm/versions/node"/*/bin /opt/homebrew/bin /usr/local/bin; do
    [[ -x "$d/npm" ]] && { export PATH="$d:$PATH"; break; }
  done
fi
command -v npm >/dev/null 2>&1 || { echo "[orchestrator-up] npm not found" >&2; exit 1; }

cd "$ROOT/orchestrator"
LOG_DEST="${JARVIS_ORCH_LOG:-/dev/null}"
nohup npm start >"$LOG_DEST" 2>&1 &
echo $! > /tmp/jarvis_orchestrator.pid

t=0
until lsof -i :7777 -sTCP:LISTEN -t >/dev/null 2>&1; do
  sleep 1; t=$((t+1))
  if (( t >= 60 )); then echo "[orchestrator-up] TIMEOUT waiting for :7777" >&2; exit 1; fi
done
echo "[orchestrator-up] ready (pid $(cat /tmp/jarvis_orchestrator.pid))"
