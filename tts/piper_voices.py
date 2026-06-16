"""Piper voice catalog, on-disk status, lazy model manager, and downloader.

Imported by piper_server.py. Deliberately free of import-time side effects
(no model load, no network, no FastAPI) so it can be unit-tested directly.
"""
from __future__ import annotations

import io
import os
import threading
import urllib.request
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
VOICES_DIR = os.path.join(HERE, "voices")
HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

# Curated English catalog. Each id is `<locale>-<name>-<quality>`; the download
# URLs are derived from it (see voice_urls), so this list only carries what a
# human needs to choose: a label and the speaker's gender.
CATALOG: list[dict] = [
    {"id": "en_GB-alan-medium",                  "name": "Alan — British male (RP)",  "gender": "male"},
    {"id": "en_GB-northern_english_male-medium", "name": "Northern English — male",   "gender": "male"},
    {"id": "en_GB-jenny_dioco-medium",           "name": "Jenny — British female",    "gender": "female"},
    {"id": "en_GB-alba-medium",                  "name": "Alba — Scottish female",    "gender": "female"},
    {"id": "en_US-ryan-medium",                  "name": "Ryan — American male",      "gender": "male"},
    {"id": "en_US-joe-medium",                   "name": "Joe — American male",       "gender": "male"},
    {"id": "en_US-amy-medium",                   "name": "Amy — American female",     "gender": "female"},
    {"id": "en_US-lessac-medium",                "name": "Lessac — American female",  "gender": "female"},
    {"id": "en_US-hfc_female-medium",            "name": "HFC — American female",     "gender": "female"},
    {"id": "en_US-hfc_male-medium",              "name": "HFC — American male",       "gender": "male"},
]
DEFAULT_VOICE_ID = "en_GB-alan-medium"
_CATALOG_IDS = {v["id"] for v in CATALOG}


def voice_urls(voice_id: str) -> tuple[str, str]:
    """(onnx_url, json_url) on Hugging Face, derived from the id.

    id is `<locale>-<name>-<quality>` where locale is en_GB/en_US (one
    underscore, no dash) and quality is the final dash-delimited token. The
    speaker name (which may itself contain underscores) is everything between.
    """
    locale, _, rest = voice_id.partition("-")    # "en_GB", "name-...-quality"
    name, _, quality = rest.rpartition("-")       # "name...", "quality"
    path = f"en/{locale}/{name}/{quality}/{voice_id}"
    onnx = f"{HF_BASE}/{path}.onnx"
    return onnx, onnx + ".json"


def voice_path(voice_id: str) -> str:
    """Local .onnx path for a voice (its .onnx.json sits beside it)."""
    return os.path.join(VOICES_DIR, f"{voice_id}.onnx")


def is_downloaded(voice_id: str) -> bool:
    onnx = voice_path(voice_id)
    return os.path.exists(onnx) and os.path.exists(onnx + ".json")


def catalog_with_status() -> list[dict]:
    return [{**v, "downloaded": is_downloaded(v["id"])} for v in CATALOG]


def render_wav(voice, text: str) -> bytes:
    """Synthesize `text` to a complete in-memory WAV via the stdlib `wave`.

    Piper streams audio in chunks; we assemble them deterministically. Empty
    input yields a valid silent WAV at the voice's own rate so the endpoint
    never 500s on a blank request.
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
            wf.setframerate(voice.config.sample_rate)
    return buf.getvalue()


class VoiceManager:
    """Holds exactly one loaded PiperVoice; swaps it lazily on request.

    Only the active voice stays resident (~60 MB). A lock serializes load+synth
    because FastAPI runs sync endpoints in a threadpool, so a swap can race a
    concurrent synth otherwise. `load_fn` is injected (PiperVoice.load in prod,
    a stub in tests) to keep this class importable without onnxruntime.
    """

    def __init__(self, load_fn):
        self._load_fn = load_fn
        self._lock = threading.Lock()
        self._id: str | None = None
        self._voice = None

    @property
    def loaded_id(self) -> str | None:
        return self._id

    def _ensure(self, voice_id: str):
        if self._id != voice_id:
            self._voice = self._load_fn(voice_path(voice_id))
            self._id = voice_id
        return self._voice

    def synth_wav(self, text: str, voice_id: str = "") -> bytes:
        # Fall back to the loaded (or default) voice if the requested one isn't
        # downloaded or is blank — never 500 on a bad/absent id.
        with self._lock:
            if voice_id and is_downloaded(voice_id):
                target = voice_id
            else:
                target = self._id or DEFAULT_VOICE_ID
            return render_wav(self._ensure(target), text)
