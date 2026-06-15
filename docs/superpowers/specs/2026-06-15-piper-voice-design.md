# Piper (Alan) voice for Jarvis TTS

**Date:** 2026-06-15
**Status:** Approved design, pending implementation plan
**Area:** `tts/`, `scripts/`, `docs/`

## Problem / goal

The user wanted to add the Hugging Face voice `ufozone/piper-de_DE-jarvis-medium`.
Investigation showed it is a **German (de_DE)** Piper voice, which would mispronounce
Jarvis's English replies (espeak-ng applies German phonemization to English text).
Decision: use an **English British-male Piper voice** instead — `en_GB-alan-medium`
from `rhasspy/piper-voices` — which delivers the same intent (a distinctive Piper
"Jarvis" voice) while pronouncing English correctly.

Make this Piper voice **Jarvis's default**, with the existing Kokoro voice reachable
via an env switch. The integration must not change the macOS app.

## Key verified facts

- The app ([app/Jarvis/Voice/KokoroTTSService.swift](../../../app/Jarvis/Voice/KokoroTTSService.swift))
  POSTs only `{"input": text}` to `http://127.0.0.1:8082/v1/audio/speech` and plays the
  returned WAV. It sends no voice name and reads nothing Kokoro-specific. So any engine
  serving that contract on :8082 is a drop-in — **zero app changes**. The app's
  sentence-streaming, audio-ducking, and AVSpeech fallback all keep working.
- `piper-tts` 1.4.2 (the OHF-Voice `piper1-gpl` package) ships a `macosx_11_0_arm64`
  abi3 wheel for CPython 3.9+. The `tts` venv is Python 3.12, so `pip install piper-tts`
  works natively on Apple Silicon — no Docker, no `speaches`, no source build. The wheel
  embeds espeak-ng for phonemization.
- Python API: `from piper import PiperVoice` → `PiperVoice.load(onnx_path)` →
  `voice.synthesize_wav(text, wav_file)` (writes a complete WAV to an open `wave` handle).
  Streaming chunks expose `chunk.sample_rate` / `chunk.audio_int16_bytes` if needed.
- The voice exists at `rhasspy/piper-voices/en/en_GB/alan/medium/`:
  `en_GB-alan-medium.onnx` (~63 MB) + `en_GB-alan-medium.onnx.json` (~5 kB). Alan is a
  calm, neutral British male — a good Jarvis fit.
- The current launcher [scripts/start-jarvis.sh](../../../scripts/start-jarvis.sh)
  starts the TTS server at lines 25–36, hardcoded to `tts/server.py` via `tts/.venv`.

## License note

The Piper **engine** (`piper-tts` / `piper1-gpl`) is **GPL-3.0**; the **voice model**
(`en_GB-alan-medium`) is permissively licensed. Piper runs as its own separate server
process (the app only talks HTTP to it), so it does not impose GPL on the app or the rest
of the project. This is a step away from the all-Apache-2.0 posture (Kokoro) and is
recorded deliberately. (The originally-requested German voice was CC BY-NC-SA 4.0 and is
not used.)

## Architecture

Chosen approach: **a drop-in Piper server on :8082, engine-selected at launch.** (Rejected
alternatives: the `speaches` framework — heavier, breaks the lightweight native-process
pattern; and replacing Kokoro outright — destructive, loses the higher-quality voice.)

### 1. `tts/piper_server.py` (new)

A near-twin of `tts/server.py`:
- FastAPI app exposing `GET /health` and `POST /v1/audio/speech`, returning `audio/wav`.
- Loads `PiperVoice.load(PIPER_VOICE)` once at import.
- `synthesize_wav(text, wave.open(io.BytesIO(), "wb"))` → return the buffer bytes as
  `Response(media_type="audio/wav")`.
- Pydantic `SpeechReq { input: str; voice: str = ...; speed: float = 1.0 }` — mirrors the
  Kokoro server for OpenAI-compat. Piper is single-model, so `voice` is accepted and
  ignored; `speed` is accepted and ignored for now (the app sends neither; YAGNI — do not
  build length_scale mapping unless a later need appears).
