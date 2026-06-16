# Piper Voice Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick the Piper TTS voice from a HUD dropdown, downloading curated English voices on demand.

**Architecture:** The Piper server ([tts/piper_server.py](../../../tts/piper_server.py)) gains a curated catalog, a single-active-voice manager, and an on-demand downloader, all in a new side-effect-free module [tts/piper_voices.py](../../../tts/piper_voices.py) so it's unit-testable. The macOS app gets a thin catalog client and a `Picker` in the HUD; the chosen voice id is persisted under `UserDefaults` key `piperVoice` and sent on every synth request. No orchestrator changes — the app already POSTs to `:8082` directly.

**Tech Stack:** Python 3.12 + FastAPI + `piper-tts` (server); Swift 6 / SwiftUI (app, built via XcodeGen + xcodebuild). Downloads use Python stdlib `urllib` (no new dep).

Design spec: [docs/superpowers/specs/2026-06-16-piper-voice-dropdown-design.md](../specs/2026-06-16-piper-voice-dropdown-design.md)

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `tts/piper_voices.py` | Catalog, URL derivation, on-disk status, `VoiceManager` (single active voice), downloader. No import-time side effects. | Create |
| `tts/test_piper_voices.py` | Framework-less unit tests (plain `assert` + `__main__`), no network. | Create |
| `tts/piper_server.py` | FastAPI app + endpoints; delegates all voice logic to `piper_voices`. | Rewrite |
| `tts/smoke-piper.sh` | Add `/voices` + voice-field assertions to the contract smoke test. | Modify |
| `app/Jarvis/Voice/PiperVoiceService.swift` | `PiperVoiceModel` — thin client for the catalog/download/status endpoints; persists selection. | Create |
| `app/Jarvis/MenuBar/HUDView.swift` | Add the voice `Picker` row. | Modify |
| `app/Jarvis/Voice/KokoroTTSService.swift` | Send the selected voice id on synth. | Modify |
| `docs/VOICE.md`, `tts/README.md` | Document the dropdown + catalog. | Modify |

All Python commands assume the venv python `tts/.venv-piper/bin/python` (call it directly per CLAUDE.md — `npx`/`npm`/`pip` may be mangled in this shell).

---

## Task 1: Catalog, URL derivation, and on-disk status

**Files:**
- Create: `tts/piper_voices.py`
- Create: `tts/test_piper_voices.py`

- [ ] **Step 1: Write the failing tests**

Create `tts/test_piper_voices.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tts && ./.venv-piper/bin/python test_piper_voices.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'piper_voices'`

- [ ] **Step 3: Create the module with catalog + helpers**

Create `tts/piper_voices.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tts && ./.venv-piper/bin/python test_piper_voices.py`
Expected: PASS — `ok  test_catalog_status_marks_default_downloaded` … `ALL PASS`

- [ ] **Step 5: Verify every catalog URL is live (catches a wrong id early)**

Run:
```bash
cd tts && ./.venv-piper/bin/python -c "
import urllib.request, piper_voices as pv
for v in pv.CATALOG:
    onnx, js = pv.voice_urls(v['id'])
    for u in (onnx, js):
        req = urllib.request.Request(u, method='HEAD')
        code = urllib.request.urlopen(req, timeout=30).status
        assert code == 200, (v['id'], u, code)
    print('ok', v['id'])
print('ALL URLS LIVE')
"
```
Expected: `ok <id>` for all ten, then `ALL URLS LIVE`. If any 404s, fix that catalog entry's id (wrong quality tier or name) and re-run.

- [ ] **Step 6: Commit**

```bash
git add tts/piper_voices.py tts/test_piper_voices.py
git commit -m "feat(tts): Piper voice catalog + URL derivation + on-disk status"
```

---

## Task 2: WAV rendering + single-active-voice manager

**Files:**
- Modify: `tts/piper_voices.py`
- Modify: `tts/test_piper_voices.py`

