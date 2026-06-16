# Piper (Alan) Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the British-male `en_GB-alan-medium` Piper voice Jarvis's default TTS, served behind the existing OpenAI-compatible `/v1/audio/speech` on `:8082`, with Kokoro reachable via `JARVIS_TTS_ENGINE=kokoro` and zero app changes.

**Architecture:** A new `tts/piper_server.py` mirrors the existing `tts/server.py` contract (FastAPI, `/health` + `POST /v1/audio/speech` → WAV) but synthesizes with Piper. It runs in its own `tts/.venv-piper` to keep piper's bundled onnxruntime away from `kokoro-onnx`'s. The launcher picks the engine by env var. The app is untouched because it only POSTs `{"input": text}` and plays the returned WAV.

**Tech Stack:** Python 3.12, FastAPI, `piper-tts` 1.4.2 (OHF-Voice `piper1-gpl`, native macOS arm64 wheel, bundles espeak-ng), stdlib `wave`. Bash launcher. Voice from `rhasspy/piper-voices`.

---

## Verified facts this plan depends on

- The app ([app/Jarvis/Voice/KokoroTTSService.swift:64](../../../app/Jarvis/Voice/KokoroTTSService.swift)) POSTs only `{"input": text}` to `:8082/v1/audio/speech` and plays the WAV; no voice name, nothing Kokoro-specific → drop-in, no app changes.
- `piper-tts` 1.4.2 has a `macosx_11_0_arm64` abi3 wheel (CPython 3.9+); `pip install piper-tts` works natively. The wheel bundles espeak-ng.
- API: `from piper import PiperVoice`; `PiperVoice.load("x.onnx")` auto-detects the sibling `x.onnx.json`; `voice.synthesize(text)` yields chunks with `.sample_rate`, `.sample_width`, `.sample_channels`, `.audio_int16_bytes`.
- Voice `en_GB-alan-medium`: 22050 Hz, espeak `en-gb-x-rp` (RP British male). Files: `en_GB-alan-medium.onnx` (~63 MB) + `en_GB-alan-medium.onnx.json` (~5 kB) at `rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/`.
- Launcher [scripts/start-jarvis.sh:25-36](../../../scripts/start-jarvis.sh) starts the TTS server; currently hardcoded to `tts/server.py` + `tts/.venv`.
- `.gitignore` currently contains only `*.gguf`; the Kokoro blobs are untracked but not ignored.

> **Network note:** Task 1 requires internet to `pip install` and `curl` the model from Hugging Face. If the environment is offline, Task 1 is BLOCKED — report it rather than improvising.

## File structure

- **Create** `tts/requirements-piper.txt` — Piper server deps.
- **Create** `tts/piper_server.py` — the Piper TTS server (one responsibility: serve `/v1/audio/speech` via Piper).
- **Create** `tts/smoke-piper.sh` — contract smoke test (starts server on a test port, POSTs, checks WAV).
- **Create** `tts/.venv-piper/` + `tts/voices/…` — environment + model (not committed).
- **Modify** `scripts/start-jarvis.sh` — engine selection by `JARVIS_TTS_ENGINE`.
- **Modify** `.gitignore` — ignore TTS model blobs.
- **Modify** `tts/README.md`, `docs/VOICE.md` — document Piper + the switch + license.

All paths below are relative to the repo root `~/Desktop/jarvis`. Commands in Tasks 1–2 run from `tts/`.

---

### Task 1: Piper environment + voice model

**Files:**
- Create: `tts/requirements-piper.txt`
- Create: `tts/.venv-piper/` (generated), `tts/voices/en_GB-alan-medium.onnx` + `.onnx.json` (downloaded)

- [ ] **Step 1: Write the requirements file**

Create `tts/requirements-piper.txt`:

```
piper-tts
fastapi
uvicorn
```

- [ ] **Step 2: Create the isolated venv and install**

Run from `tts/`:

```bash
python3.12 -m venv .venv-piper
./.venv-piper/bin/python -m pip install --upgrade pip
./.venv-piper/bin/python -m pip install -r requirements-piper.txt
```

