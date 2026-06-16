# Jarvis TTS — Kokoro (natural British-male voice)

Local neural TTS so Jarvis sounds natural, not robotic. Apache-2.0 [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) via `kokoro-onnx` (onnxruntime, CoreML-accelerated on Apple Silicon). Exposes an OpenAI-compatible `/v1/audio/speech` on `:8082`; the app plays the WAV and falls back to `AVSpeechSynthesizer` if this server is down.

## Setup (one time)
```bash
cd tts
uv venv --python 3.12 .venv          # or: python3.12 -m venv .venv
source .venv/bin/activate
uv pip install -r requirements.txt   # or: pip install -r requirements.txt
# model files (already downloaded if you ran setup):
curl -sL -o kokoro-v1.0.onnx  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -sL -o voices-v1.0.bin   https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
```

## Run
```bash
./.venv/bin/python server.py     # :8082  (start-jarvis.sh does this for you)
```

## Voice
Default `bm_george` (British male). Other British males: `bm_fable`, `bm_lewis`, `bm_daniel`.
Override: `KOKORO_VOICE=bm_fable ./.venv/bin/python server.py`. Full list: Kokoro's VOICES.md.

Measured on M3 Pro: ~0.75 real-time factor (a 3 s reply synthesizes in ~2 s).

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