- [ ] **Step 1: Write the failing test**

Add to `tts/test_piper_voices.py` (above `run_all`):

```python
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


def test_manager_loads_once_and_swaps_on_change(monkeypatch_downloaded=True):
    calls = []

    def fake_load(path):
        calls.append(path)
        return _FakeVoice()

    # Pretend every requested voice is on disk so synth uses the asked id.
    pv.is_downloaded = lambda vid: True
    mgr = pv.VoiceManager(load_fn=fake_load)

    wav1 = mgr.synth_wav("hello", "en_GB-alan-medium")
    wav2 = mgr.synth_wav("again", "en_GB-alan-medium")   # same id → no reload
    assert wav1[:4] == b"RIFF" and wav2[:4] == b"RIFF"
    assert len(calls) == 1, calls
    assert mgr.loaded_id == "en_GB-alan-medium"

    mgr.synth_wav("switch", "en_US-amy-medium")           # new id → one reload
    assert len(calls) == 2, calls
    assert mgr.loaded_id == "en_US-amy-medium"             # only one held
```

> Note: this test reassigns `pv.is_downloaded` for the process; keep it after the URL/status tests (Task 1) which need the real one. `run_all` runs tests in sorted name order, and `test_manager_*` sorts after `test_catalog_*`, so the real `is_downloaded` is used where it matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tts && ./.venv-piper/bin/python test_piper_voices.py`
Expected: FAIL — `AttributeError: module 'piper_voices' has no attribute 'VoiceManager'`

- [ ] **Step 3: Add `render_wav` and `VoiceManager`**

Append to `tts/piper_voices.py`:

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tts && ./.venv-piper/bin/python test_piper_voices.py`
Expected: PASS — includes `ok  test_manager_loads_once_and_swaps_on_change`, then `ALL PASS`

- [ ] **Step 5: Commit**

```bash
git add tts/piper_voices.py tts/test_piper_voices.py
git commit -m "feat(tts): single-active-voice VoiceManager + WAV rendering"
```

---

## Task 3: On-demand downloader (atomic, background, status-tracked)

**Files:**
- Modify: `tts/piper_voices.py`
- Modify: `tts/test_piper_voices.py`

- [ ] **Step 1: Write the failing test**

Add to `tts/test_piper_voices.py` (above `run_all`):

```python
def test_download_atomic_from_local_source():
    import time

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
        pv.is_downloaded = pv.is_downloaded       # use the real one
        pv._dl_state.clear()
        pv.voice_urls = lambda v: (
            "file://" + onnx_src, "file://" + json_src
        )

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


def test_download_unknown_voice_errors():
    assert pv.start_download("nope-bad-medium")["state"] == "error"
```

> Note: this test reassigns module globals (`VOICES_DIR`, `voice_urls`). It sorts after the catalog/URL tests, so they run against the real values first. Keep `test_download_*` named to sort last among tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tts && ./.venv-piper/bin/python test_piper_voices.py`
Expected: FAIL — `AttributeError: module 'piper_voices' has no attribute 'download_state'`

- [ ] **Step 3: Add the downloader**

Append to `tts/piper_voices.py`:

```python
# Per-voice download state for the HUD to poll.
# state: "absent" | "downloading" | "ready" | "error"
_dl_state: dict[str, dict] = {}
_dl_lock = threading.Lock()


def download_state(voice_id: str) -> dict:
    if is_downloaded(voice_id):
        return {"state": "ready"}
    with _dl_lock:
        return dict(_dl_state.get(voice_id, {"state": "absent"}))


def _fetch(url: str, dest: str) -> None:
    """Download `url` → `dest` atomically: write `.part`, then rename."""
    tmp = dest + ".part"
    with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)