Expected: installs `piper-tts` (1.4.x) + FastAPI + uvicorn with no build errors (a prebuilt arm64 wheel is used). If pip tries to build from source or reports "no matching distribution", STOP and report — the environment may not be macOS arm64 / Python ≥3.9.

- [ ] **Step 3: Download the voice model**

Run from `tts/`:

```bash
mkdir -p voices
curl -fsSL -o voices/en_GB-alan-medium.onnx \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx"
curl -fsSL -o voices/en_GB-alan-medium.onnx.json \
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json"
```

Expected: `voices/en_GB-alan-medium.onnx` is ~63 MB. Verify:

```bash
ls -l voices/en_GB-alan-medium.onnx voices/en_GB-alan-medium.onnx.json
```

Expected: both files present, the `.onnx` tens of MB (not a few KB — a tiny file means an error page was saved).

- [ ] **Step 4: Verify Piper loads the model and phonemizes (espeak works)**

Run from `tts/`:

```bash
./.venv-piper/bin/python -c "from piper import PiperVoice; v=PiperVoice.load('voices/en_GB-alan-medium.onnx'); n=len(list(v.synthesize('All systems online.'))); print('chunks', n)"
```

Expected: prints `chunks N` with `N >= 1` and no exception. (This proves the wheel, the model, and bundled espeak-ng all work natively.) If it raises about espeak/phonemes, STOP and report — the bundled phonemizer isn't loading.

- [ ] **Step 5: Commit the requirements file**

(Only the requirements file is committed; the venv and model are ignored in Task 3.)

```bash
cd ..  # repo root
git add tts/requirements-piper.txt
git commit -m "feat(tts): add Piper server requirements

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Piper TTS server + smoke test

**Files:**
- Create: `tts/piper_server.py`
- Test: `tts/smoke-piper.sh`

- [ ] **Step 1: Write the failing smoke test**

Create `tts/smoke-piper.sh`:

```bash
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
```

Make it executable:

```bash
chmod +x tts/smoke-piper.sh
```

- [ ] **Step 2: Run the smoke test — verify it FAILS**

Run from the repo root:

```bash
bash tts/smoke-piper.sh
```

Expected: FAIL — `/health never came up` (because `tts/piper_server.py` does not exist yet, so the server process exits immediately).

- [ ] **Step 3: Implement the Piper server**

Create `tts/piper_server.py`:

```python
#!/usr/bin/env python3
"""Jarvis TTS — local Piper server (OpenAI-compatible /v1/audio/speech).

British-male neural voice (en_GB-alan, Received Pronunciation) via Piper, runs
natively on Apple Silicon. The app POSTs the agent's reply text and plays the
returned WAV; if this server is down, the app falls back to AVSpeechSynthesizer.
"""
import io
import os
import wave

from fastapi import FastAPI
from fastapi.responses import Response
from pydantic import BaseModel
from piper import PiperVoice

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_VOICE = os.environ.get(
    "PIPER_VOICE", os.path.join(HERE, "voices", "en_GB-alan-medium.onnx")
)

voice = PiperVoice.load(DEFAULT_VOICE)


def synth_wav(text: str) -> bytes:
    """Synthesize `text` to a complete WAV byte string in memory.

    Piper streams audio in chunks; we assemble them into a WAV with the stdlib
    `wave` module (deterministic, no temp file). Empty/whitespace input yields a
    valid empty WAV so the endpoint never 500s on a blank request.
    """
    chunks = list(voice.synthesize(text)) if text.strip() else []
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        if chunks:
            first = chunks[0]
            wf.setnchannels(first.sample_channels)
            wf.setsampwidth(first.sample_width)
            wf.setframerate(first.sample_rate)
            for c in chunks:
                wf.writeframes(c.audio_int16_bytes)
        else:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(22050)
    return buf.getvalue()


# Warm up once at startup: the first onnxruntime inference does graph
# optimization and is much slower. Doing it here removes that lag from the
# user's first reply. Failure is non-fatal — the first real request is just slow.
try:
    synth_wav("Online.")
    print("[jarvis-tts] piper warmed up", flush=True)
except Exception as e:
    print(f"[jarvis-tts] piper warmup skipped: {e}", flush=True)

app = FastAPI()


