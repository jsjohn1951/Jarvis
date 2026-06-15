# Setup

Full dependency list, installation, and running instructions now live in the top-level [README](../README.md). This file covers the first-run permissions and a quick reference.

## Quick reference
```bash
# install (one time) — see README for details
cd orchestrator && npm install && cd ..
./models/pull-models.sh
cd tts && uv venv --python 3.12 .venv && uv pip install -r requirements.txt && cd ..   # + download model files (README)
cd app && xcodegen generate && xcodebuild -scheme Jarvis -derivedDataPath ./DerivedData build && cd ..

# run / stop
./scripts/start-jarvis.sh
./scripts/stop-jarvis.sh
```

## Auth
Cloud agents use your **Claude Pro subscription** via the `claude` CLI (`claude` → `/login`). **Not** an API key — keep `ANTHROPIC_API_KEY` unset (a stray key overrides the subscription). Quick tier, voice, and memory capture/retrieval are 100% local.

## Permissions (granted via macOS prompts on first use)
The app runs **without App Sandbox** (personal build); these are gated by TCC:
- **Microphone** + **Speech Recognition** — voice input.
- **Automation** (Spotify / Apple Music) — music dim + "what's playing".
- **Screen Recording** — "look at my screen".
- **Input Monitoring** (optional) — the global ⌥Space push-to-talk hotkey.

`Info.plist` declares `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`, `NSAppleEventsUsageDescription`, `NSScreenCaptureUsageDescription`. The app is menu-bar-only (no Dock icon).