def start_download(voice_id: str) -> dict:
    """Begin a background download if needed; return current state at once."""
    if voice_id not in _CATALOG_IDS:
        return {"state": "error", "error": "unknown voice"}
    if is_downloaded(voice_id):
        return {"state": "ready"}
    with _dl_lock:
        if _dl_state.get(voice_id, {}).get("state") == "downloading":
            return {"state": "downloading"}
        _dl_state[voice_id] = {"state": "downloading"}

    def run():
        onnx_url, json_url = voice_urls(voice_id)
        dest_onnx = voice_path(voice_id)
        dest_json = dest_onnx + ".json"
        try:
            os.makedirs(VOICES_DIR, exist_ok=True)
            _fetch(json_url, dest_json)
            _fetch(onnx_url, dest_onnx)
            with _dl_lock:
                _dl_state[voice_id] = {"state": "ready"}
        except Exception as e:
            # Leave no partial files behind; surface the error to the HUD.
            for p in (dest_onnx, dest_json, dest_onnx + ".part", dest_json + ".part"):
                try:
                    os.remove(p)
                except OSError:
                    pass
            with _dl_lock:
                _dl_state[voice_id] = {"state": "error", "error": str(e)}

    threading.Thread(target=run, daemon=True).start()
    return {"state": "downloading"}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tts && ./.venv-piper/bin/python test_piper_voices.py`
Expected: PASS — includes `ok  test_download_atomic_from_local_source` and `ok  test_download_unknown_voice_errors`, then `ALL PASS`

- [ ] **Step 5: Commit**

```bash
git add tts/piper_voices.py tts/test_piper_voices.py
git commit -m "feat(tts): on-demand voice downloader (atomic, background, status-tracked)"
```

---

## Task 4: Wire the new endpoints into the server

**Files:**
- Modify: `tts/piper_server.py` (full rewrite — it's 87 lines)

- [ ] **Step 1: Rewrite the server to delegate to `piper_voices`**

Replace the entire contents of `tts/piper_server.py` with:

```python
#!/usr/bin/env python3
"""Jarvis TTS — local Piper server (OpenAI-compatible /v1/audio/speech).

Serves a curated catalog of British/American Piper voices. The active voice is
chosen per request via the `voice` field (default en_GB-alan-medium); voices are
downloaded on demand into voices/ and only the active one is held in memory. The
app POSTs the agent's reply text and plays the returned WAV; if this server is
down, the app falls back to AVSpeechSynthesizer.
"""
import os

