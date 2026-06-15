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
