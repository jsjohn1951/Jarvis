#!/usr/bin/env python3
"""Jarvis TTS — local Piper server (OpenAI-compatible /v1/audio/speech).

Serves a curated catalog of British/American Piper voices. The active voice is
chosen per request via the `voice` field (default en_GB-alan-medium); voices are
downloaded on demand into voices/ and only the active one is held in memory. The
app POSTs the agent's reply text and plays the returned WAV; if this server is
down, the app falls back to AVSpeechSynthesizer.
"""
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from piper import PiperVoice

from piper_voices import (
    DEFAULT_VOICE_ID,
    VoiceManager,
    catalog_with_status,
    download_state,
    start_download,
)

manager = VoiceManager(load_fn=PiperVoice.load)

# Warm up the default voice once: the first onnxruntime inference does graph
# optimization and is much slower. Doing it here removes that lag from the
# user's first reply. Failure is non-fatal — the first real request is just slow.
try:
    manager.synth_wav("Online.", DEFAULT_VOICE_ID)
    print("[jarvis-tts] piper warmed up", flush=True)
except Exception as e:
    print(f"[jarvis-tts] piper warmup skipped: {e}", flush=True)

app = FastAPI()

# Optional shared-secret gate for non-loopback binds (PIPER_HOST=0.0.0.0 for the
# iOS client): when PIPER_TOKEN is set, every request must carry it in
# X-Jarvis-Token. Loopback callers on the default bind are unaffected (no token
# set → no check). The token is the same pairing secret the orchestrator uses
# (~/.jarvis/mobile-token), exported by scripts/start-jarvis.sh.
TOKEN = os.environ.get("PIPER_TOKEN", "")


@app.middleware("http")
async def require_token(request: Request, call_next):
    if TOKEN and request.headers.get("x-jarvis-token", "") != TOKEN:
        return JSONResponse({"error": "missing or bad X-Jarvis-Token"}, status_code=401)
    return await call_next(request)


class SpeechReq(BaseModel):
    input: str
    voice: str = ""      # catalog voice id; "" → current/default voice
    speed: float = 1.0   # accepted for OpenAI-compat; ignored
    # model / response_format are accepted and ignored (pydantic drops extras)


@app.get("/health")
def health():
    return {"ok": True, "engine": "piper", "voice": manager.loaded_id or DEFAULT_VOICE_ID}


@app.get("/voices")
def voices():
    return {"voices": catalog_with_status(), "selected": manager.loaded_id or DEFAULT_VOICE_ID}


@app.post("/voices/{voice_id}/download")
def voice_download(voice_id: str):
    return start_download(voice_id)


@app.get("/voices/{voice_id}/status")
def voice_status(voice_id: str):
    return download_state(voice_id)


@app.post("/v1/audio/speech")
def speech(req: SpeechReq):
    return Response(content=manager.synth_wav(req.input, req.voice), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PIPER_PORT", os.environ.get("KOKORO_PORT", "8082")))
    # Default loopback-only; PIPER_HOST=0.0.0.0 exposes it to the iOS client
    # (pair with PIPER_TOKEN — see scripts/ios-package.sh).
    host = os.environ.get("PIPER_HOST", "127.0.0.1")
    print(f"[jarvis-tts] Piper on {host}:{port}", flush=True)
    uvicorn.run(app, host=host, port=port, log_level="warning")
