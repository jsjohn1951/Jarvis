# Voice

All voice is **on-device** — no cloud STT, no Whisper build, no Python audio deps.

## Speech-to-text
- `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`, fed by `AVAudioEngine.inputNode` ([SpeechService.swift](../app/Jarvis/Voice/SpeechService.swift)). Fully local on Apple Silicon.
- *Implementation note:* macOS 26 also ships the newer `SpeechAnalyzer`/`SpeechTranscriber` API. We lead with `SFSpeechRecognizer` because it's mature and reliable; swapping in `SpeechAnalyzer` later is isolated to `SpeechService`.
- macOS has **no `AVAudioSession`** — we tap `AVAudioEngine` directly and request mic via `AVCaptureDevice.requestAccess(for: .audio)`.

## Wake word — "Jarvis" (with addressee check)
- Toggle **WAKE** in the HUD. Continuous on-device recognition listens for the name **"Jarvis"** ([VoiceController.swift](../app/Jarvis/Voice/VoiceController.swift)); on a match it captures the utterance and ends on ~1.2 s of silence.
- **Addressee evaluation:** because "Jarvis" also occurs in normal speech, the captured utterance is sent to the local 2B (`isAddressed`, [dispatcher.ts](../orchestrator/src/dispatcher.ts)), which judges whether you're *talking to* Jarvis vs. *about* it. Addressed → it answers (wake word stripped wherever it appears). Not addressed → an `ignored` event, Jarvis stays silent and keeps listening. The check is local + free (~one short 2B call).
  - e.g. *"Jarvis, open the terminal"* → acts · *"I'll ask Jarvis later"* → ignored.
- Jarvis pauses the mic while it's speaking (TTS) so it doesn't hear itself.

## Follow-up window (no wake word for follow-ups)
- Toggle **FOLLOW** in the HUD (on by default). After Jarvis replies, it stays conversational for **~30 s** — you can ask follow-ups *without* saying "Hey Jarvis". The HUD shows **● LISTENING** during the window; each thing you say resets the 30 s. When it lapses with no command, it returns to wake-word listening.
- This is the pragmatic alternative to full open-mic: you address Jarvis once (by name or the mic button), then talk naturally. It avoids the constant false-activations of always-on addressee detection. *(Within the window, any speech is treated as directed at Jarvis — the window just auto-closes when idle.)*

## Push-to-talk
- **Hold the mic button** in the HUD to talk; release to send. (It also auto-ends on silence, so a tap-then-speak works too.)
- **Global hotkey** (default **⌥Space**) via [Hotkey.swift](../app/Jarvis/Voice/Hotkey.swift) starts a one-shot listen from anywhere. System-wide keyboard monitoring requires the **Input Monitoring** privacy permission (System Settings → Privacy & Security → Input Monitoring). Without it, the hotkey only fires when the popover is focused; the mic button and wake word work regardless.

## Speaking waveform (HUD)
While you speak, the HUD's transcript panel shows a **live audio waveform** instead of echoing your transcribed words — only **Jarvis's reply** is ever shown as text. The bars are driven by per-buffer RMS loudness ([AudioLevelMeter.swift](../app/Jarvis/Voice/AudioLevelMeter.swift)), which tees off the same mic tap that feeds gender detection (so it inherits `SpeechService`'s off-main threading). [WaveformView.swift](../app/Jarvis/MenuBar/WaveformView.swift) renders the rolling `VoiceController.micLevels` window.

## Text-to-speech
Two engines, chosen automatically. Text is cleaned first — **code fences, markdown, and emoji stripped**, length capped — so Jarvis narrates, never reading code (or "robot face") aloud. Toggled by **VOICE** in the HUD.

### Primary — Piper (default neural voice)
A local [Piper](https://github.com/OHF-Voice/piper1-gpl) server provides the default **British-male** voice **`en_GB-alan`** (Received Pronunciation). The app POSTs the reply to `:8082` and plays the returned WAV ([KokoroTTSService.swift](../app/Jarvis/Voice/KokoroTTSService.swift)) — the same OpenAI-compatible contract, so the app is engine-agnostic. Runs on Apple Silicon. Setup + run: [tts/README.md](../tts/README.md) (started automatically by `start-jarvis.sh`).

The HUD has a **voice dropdown** (waveform icon, below the settings row): pick any voice from a curated English catalog (British + American, male + female). Voices download on demand into [tts/voices/](../tts/voices/) the first time they're selected (~60 MB each, shown with "⤓" until downloaded) and only the active voice is held in memory. The choice persists across launches; default stays `en_GB-alan`.

### Alternative — Kokoro
Set `JARVIS_TTS_ENGINE=kokoro` to use [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0) instead — a natural British-male voice, default **`bm_george`** (alternatives `bm_fable`, `bm_lewis`, `bm_daniel`), via onnxruntime's CoreML provider (~0.75 real-time on M3 Pro). Both engines serve `:8082`; only one runs at a time.

### Fallback — AVSpeechSynthesizer
If the TTS server (Piper or Kokoro) is down, the app falls back to `AVSpeechSynthesizer` ([TTSService.swift](../app/Jarvis/Voice/TTSService.swift)). Its chooser (`bestJarvisVoice()`) prefers a British-male voice (picks **Daniel (en-GB)** here). For a less robotic fallback, download an enhanced voice once: **System Settings → Accessibility → Spoken Content → System Voice → Manage Voices → English (UK) → Daniel (Enhanced)** (or Oliver/Arthur/Jamie).

> Note: the real J.A.R.V.I.S. voice (Paul Bettany) is a copyrighted performance — not available as open source and not cloned here. The Piper `en_GB-alan` and Kokoro British-male voices are the open, license-respecting alternatives.

## Background music — dim, not mute
Toggle **AUDIO** in the HUD: **Mix** (leave other audio alone), **Dim** (lower Spotify/Apple Music to the slider %, default 30%, while Jarvis speaks, then restore), **Mute**. Implemented in [AudioDucker.swift](../app/Jarvis/Voice/AudioDucker.swift) via Apple Events — so it dims *only* those players (other sources like browser audio are left alone). Needs Automation permission.

## Form of address — Sir / Ma'am
**ADDR** setting: **Auto** (default) detects the speaker's pitch on-device ([VoiceGender.swift](../app/Jarvis/Voice/VoiceGender.swift)) — low → "Sir", high → "Ma'am", ambiguous → neutral — or force **Sir / Ma'am / None**. The resolved honorific is sent with the prompt and woven into the persona. Voice-based inference is imperfect; it stays neutral when unsure and the manual override is always available.

## Screen & now-playing
- **Look at my screen:** the eye button or "look at my screen" captures a screenshot ([ScreenContext.swift](../app/Jarvis/Context/ScreenContext.swift)) → vision agent. Needs Screen Recording permission.
- **Control on-screen apps:** desktop-control phrasing ("in VSCode…", "click…", "type…") also attaches a screenshot and routes to the `desktop` agent, which can act on the app it sees (see [AGENTS.md](AGENTS.md) and [Actuator.swift](../app/Jarvis/Context/Actuator.swift)). Keystrokes into other apps need **Accessibility** permission.
- **What's playing:** returns the current Spotify/Apple Music track ([NowPlaying.swift](../app/Jarvis/Context/NowPlaying.swift)).

## Permissions (granted on first use)
- **Microphone** + **Speech Recognition** — prompted automatically; strings are in the app's Info.plist. If denied, the HUD shows "mic denied — enable in System Settings".
- **Input Monitoring** (optional) — only for the system-wide hotkey.
