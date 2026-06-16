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
            # No chunks (empty input): a valid silent WAV at the voice's own rate.
            # Piper output is always mono 16-bit PCM; the rate is voice-specific,
            # so read it from the model rather than hardcoding a single voice's value.
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(voice.config.sample_rate)
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
