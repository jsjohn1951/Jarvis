#!/usr/bin/env python3
"""Jarvis TTS — local Kokoro server (OpenAI-compatible /v1/audio/speech).

Natural British-male neural voice, runs on Apple Silicon via onnxruntime's
CoreML provider. The app POSTs the agent's reply text and plays the returned WAV;
if this server is down, the app falls back to AVSpeechSynthesizer automatically.
"""
import io
import os
import soundfile as sf
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from kokoro_onnx import Kokoro

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_VOICE = os.environ.get("KOKORO_VOICE", "bm_george")  # British male (bm_fable/bm_lewis/bm_daniel also good)
LANG = os.environ.get("KOKORO_LANG", "en-gb")

kokoro = Kokoro(os.path.join(HERE, "kokoro-v1.0.onnx"), os.path.join(HERE, "voices-v1.0.bin"))

# Warm up once at startup: the first onnxruntime inference does graph optimization
# and is much slower. Doing it here (not on the user's first reply) removes that lag.
try:
    kokoro.create("Online.", voice=DEFAULT_VOICE, lang=LANG)
    print("[jarvis-tts] warmed up", flush=True)
except Exception as e:  # non-fatal — first real request will just be slightly slower
    print(f"[jarvis-tts] warmup skipped: {e}", flush=True)

app = FastAPI()

# Optional shared-secret gate for non-loopback binds (KOKORO_HOST=0.0.0.0 for the
# iOS client) — same contract as piper_server.py: when PIPER_TOKEN is set, every
# request must carry it in X-Jarvis-Token.
TOKEN = os.environ.get("PIPER_TOKEN", "")


@app.middleware("http")
async def require_token(request: Request, call_next):
    if TOKEN and request.headers.get("x-jarvis-token", "") != TOKEN:
        return JSONResponse({"error": "missing or bad X-Jarvis-Token"}, status_code=401)
    return await call_next(request)


class SpeechReq(BaseModel):
    input: str
    voice: str = DEFAULT_VOICE
    speed: float = 1.0
    # OpenAI-compat fields accepted but unused: model, response_format


@app.get("/health")
def health():
    return {"ok": True, "engine": "kokoro", "voice": DEFAULT_VOICE}


@app.post("/v1/audio/speech")
def speech(req: SpeechReq):
    samples, sr = kokoro.create(req.input, voice=req.voice, speed=req.speed, lang=LANG)
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV")
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("KOKORO_PORT", "8082"))
    # Default loopback-only; KOKORO_HOST=0.0.0.0 exposes it to the iOS client
    # (pair with PIPER_TOKEN — see scripts/ios-package.sh).
    host = os.environ.get("KOKORO_HOST", "127.0.0.1")
    print(f"[jarvis-tts] Kokoro on {host}:{port}  voice={DEFAULT_VOICE} lang={LANG}", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="warning")
