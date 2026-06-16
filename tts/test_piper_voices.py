"""Framework-less unit tests for piper_voices (no network, no onnxruntime).

Run: ./.venv-piper/bin/python test_piper_voices.py
"""
import os
import tempfile

import piper_voices as pv


def test_voice_urls_simple():
    onnx, js = pv.voice_urls("en_GB-alan-medium")
    base = "https://huggingface.co/rhasspy/piper-voices/resolve/main"
    assert onnx == f"{base}/en/en_GB/alan/medium/en_GB-alan-medium.onnx", onnx
    assert js == onnx + ".json", js


def test_voice_urls_underscored_name():
    # Speaker name itself contains underscores; quality is the final token.
    onnx, _ = pv.voice_urls("en_US-hfc_female-medium")
    assert onnx.endswith("/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx"), onnx
    onnx2, _ = pv.voice_urls("en_GB-northern_english_male-medium")
    assert "/en_GB/northern_english_male/medium/" in onnx2, onnx2


def test_catalog_status_marks_default_downloaded():
    rows = pv.catalog_with_status()
    by_id = {r["id"]: r for r in rows}
    assert by_id["en_GB-alan-medium"]["downloaded"] is True   # ships with repo
    # A voice that isn't on disk reports False.
    assert by_id["en_US-amy-medium"]["downloaded"] is False
    # Each row carries the fields the HUD needs.
    assert {"id", "name", "gender", "downloaded"} <= set(rows[0].keys())


def test_is_downloaded_isolated(tmp=None):
    # Portable check independent of which models ship on disk: point VOICES_DIR
    # at a temp dir, then toggle the .onnx/.onnx.json pair.
    original = pv.VOICES_DIR
    with tempfile.TemporaryDirectory() as d:
        pv.VOICES_DIR = d
        try:
            vid = "en_US-amy-medium"
            assert pv.is_downloaded(vid) is False          # nothing on disk
            onnx = pv.voice_path(vid)
            open(onnx, "wb").close()
            assert pv.is_downloaded(vid) is False          # .json sidecar missing
            open(onnx + ".json", "wb").close()
            assert pv.is_downloaded(vid) is True            # both present
        finally:
            pv.VOICES_DIR = original


def run_all():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("ALL PASS")


if __name__ == "__main__":
    run_all()