class SpeechReq(BaseModel):
    input: str
    voice: str = ""      # accepted for OpenAI-compat; Piper is single-model (ignored)
    speed: float = 1.0   # accepted for OpenAI-compat; ignored
    # model / response_format are accepted and ignored (pydantic drops extras)


@app.get("/health")
def health():
    return {"ok": True, "engine": "piper", "voice": os.path.basename(DEFAULT_VOICE)}


@app.post("/v1/audio/speech")
def speech(req: SpeechReq):
    return Response(content=synth_wav(req.input), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PIPER_PORT", os.environ.get("KOKORO_PORT", "8082")))
    print(f"[jarvis-tts] Piper on :{port}  voice={os.path.basename(DEFAULT_VOICE)}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
```

- [ ] **Step 4: Run the smoke test — verify it PASSES**

Run from the repo root:

```bash
bash tts/smoke-piper.sh
```

Expected: PASS — prints `piper-smoke: OK (<N> bytes)` with N in the tens of thousands (a ~1.5 s WAV at 22050 Hz). If it fails on the WAVE magic, inspect `/tmp/jarvis_piper_smoke.log`.

- [ ] **Step 5: Commit**

```bash
git add tts/piper_server.py tts/smoke-piper.sh
git commit -m "feat(tts): Piper OpenAI-compatible speech server + smoke test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Launcher engine selection + gitignore

**Files:**
- Modify: `scripts/start-jarvis.sh` (the TTS block, lines ~25-36)
- Modify: `.gitignore`

- [ ] **Step 1: Replace the TTS block in the launcher**

In `scripts/start-jarvis.sh`, replace this block:

```bash
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
```

with:

```bash
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
    echo "      already running"
  fi
else
  echo "      skipped — $TTS_ENGINE venv not set up (app falls back to AVSpeech). See docs/VOICE.md"
fi
```

- [ ] **Step 2: Verify the launcher still parses and selects correctly**

```bash
bash -n scripts/start-jarvis.sh && echo "syntax ok"
```

Expected: `syntax ok`.

Then verify both engines resolve to the right script (no servers are started — this only checks the selection logic by sourcing the variable block is impractical, so assert via grep):

```bash
grep -q 'JARVIS_TTS_ENGINE:-piper' scripts/start-jarvis.sh && \
grep -q 'tts/piper_server.py' scripts/start-jarvis.sh && \
grep -q 'tts/server.py' scripts/start-jarvis.sh && echo "engine selection present"
```

Expected: `engine selection present`.

- [ ] **Step 3: Add gitignore rules for TTS model blobs**

Append to `.gitignore`:

```
# TTS model blobs (downloaded by setup, never committed)
tts/voices/
tts/*.onnx
tts/*.bin
```

- [ ] **Step 4: Verify the model blob is now ignored**

```bash
git check-ignore tts/voices/en_GB-alan-medium.onnx
```

Expected: prints `tts/voices/en_GB-alan-medium.onnx` (a match means it's ignored). Also confirm the venv isn't accidentally staged:

```bash
git status --porcelain tts/ | grep -E "\.venv-piper|voices/" || echo "venv + model correctly untracked/ignored"
```

Expected: `venv + model correctly untracked/ignored`.

- [ ] **Step 5: Commit**

```bash
git add scripts/start-jarvis.sh .gitignore
git commit -m "feat(tts): select TTS engine via JARVIS_TTS_ENGINE (default piper); ignore model blobs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Documentation

**Files:**
- Modify: `tts/README.md`
- Modify: `docs/VOICE.md`

- [ ] **Step 1: Add a Piper section to `tts/README.md`**

Append to `tts/README.md`:

```markdown

## Piper (default voice: en_GB-alan, British male RP)

Jarvis defaults to the Piper `en_GB-alan-medium` voice. It serves the SAME
OpenAI-compatible `/v1/audio/speech` on `:8082`, so the app is unchanged.

### Setup (one time)
```bash
cd tts
python3.12 -m venv .venv-piper
./.venv-piper/bin/python -m pip install -r requirements-piper.txt
mkdir -p voices
curl -fsSL -o voices/en_GB-alan-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx
curl -fsSL -o voices/en_GB-alan-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium/en_GB-alan-medium.onnx.json
```

### Run
```bash
./.venv-piper/bin/python piper_server.py     # :8082 (start-jarvis.sh does this for you)
```

### Switching engines
`start-jarvis.sh` starts Piper by default. To use Kokoro instead:
```bash
JARVIS_TTS_ENGINE=kokoro ./scripts/start-jarvis.sh
```
Override the Piper voice file with `PIPER_VOICE=/path/to/other.onnx`.

### Smoke test
```bash
bash smoke-piper.sh    # synthesizes a sentence on a throwaway port, asserts a valid WAV
```

### Licensing
The Piper engine (`piper-tts` / `piper1-gpl`) is GPL-3.0; the `en_GB-alan` voice
model is permissively licensed. Piper runs as its own process (the app only talks
HTTP to it on :8082), so it does not affect the app's licensing. Kokoro remains
the Apache-2.0 option.
```

- [ ] **Step 2: Note the engine switch in `docs/VOICE.md`**

Read `docs/VOICE.md`, then add a short note near where the Kokoro/voice setup is described, stating: the default neural voice is now **Piper `en_GB-alan`** (British male, RP); set `JARVIS_TTS_ENGINE=kokoro` to use the Kokoro `bm_george` voice instead; both serve `:8082` and the `AVSpeechSynthesizer` fallback is unchanged. Match the surrounding heading style of the existing file (open it first to mirror its format).

- [ ] **Step 3: Commit**

```bash
git add tts/README.md docs/VOICE.md
git commit -m "docs(tts): document the Piper default voice and the engine switch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Smoke test passes end to end**

Run from the repo root:

```bash
bash tts/smoke-piper.sh
```

Expected: `piper-smoke: OK (<N> bytes)`.

- [ ] **Step 2: Launcher syntax + selection**

```bash
bash -n scripts/start-jarvis.sh && echo "launcher ok"
```

Expected: `launcher ok`.

- [ ] **Step 3: Model + venv are not tracked**

```bash
git status --porcelain | grep -E "\.venv-piper|tts/voices/|\.onnx$" || echo "no model/venv staged"
```

Expected: `no model/venv staged`.

- [ ] **Step 4: Confirm and report**

```bash
git log --oneline -5
```

Report: that the Piper server passes the smoke test, the launcher selects piper by default, the model/venv are ignored, and the four feature commits plus the spec commit are present. Note that hearing it in the actual app requires running the full stack (out of scope for automated verification).

---

## Self-review

- **Spec coverage:**
  - `tts/piper_server.py` (FastAPI, /health + /v1/audio/speech, warm-up, single-model, env voice/port) → Task 2. ✓
  - Isolated `tts/.venv-piper` + `requirements-piper.txt` → Task 1. ✓
  - Voice download into `tts/voices/` → Task 1. ✓
  - Launcher engine selection, default piper → Task 3. ✓
  - `.gitignore` for model blobs (spec's corrected note) → Task 3. ✓
  - Docs (README + VOICE.md) incl. license note → Task 4. ✓
  - Smoke test (RIFF/WAVE contract check) → Task 2. ✓
  - Spec unknown #1 (espeak works) → Task 1 Step 4 surfaces it. ✓
  - Spec unknown #2 (synthesize API) → resolved by using the streaming `synthesize()` chunk assembly, avoiding the unconfirmed `synthesize_wav`+BytesIO path. ✓
  - "No app changes" → confirmed in Verified Facts; no app task exists, by design. ✓
- **Placeholder scan:** no TBD/TODO; every code/command step is concrete. Task 4 Step 2 instructs reading `docs/VOICE.md` first to match its style (its current content is unknown) rather than inventing exact text — this is a deliberate, bounded instruction, not a placeholder.
- **Consistency:** `JARVIS_TTS_ENGINE` (default `piper`), `PIPER_VOICE`, `PIPER_PORT`, `tts/.venv-piper`, `tts/voices/en_GB-alan-medium.onnx`, and `synth_wav` are used identically across Tasks 1–4. Server port logic (`PIPER_PORT` → `KOKORO_PORT` → 8082) matches the smoke test's `PIPER_PORT` override.