from fastapi import FastAPI
from fastapi.responses import Response
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
    print(f"[jarvis-tts] Piper on :{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
```

- [ ] **Step 2: Verify it imports and starts cleanly**

Run:
```bash
cd tts && PIPER_PORT=8098 ./.venv-piper/bin/python piper_server.py >/tmp/jarvis_piper_t4.log 2>&1 &
sleep 8
curl -s http://127.0.0.1:8098/voices | head -c 400; echo
curl -s http://127.0.0.1:8098/health; echo
kill %1 2>/dev/null || true
```
Expected: `/voices` returns JSON with the 10-entry catalog and `en_GB-alan-medium` marked `"downloaded": true`; `/health` returns `{"ok": true, "engine": "piper", "voice": "en_GB-alan-medium"}`.

- [ ] **Step 3: Commit**

```bash
git add tts/piper_server.py
git commit -m "feat(tts): voice catalog/download/status endpoints + per-request voice"
```

---

## Task 5: Extend the smoke test

**Files:**
- Modify: `tts/smoke-piper.sh`

- [ ] **Step 1: Add `/voices` and voice-field assertions**

In `tts/smoke-piper.sh`, after the existing WAV assertions block (after line 29, the `WAVE` magic check) and before the final `echo "piper-smoke: OK …"` line, insert:

```bash
# /voices lists the catalog with the default voice already downloaded.
VOICES_JSON=$(curl -sf "http://127.0.0.1:$PORT/voices") || { echo "FAIL: /voices errored"; exit 1; }
echo "$VOICES_JSON" | grep -q '"en_GB-alan-medium"' || { echo "FAIL: default voice missing from /voices"; exit 1; }
echo "$VOICES_JSON" | grep -q '"downloaded":true' || { echo "FAIL: no downloaded voice reported"; exit 1; }

# Synth with an explicit (downloaded) voice id still returns a valid WAV.
code=$(curl -s -o "$OUT" -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/v1/audio/speech" \
  -H "content-type: application/json" -d '{"input":"Voice selected.","voice":"en_GB-alan-medium"}')
[[ "$code" == "200" ]] || { echo "FAIL: voiced POST returned HTTP $code"; exit 1; }
[[ "$(head -c 4 "$OUT")" == "RIFF" ]] || { echo "FAIL: voiced response not a WAV"; exit 1; }
```

- [ ] **Step 2: Run the smoke test**

Run: `cd tts && bash smoke-piper.sh`
Expected: `piper-smoke: OK (<n> bytes)` with no FAIL lines.

- [ ] **Step 3: Commit**

```bash
git add tts/smoke-piper.sh
git commit -m "test(tts): smoke-check /voices catalog + explicit voice synth"
```

---

## Task 6: App-side catalog client

**Files:**
- Create: `app/Jarvis/Voice/PiperVoiceService.swift`

- [ ] **Step 1: Create the model**

Create `app/Jarvis/Voice/PiperVoiceService.swift`:

```swift
import Foundation

/// Thin client for the Piper server's voice catalog (:8082) backing the HUD
/// dropdown. The server owns the catalog + download URLs; this only lists,
/// triggers downloads, and polls status. The chosen voice id is persisted under
/// UserDefaults "piperVoice" and read by KokoroTTSService when it synthesizes.
@MainActor
final class PiperVoiceModel: ObservableObject {
    struct Voice: Identifiable, Decodable {
        let id: String
        let name: String
        let gender: String
        let downloaded: Bool
    }

    static let defaultId = "en_GB-alan-medium"

    @Published var voices: [Voice] = []
    @Published var downloadingId: String?
    @Published var errorText: String?
    @Published var selectedId: String =
        UserDefaults.standard.string(forKey: "piperVoice") ?? PiperVoiceModel.defaultId

    private let base = URL(string: "http://127.0.0.1:8082")!

    private struct Catalog: Decodable { let voices: [Voice] }
    private struct Status: Decodable { let state: String; let error: String? }

    /// Load the catalog into `voices`. Silent no-op if the server is unreachable
    /// (the HUD just shows the persisted selection).
    func refresh() async {
        guard let cat: Catalog = try? await get("/voices") else { return }
        voices = cat.voices
    }

    /// Select a voice: if it isn't downloaded, kick off the server download and
    /// poll until ready before persisting. Reverts to the prior choice on failure.
    func select(_ id: String) async {
        errorText = nil
        guard let v = voices.first(where: { $0.id == id }) else { persist(id); return }
        if v.downloaded { persist(id); return }

        let previous = selectedId
        downloadingId = id
        defer { downloadingId = nil }
        do {
            try await post("/voices/\(id)/download")
            try await pollReady(id)
            await refresh()
            persist(id)
        } catch {
            errorText = "Couldn’t download \(v.name)"
            selectedId = previous
        }
    }

    private func persist(_ id: String) {
        selectedId = id
        UserDefaults.standard.set(id, forKey: "piperVoice")
    }

    private func pollReady(_ id: String) async throws {
        for _ in 0..<180 {                       // ~180 s ceiling (~60 MB voice)
            let s: Status = try await get("/voices/\(id)/status")
            if s.state == "ready" { return }
            if s.state == "error" { throw URLError(.cannotLoadFromNetwork) }
            try await Task.sleep(for: .seconds(1))
        }
        throw URLError(.timedOut)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, resp) = try await URLSession.shared.data(from: base.appending(path: path))
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post(_ path: String) async throws {
        var req = URLRequest(url: base.appending(path: path))
        req.httpMethod = "POST"
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
    }
}
```

- [ ] **Step 2: Verify it compiles (build happens in Task 9)**

No standalone build yet — this type is exercised when the HUD references it in Task 7, and the whole app is built in Task 9. Proceed.

- [ ] **Step 3: Commit**

```bash
git add app/Jarvis/Voice/PiperVoiceService.swift
git commit -m "feat(app): PiperVoiceModel — catalog client for the voice dropdown"
```

---

## Task 7: HUD dropdown

**Files:**
- Modify: `app/Jarvis/MenuBar/HUDView.swift`

- [ ] **Step 1: Add the model as state and load it on appear**

In `app/Jarvis/MenuBar/HUDView.swift`, add a `@StateObject` after the existing `@State private var micDown = false` (line 10):

```swift
    @StateObject private var piperVoices = PiperVoiceModel()
```

- [ ] **Step 2: Add the picker row to the layout**

In `body`, insert `voicePickerRow` between `settingsRow` and `commandField` (after line 23):

```swift
            settingsRow
            voicePickerRow
            commandField
```

And update the `.onAppear` (line 29) to also load voices:

```swift
        .onAppear {
            client.requestHealth(); client.requestRegistry(); inputFocused = true
            Task { await piperVoices.refresh() }
        }
```

- [ ] **Step 3: Define the row**

Add this computed property next to `settingsRow` (e.g. after the `chip(...)` helper, before `commandField`, around line 205):

```swift
    // Piper TTS voice selection. The menu shows the current voice name; voices
    // not yet downloaded are marked "⤓" and fetched on selection (spinner shown).
    private var voicePickerRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "waveform")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Theme.onSurfaceVariant)
            Picker("", selection: Binding(
                get: { piperVoices.selectedId },
                set: { id in Task { await piperVoices.select(id) } }
            )) {
                ForEach(piperVoices.voices) { v in
                    Text(v.downloaded ? v.name : "\(v.name)  ⤓").tag(v.id)
                }
            }
            .labelsHidden()
            .tint(Theme.primary)
            .font(Theme.body)
            .disabled(piperVoices.downloadingId != nil)

            if piperVoices.downloadingId != nil {
                ProgressView().controlSize(.mini)
            }
            Spacer()
            if let e = piperVoices.errorText {
                Text(e).font(Theme.mono).foregroundStyle(Theme.alert)
            }
        }
    }
