# Setup

## Prerequisites

Already present on the target machine (verified):
- macOS 26 (Tahoe), Apple Silicon (M3 Pro, 18 GB)
- Xcode + Swift 6 (`xcodebuild -version`)
- Node 24 (`node -v`)
- llama.cpp built **with Metal** at `~/llama.cpp/build/bin/`
- The router at `~/.claude/router/` and its venv
- `Qwen3.5-9B-Q4_K_M.gguf` in `~/models/`
- **Claude Pro subscription** logged in via the `claude` CLI (run `claude`, complete `/login` if prompted). Hybrid agents authenticate through this — **not** an API key. Ensure `ANTHROPIC_API_KEY` is unset (a stray key overrides the subscription).

Install if missing:
- **xcodegen** (to generate the Xcode project from `app/project.yml`): `brew install xcodegen`
- **Hugging Face CLI** (to pull models): `pip install -U "huggingface_hub[cli]"` → `hf` *(note: brew binaries may lack Metal; this only fetches files, so brew is fine here)*

## First run

```bash
# 1) Optimized local model (speculative decoding). See docs/MODELS.md.
./scripts/llama-server-optimized.sh

# 2) Orchestrator
cd orchestrator
npm install
npm run dev            # WebSocket on ws://127.0.0.1:7777

# 3) App
cd ../app
xcodegen generate     # produces Jarvis.xcodeproj from project.yml
open Jarvis.xcodeproj  # ⌘R to run
```

On first launch macOS will prompt for **Microphone** and **Speech Recognition** permission — grant both (required for voice). The app appears in the menu bar (no Dock icon).

## Permissions

Jarvis declares, in `Info.plist`:
- `NSMicrophoneUsageDescription`
- `NSSpeechRecognitionUsageDescription`

and requests the outgoing-network + audio-input entitlements (it talks to the local orchestrator on `:7777`).
</content>
