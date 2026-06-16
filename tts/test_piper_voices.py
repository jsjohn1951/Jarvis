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


class _FakeChunk:
    sample_channels = 1
    sample_width = 2
    sample_rate = 22050
    audio_int16_bytes = b"\x00\x01" * 100


class _FakeVoice:
    class config:
        sample_rate = 22050

    def synthesize(self, text):
        return [_FakeChunk()] if text.strip() else []


def test_manager_loads_once_and_swaps_on_change():
    calls = []

    def fake_load(path):
        calls.append(path)
        return _FakeVoice()

    # Pretend every requested voice is on disk so synth uses the asked id.
    # Restore afterwards so this process-global patch can't leak into other tests.
    original_is_downloaded = pv.is_downloaded
    pv.is_downloaded = lambda vid: True
    try:
        mgr = pv.VoiceManager(load_fn=fake_load)

        wav1 = mgr.synth_wav("hello", "en_GB-alan-medium")
        wav2 = mgr.synth_wav("again", "en_GB-alan-medium")   # same id → no reload
        assert wav1[:4] == b"RIFF" and wav2[:4] == b"RIFF"
        assert len(calls) == 1, calls
        assert mgr.loaded_id == "en_GB-alan-medium"

        mgr.synth_wav("switch", "en_US-amy-medium")           # new id → one reload
        assert len(calls) == 2, calls
        assert mgr.loaded_id == "en_US-amy-medium"             # only one held
    finally:
        pv.is_downloaded = original_is_downloaded


def run_all():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("ALL PASS")


if __name__ == "__main__":
    run_all()
