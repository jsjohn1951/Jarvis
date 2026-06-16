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
