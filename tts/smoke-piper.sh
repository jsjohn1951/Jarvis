#!/usr/bin/env bash
# Contract smoke test for the Piper TTS server. Starts it on a throwaway port,
# checks /health, synthesizes one sentence, and asserts the body is a real WAV.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="$HERE/.venv-piper/bin/python"
PORT="${SMOKE_PORT:-8099}"
OUT="/tmp/jarvis_piper_smoke.wav"

[[ -x "$PY" ]] || { echo "FAIL: $PY not found (run Task 1 setup)"; exit 1; }

PIPER_PORT="$PORT" "$PY" "$HERE/piper_server.py" >/tmp/jarvis_piper_smoke.log 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT

# Wait up to 60s for health (first start loads the model + warms up).
for _ in $(seq 1 60); do
  kill -0 "$SRV" 2>/dev/null || { echo "FAIL: server exited early"; cat /tmp/jarvis_piper_smoke.log; exit 1; }
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "FAIL: /health never came up"; cat /tmp/jarvis_piper_smoke.log; exit 1; }

code=$(curl -s -o "$OUT" -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/v1/audio/speech" \
  -H "content-type: application/json" -d '{"input":"All systems online."}')
[[ "$code" == "200" ]] || { echo "FAIL: POST returned HTTP $code"; exit 1; }
[[ -s "$OUT" ]] || { echo "FAIL: empty response body"; exit 1; }
[[ "$(head -c 4 "$OUT")" == "RIFF" ]] || { echo "FAIL: not a RIFF/WAV file"; exit 1; }
[[ "$(dd if="$OUT" bs=1 skip=8 count=4 2>/dev/null)" == "WAVE" ]] || { echo "FAIL: missing WAVE magic"; exit 1; }

echo "piper-smoke: OK ($(wc -c < "$OUT" | tr -d ' ') bytes)"
