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


def test_catalog_status_reflects_disk_and_has_hud_fields():
    # Isolate VOICES_DIR so the result is independent of which models are
    # actually downloaded on this machine: stage one catalog voice as present,
    # leave another absent, and assert catalog_with_status reflects that.
    original = pv.VOICES_DIR
    with tempfile.TemporaryDirectory() as d:
        pv.VOICES_DIR = d
        try:
            present = pv.voice_path("en_GB-alan-medium")
            open(present, "wb").close()
            open(present + ".json", "wb").close()

            rows = pv.catalog_with_status()
            by_id = {r["id"]: r for r in rows}
            assert by_id["en_GB-alan-medium"]["downloaded"] is True   # staged above
            assert by_id["en_US-amy-medium"]["downloaded"] is False   # not staged
            # Each row carries the fields the HUD needs.
            assert {"id", "name", "gender", "downloaded"} <= set(rows[0].keys())
        finally:
            pv.VOICES_DIR = original


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


def test_download_atomic_from_local_source():
    import time

    original_voices_dir = pv.VOICES_DIR
    original_voice_urls = pv.voice_urls
    with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as dst:
        # Stand up fake "remote" files and serve them over file:// URLs.
        onnx_src = os.path.join(src, "x.onnx")
        json_src = os.path.join(src, "x.onnx.json")
        with open(onnx_src, "wb") as f:
            f.write(b"ONNXDATA" * 1000)
        with open(json_src, "wb") as f:
            f.write(b'{"audio": {"sample_rate": 22050}}')

        vid = "en_US-amy-medium"
        pv.VOICES_DIR = dst                       # download target
        pv._dl_state.clear()
        pv.voice_urls = lambda v: (
            "file://" + onnx_src, "file://" + json_src
        )

        try:
            assert pv.download_state(vid)["state"] == "absent"
            assert pv.start_download(vid)["state"] == "downloading"

            for _ in range(50):                       # wait for the bg thread
                if pv.download_state(vid)["state"] == "ready":
                    break
                time.sleep(0.1)
            assert pv.download_state(vid)["state"] == "ready"
            assert pv.is_downloaded(vid)              # both files present
            # No partial files left behind.
            assert not os.path.exists(pv.voice_path(vid) + ".part")
            assert not os.path.exists(pv.voice_path(vid) + ".json.part")
        finally:
            pv.VOICES_DIR = original_voices_dir
            pv.voice_urls = original_voice_urls
            pv._dl_state.clear()


def test_download_unknown_voice_errors():
    assert pv.start_download("nope-bad-medium")["state"] == "error"


def run_all():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("ALL PASS")


if __name__ == "__main__":
    run_all()