```

- [ ] **Step 4: Verify (build in Task 9)**

The picker compiles with the app in Task 9. Proceed.

- [ ] **Step 5: Commit**

```bash
git add app/Jarvis/MenuBar/HUDView.swift
git commit -m "feat(app): voice dropdown row in the HUD"
```

---

## Task 8: Send the selected voice on synth

**Files:**
- Modify: `app/Jarvis/Voice/KokoroTTSService.swift:64`

- [ ] **Step 1: Include the voice id in the request body**

In `app/Jarvis/Voice/KokoroTTSService.swift`, replace the body-building line in `synth(_:)` (line 64):

```swift
        req.httpBody = try JSONSerialization.data(withJSONObject: ["input": text])
```

with:

```swift
        let voiceId = UserDefaults.standard.string(forKey: "piperVoice") ?? "en_GB-alan-medium"
        req.httpBody = try JSONSerialization.data(withJSONObject: ["input": text, "voice": voiceId])
```

- [ ] **Step 2: Commit**

```bash
git add app/Jarvis/Voice/KokoroTTSService.swift
git commit -m "feat(app): send selected Piper voice id on synthesis"
```

---

## Task 9: Build the app

**Files:** none (build verification)

- [ ] **Step 1: Regenerate the Xcode project (picks up the new Swift file)**

Run: `cd app && xcodegen generate`
Expected: `Created project at .../app/Jarvis.xcodeproj`. (If `xcodegen` is missing: `brew install xcodegen`.)

- [ ] **Step 2: Build**

Run:
```bash
cd app && xcodebuild -project Jarvis.xcodeproj -scheme Jarvis -configuration Debug \
  build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -20
