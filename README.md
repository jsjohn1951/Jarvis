# JARVIS

A native macOS, Iron-Man-themed voice + text assistant that orchestrates local and cloud AI agents on top of your existing `claude-hybrid` setup. Wake word, natural neural voice, persistent memory, screen awareness, and per-app music dimming — all running locally where it can.

```
You ──voice/text──► Jarvis.app ──ws:7777──► Orchestrator ──► router :9090 ─┬─► Anthropic (Sonnet, your Pro plan)
                    (SwiftUI HUD)            (Node/Agent SDK)               └─► llama.cpp :8080 / :8081 (Qwen)
                         │  Kokoro TTS :8082 (British neural voice)
                         │  memory/ + personality/ (markdown)
```

- **Jarvis.app** — menu-bar SwiftUI app. Wake word "Jarvis" (with addressee check), follow-up conversation, push-to-talk, text box, screen capture, music dimming, Sir/Ma'am detection.
- **Orchestrator** — Node/TS daemon (Claude Agent SDK) that routes commands to agents, retains conversation context, and curates long-term memory.
- **Local models** — 9B (`:8080`) for hard work, 2B "quick" tier (`:8081`) for instant answers, Kokoro voice (`:8082`).

---

## Dependencies

These must exist on the machine (the base `claude-hybrid` stack is assumed already working):

| Dependency | Version / notes | Check |
|------------|-----------------|-------|
| macOS | 26 (Tahoe) | `sw_vers` |
| Xcode + Swift | Swift 6+ (full Xcode) | `swift --version` |
| Node | ≥ 22 | `node -v` |
| `uv` + Python | Python 3.12 (for the Kokoro voice venv) | `uv --version`, `python3.12 --version` |
| Homebrew `xcodegen` | generates the Xcode project | `xcodegen --version` |
| `hf` CLI | downloads GGUF models | `hf --version` |
| llama.cpp | **built from source with Metal** at `~/llama.cpp` (brew bottles may lack Metal) | `ls ~/llama.cpp/build/bin/llama-server` |
| Router | `~/.claude/router/` + its venv (the `claude-hybrid` proxy on `:9090`) | — |
| **Claude Pro login** | authenticated via the `claude` CLI — **no API key**. Keep `ANTHROPIC_API_KEY` unset. | `claude` → `/login` |

Install the missing tools:
```bash
brew install xcodegen
pip install -U "huggingface_hub[cli]"          # provides `hf`
# uv: https://docs.astral.sh/uv/  (curl -LsSf https://astral.sh/uv/install.sh | sh)
```

---

## Installation (one time)

```bash
cd ~/Desktop/jarvis

# 1. Orchestrator deps
cd orchestrator && npm install && cd ..

# 2. Local models — the 2B (quick tier + speculative draft). The 9B is your existing one.
./models/pull-models.sh

# 3. Natural voice (Kokoro) — venv + model files
cd tts
uv venv --python 3.12 .venv
uv pip install -r requirements.txt
curl -sL -o kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx
curl -sL -o voices-v1.0.bin  https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin
cd ..

# 4. Build the app
cd app && xcodegen generate && xcodebuild -scheme Jarvis -derivedDataPath ./DerivedData build && cd ..
```

---

## Running

```bash
./scripts/start-jarvis.sh    # 9B + router, 2B quick tier, Kokoro voice, orchestrator, opens the app
./scripts/stop-jarvis.sh     # stop everything (or ⏻ / ⌘Q in the HUD)
```

**Ports:** `8080` llama 9B · `8081` llama 2B (quick) · `8082` Kokoro voice · `9090` router · `7777` orchestrator.

**First-run permissions** (macOS will prompt; grant in System Settings → Privacy & Security if missed):
- **Microphone** + **Speech Recognition** — voice input (first mic use).
- **Automation** (Spotify / Music) — music dimming + "what's playing" (first dim).
- **Screen Recording** — "look at my screen" (first screen capture).

---

## Usage

- **Wake word:** say **"Jarvis, …"**. The 2B judges whether you actually addressed it (vs. mentioning the name) before replying.
- **Follow-up:** after a reply it stays conversational ~45 s — ask follow-ups with no wake word (HUD shows ● LISTENING). It remembers the conversation.
- **Push-to-talk:** hold the mic button, or ⌥Space from anywhere (needs Input Monitoring).
- **Text:** type in the popover.
- **"Look at my screen":** the eye button, or say it — screenshots to the vision agent.
- **"What's playing":** reads the current Spotify/Apple Music track.
- **Memory:** Jarvis remembers across turns and sessions. Say "remember …" to pin something; "forget that" / "new conversation" to reset short-term context. Edit `personality/*.md` to change its character; long-term facts live in `memory/long-term/*.md`.
- **HUD settings:** **WAKE / FOLLOW / VOICE** toggles, **ADDR** (Auto/Sir/Ma'am/None form of address), **AUDIO** (Mix/Dim/Mute background music) + dim level, the **Agent Registry** (model hot-swap), and **Quit**.

---

## Layout

| Path | What |
|------|------|
| [app/](app/) | SwiftUI menu-bar app (HUD, voice, screen, audio) |
| [orchestrator/](orchestrator/) | Node/TS daemon — agents, dispatch, memory |
| [tts/](tts/) | Kokoro neural voice server |
| [scripts/](scripts/) | llama.cpp launch + start/stop lifecycle |
| [models/](models/) | model-pull helpers |
| [memory/](memory/) | short-term buffer + hub-and-spoke long-term memory (markdown) |
| [personality/](personality/) | Jarvis persona (markdown, edit to taste) |
| [docs/](docs/) | architecture, design, setup, voice, models, agents, memory |

## Documentation
[ARCHITECTURE](docs/ARCHITECTURE.md) · [SETUP](docs/SETUP.md) · [MEMORY](docs/MEMORY.md) · [VOICE](docs/VOICE.md) · [MODELS](docs/MODELS.md) · [AGENTS](docs/AGENTS.md) · [DESIGN](docs/DESIGN.md) · [TROUBLESHOOTING](docs/TROUBLESHOOTING.md)

## License
Jarvis is licensed under the [Apache License 2.0](LICENSE) — this covers the original
Jarvis code only. The AI model weights, inference engines, and TTS engines it uses are
not bundled here and remain under their own licenses (some restrict commercial use).
See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) and [NOTICE](NOTICE).

> Auth reminder: cloud work uses your **Claude Pro subscription** via the `claude` login. Never set `ANTHROPIC_API_KEY`. The quick tier, voice, memory capture/retrieval, and all model work default to **$0 / offline**; only cloud agents and long-term consolidation use the subscription.