- Startup warm-up call (synthesize a short string) so the first real reply isn't slow;
  warm-up failure is non-fatal and logged, exactly like the Kokoro server.
- Env: `PIPER_VOICE` (path to `.onnx`, default `<tts>/voices/en_GB-alan-medium.onnx`),
  `PIPER_PORT` / `KOKORO_PORT` defaulting to `8082`.

### 2. `tts/.venv-piper` + `tts/requirements-piper.txt` (new)

An **isolated** venv for Piper: `piper-tts`, `fastapi`, `uvicorn`. Kept separate from
`tts/.venv` because `piper-tts` bundles its own onnxruntime that could clash with
`kokoro-onnx`'s. The two servers are mutually exclusive on :8082, so isolation costs
nothing. (No `soundfile` needed — Piper writes WAV via the stdlib `wave` module.)

### 3. Voice model files

`tts/voices/en_GB-alan-medium.onnx` and `.onnx.json`, curl-downloaded from the
`rhasspy/piper-voices` HF `resolve` URLs. A download step is added to setup (README).
Note: the existing Kokoro blobs (`tts/kokoro-v1.0.onnx`, `tts/voices-v1.0.bin`) are
currently **untracked but not gitignored** (`.gitignore` only lists `*.gguf`). Add ignore
rules for the TTS model blobs (e.g. `tts/voices/`, `tts/*.onnx`, `tts/*.bin`) so neither
the new 63 MB Piper model nor the existing Kokoro blobs can be committed accidentally.

### 4. `scripts/start-jarvis.sh` (modify lines 25–36)

Select the engine by `JARVIS_TTS_ENGINE` (**default `piper`**):
- `piper` → `tts/.venv-piper/bin/python tts/piper_server.py`
- `kokoro` → existing `tts/.venv/bin/python tts/server.py`

Same `:8082/health` readiness gate; the startup log line names the active engine. If the
selected engine's venv/model is missing, behave like the existing "venv not set up" branch
(skip, app falls back to AVSpeech) rather than crashing the whole stack.

### 5. Docs

- `tts/README.md`: add the Piper section — one-time setup (venv + `pip install` + voice
  download), how to run, the `JARVIS_TTS_ENGINE` switch, and the license note.
- `docs/VOICE.md`: note the default voice is now Piper Alan and how to switch back to Kokoro.

## Data flow (unchanged for the app)

```
app → POST :8082/v1/audio/speech {input}
        → piper_server: PiperVoice.synthesize_wav → WAV bytes → AVAudioPlayer
        (server down) ↘ app's existing AVSpeech fallback
```

## Error handling

- Server-down is already handled by the app (`onUnavailable` → AVSpeech). Nothing to add.
- Warm-up failure non-fatal (first request just slower), matching the Kokoro server.
- Missing venv/model in the launcher → skip TTS startup (AVSpeech fallback), don't fail the stack.

## Testing

A smoke test, `tts/smoke-piper.sh` (or a tiny Python script): start `piper_server.py`,
POST `{"input":"All systems online."}` to `/v1/audio/speech`, assert HTTP 200 and that the
body begins with the `RIFF`…`WAVE` magic and is non-empty; assert `/health` returns ok.
This is the meaningful contract check; the repo currently has no TTS tests, so it also
fills a small gap.

## Unknowns to verify during implementation (do not assume)

1. The bundled **espeak-ng phonemization** in the macOS arm64 wheel works at runtime —
   the warm-up call surfaces it immediately on first start.
2. The exact `synthesize_wav` signature and whether it writes a finalized WAV to an
   in-memory `wave.open(BytesIO)` handle in `piper-tts` 1.4.2 — confirm against the
   installed package before finalizing `piper_server.py` (fall back to assembling raw
   `audio_int16_bytes` chunks into a WAV if `synthesize_wav` needs a real file).

## Out of scope (YAGNI)

- Per-request voice/speed control on the Piper server (the app sends neither).
- A runtime/HUD engine toggle (env-at-launch is enough; switching engines means a restart).
- Renaming `KokoroTTSService.swift` (its behavior is engine-agnostic; cosmetic only).
- Using the German voice or the `speaches` framework.