```
Expected: `** BUILD SUCCEEDED **`. Fix any compile errors (most likely a Theme token name or a SwiftUI binding type) before continuing.

- [ ] **Step 3: Commit any project.pbxproj changes**

```bash
git add app/Jarvis.xcodeproj
git commit -m "chore(app): regenerate project with PiperVoiceService"
```

---

## Task 10: End-to-end check + docs

**Files:**
- Modify: `docs/VOICE.md`, `tts/README.md`

- [ ] **Step 1: Manual end-to-end (one download)**

Start the server and the app:
```bash
cd tts && ./.venv-piper/bin/python piper_server.py &   # :8082
cd app && open DerivedData/Build/Products/Debug/Jarvis.app 2>/dev/null || \
  xcodebuild -project Jarvis.xcodeproj -scheme Jarvis -configuration Debug -showBuildSettings >/dev/null
```
In the HUD: open the voice dropdown, pick a **not-downloaded** voice (e.g. "Ryan — American male"). Expect a spinner, then it becomes selectable; trigger a reply and confirm the new voice speaks. Pick it again later → no re-download (instant). Stop the server mid-download once and confirm the row reverts with an error and no `.part` file remains in `tts/voices/`.

- [ ] **Step 2: Update the docs**

In `docs/VOICE.md`, under "### Primary — Piper", append:

```markdown

The HUD has a **voice dropdown** (waveform icon, below the settings row): pick any voice from a curated English catalog (British + American, male + female). Voices download on demand into [tts/voices/](../tts/voices/) the first time they're selected (~60 MB each, shown with "⤓" until downloaded) and only the active voice is held in memory. The choice persists across launches; default stays `en_GB-alan`.
```

In `tts/README.md`, under "## Piper", append:

```markdown

### Voice catalog (HUD dropdown)
The server exposes `GET /voices` (catalog + downloaded status), `POST /voices/{id}/download`, and `GET /voices/{id}/status`. The app's dropdown lists a curated English set and downloads a voice's `.onnx`/`.onnx.json` on first selection. The active voice is chosen per request via the `voice` field of `/v1/audio/speech`; only one voice is resident at a time. The catalog lives in [piper_voices.py](piper_voices.py).
```

- [ ] **Step 3: Commit**

```bash
git add docs/VOICE.md tts/README.md
git commit -m "docs: document the Piper voice dropdown + catalog endpoints"
```

---

## Self-Review Notes

- **Spec coverage:** catalog (T1) · single-active manager (T2) · download-on-select with atomic write + status (T3) · `GET /voices`, download, status, per-request `voice` endpoints (T4) · smoke tests (T5) · `PiperVoiceService` client (T6) · HUD `Picker` (T7) · synth sends id (T8) · build (T9) · error-path manual check + docs (T10). All spec sections map to a task.
- **Error paths:** download failure reverts the Picker + cleans `.part` files (T3 run() + T6 catch); unknown/absent voice falls back instead of 500 (T2 synth_wav); server down → AVSpeech fallback unchanged; `/voices` unreachable → HUD keeps persisted selection (T6 refresh no-op).
- **Type consistency:** `voice_path`, `is_downloaded`, `voice_urls`, `start_download`, `download_state`, `VoiceManager.synth_wav(text, voice_id)`, `manager.loaded_id` used identically across server + tests. Swift `PiperVoiceModel.Voice{id,name,gender,downloaded}` matches the server's `catalog_with_status()` rows and the `/voices` `{voices:[...]}` shape. UserDefaults key `piperVoice` shared by HUD (T7), model (T6), and KokoroTTSService (T8).
```
