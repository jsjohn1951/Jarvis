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


def run_all():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("ALL PASS")


if __name__ == "__main__":
    run_all()
