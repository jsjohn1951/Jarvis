# Piper voice dropdown — design

**Date:** 2026-06-16
**Status:** Approved (design); implementation plan pending

## Goal

Let the user pick the Piper TTS voice from a dropdown in the HUD, instead of the
single hardcoded `en_GB-alan-medium`. Voices come from a curated English catalog
and are downloaded on demand the first time they're selected.

## Scope

- **Piper only.** Kokoro stays env-var controlled (`KOKORO_VOICE`); not in this dropdown.
- **No orchestrator changes.** The app already POSTs synthesis requests straight to
  the TTS server on `:8082` (see [KokoroTTSService.swift](../../../app/Jarvis/Voice/KokoroTTSService.swift));
  the orchestrator is not in the TTS path.
- Two components change: the Piper server ([tts/piper_server.py](../../../tts/piper_server.py))
  and the macOS app (HUD + a small voice client + the synth call site).

### Decisions locked during brainstorming

| Question | Decision |
|----------|----------|
| What the dropdown controls | Piper voices only |
| Where the voice list comes from | Curated catalog + download-on-select |
| Catalog breadth | Curated English set (~8–12 en_GB + en_US, male & female, medium quality) |
| Download mechanics | Server downloads into `tts/voices/`; HUD polls a status endpoint |
| Runtime memory | Only the active voice held in RAM; swap on change |

### Out of scope (YAGNI)

Kokoro voices in the dropdown; multi-voice RAM caching; non-English voices;
per-voice speed/pitch; deleting downloaded voices.

## Architecture

### A. Piper server — catalog + manager + downloader

- **Catalog** — a static dict of ~8–12 curated English voices, defined *in the
  server* as the single source of truth for download URLs. Each entry:
  `id` (e.g. `en_GB-alan-medium`), display `name`, `locale`, `gender`, `quality`,
  and the two Hugging Face URLs (`.onnx`, `.onnx.json`). The HUD fetches this list
  rather than hardcoding it, so the dropdown can never offer a voice the server
  doesn't understand.
- **VoiceManager** — owns the single loaded `PiperVoice` plus a `threading.Lock`.
  `synthesize(text, voice_id)`: if `voice_id` differs from the loaded voice, load
  the new one and drop the old (only the active voice stays resident, ~60 MB). The
  lock guards load+synth because FastAPI runs sync endpoints in a threadpool, so
  concurrent requests are possible.
- **Downloader** — fetches the two files into [tts/voices/](../../../tts/voices/)
  on a background thread, tracking per-voice state: `absent → downloading → ready → error`.
  Downloads to a `.part` temp file and atomically renames on success, so a killed
  download never leaves a truncated `.onnx` that loads as garbage. "File present"
  reliably means "playable" — the invariant the `downloaded` flag promises the HUD.

### B. App — Picker + voice client

- **`PiperVoiceService.swift`** (new, next to [KokoroTTSService.swift](../../../app/Jarvis/Voice/KokoroTTSService.swift))
  — calls `GET /voices`, `POST /voices/{id}/download`, `GET /voices/{id}/status`.
- **`Picker` in [HUDView.swift](../../../app/Jarvis/MenuBar/HUDView.swift)** —
  populated from `GET /voices`; not-yet-downloaded voices marked with a download
  glyph. Selection persisted via `@AppStorage("piperVoice")`, defaulting to
  `en_GB-alan-medium` (already downloaded, so first run is unchanged).
- **[KokoroTTSService.swift](../../../app/Jarvis/Voice/KokoroTTSService.swift)
  `synth()`** — adds `"voice": selectedId` to the POST body (currently sends only
  `{"input": text}` at line 64).

## Endpoints (`:8082`)

| Endpoint | Purpose |
|----------|---------|
| `GET /voices` | Returns the catalog, each entry with `downloaded: bool`. HUD populates the dropdown. |
| `POST /voices/{id}/download` | Starts a background download if files absent. Returns immediately. |
| `GET /voices/{id}/status` | `{state, error?}` where state ∈ `absent\|downloading\|ready\|error`. HUD polls after triggering a download. |
| `POST /v1/audio/speech` *(changed)* | Honors `voice`: resolves id → file, lazy-swaps the loaded model, synthesizes. |
| `GET /health` *(unchanged)* | Already reports the current voice. |

## Data flow — selection in the HUD

1. User opens the Picker → list from `GET /voices`, undownloaded voices marked.
2. Picks a **downloaded** voice → persist immediately; done.
3. Picks a **not-downloaded** voice → `POST …/download`, show a spinner on that row,
   poll `…/status` until `ready`, then persist. On `error`, revert to the previous
   selection and surface the message.
4. Every subsequent synth POST carries `"voice": selectedId`. The server swaps the
   loaded model on the first sentence of a reply (constant for the rest → one swap
   per voice change).

There is **no server-side selection state**. The `voice` field on each synth request
is the selection; the loaded model is a one-entry cache keyed by "last voice asked
for." This avoids a select/active state machine that could drift from what the HUD
believes is active.

## Error handling

| Failure | Behavior |
|---------|----------|
| Download fails (network/404) | Status → `error` with message; HUD reverts Picker to previous voice and shows the error. `.part` + atomic rename means no corrupt file is left behind. |
| Synth names a not-downloaded / unknown voice | No 500 — server logs a warning and falls back to the currently-loaded voice. HUD gates on `ready`, so this is defense-in-depth. |
| Server down entirely | Unchanged — `synth()` throws on the first sentence; caller falls back to `AVSpeechSynthesizer` ([KokoroTTSService.swift:50](../../../app/Jarvis/Voice/KokoroTTSService.swift#L50)). |
| `GET /voices` unreachable | HUD shows just the default voice and stays usable. |
| Voice swap mid-stream | `threading.Lock` around load+synth; a concurrent request waits rather than racing a half-loaded model. |

## Testing

Framework-less, matching the repo (bash smoke + tsx/python scripts):

- **Extend [tts/smoke-piper.sh](../../../tts/smoke-piper.sh)** — assert `GET /voices`
  returns the catalog with the default marked `downloaded: true`, and that a synth
  POST with an explicit `"voice": "en_GB-alan-medium"` returns a valid WAV.
- **Python voice-swap test** — load voice A, synth; swap to a second *already-present*
  voice file, synth; assert both produce valid non-empty WAVs and only one is held
  at a time. Uses existing files in `voices/`; no network.
- **Download path** — excluded from automated tests (network + ~60 MB each). Verified
  manually once: pick an undownloaded voice, watch it download and become selectable;
  eyeball the `.part`→atomic-rename behavior.

## Default & startup

Default voice remains `en_GB-alan-medium`, already present in [tts/voices/](../../../tts/voices/).
`@AppStorage("piperVoice")` defaults to that id, and `PIPER_VOICE` /
`start-jarvis.sh` behavior is unchanged. First run looks identical to today.
