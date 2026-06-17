# Third-Party Licenses & Notices

Jarvis itself is licensed under the Apache License 2.0 (see [LICENSE](LICENSE) and
[NOTICE](NOTICE)). That license covers **only the original Jarvis code** in this
repository (the orchestrator, the macOS app, the TTS servers, scripts, and the
memory/personality structure).

**Nothing third-party is vendored into this repository.** No third-party source code
and no AI model weights are committed here (`.gitignore` excludes `*.gguf`, `*.onnx`,
and `*.bin`). Every component below is one of:

- an **npm/pip dependency** installed separately, or
- an **AI model weight** downloaded at runtime, or
- a **separate process / external binary** Jarvis talks to over a local socket.

Each retains its own license, which governs your use of it regardless of Jarvis's
Apache-2.0 license. The summaries below reflect the upstream projects' stated terms
at the time of writing — **verify the current upstream license before any commercial
or redistributive use**, especially for the AI model weights.

---

## 1. Node / TypeScript dependencies

From [`orchestrator/package.json`](orchestrator/package.json) and
[`editor-extension/package.json`](editor-extension/package.json). Installed via npm,
not vendored.

| Component | Where | License | Notes |
|-----------|-------|---------|-------|
| `@anthropic-ai/claude-agent-sdk` | orchestrator (runtime) | **Proprietary — © Anthropic PBC, all rights reserved** | Use is subject to Anthropic's legal terms: <https://code.claude.com/docs/en/legal-and-compliance>. Not open source. |
| `ws` | orchestrator + editor-extension (runtime) | MIT | WebSocket transport. |
| `typescript` | both (dev) | Apache-2.0 | Build-time only. |
| `tsx` | orchestrator (dev) | MIT | Build/run-time only. |
| `@vscode/vsce` | editor-extension (dev) | MIT | Extension packaging only. |
| `@types/node`, `@types/ws`, `@types/vscode` | both (dev) | MIT | Type stubs only. |

> The `@anthropic-ai/claude-agent-sdk` dependency is **proprietary**. Apache-2.0 on
> Jarvis does not grant any rights in it; its own terms apply.

## 2. Python / TTS dependencies

From [`tts/requirements.txt`](tts/requirements.txt) and
[`tts/requirements-piper.txt`](tts/requirements-piper.txt). Installed via pip into a
venv, not vendored. The TTS engines run as **separate processes** that Jarvis reaches
over HTTP on `:8082` — see [`tts/README.md`](tts/README.md).

| Component | License | Notes |
|-----------|---------|-------|
| `piper-tts` | **GPL-3.0** | Default TTS engine. Runs as a standalone process behind an HTTP boundary; Jarvis does not link or embed it, so its copyleft does not extend to Jarvis's own code. If you ever bundle or statically link Piper, re-evaluate this. |
| `kokoro-onnx` | Apache-2.0 (wrapper) | Alternate TTS engine; drives the Kokoro ONNX model below. |
| `fastapi` | MIT | TTS HTTP server framework. |
| `uvicorn` | BSD-3-Clause | ASGI server. |
| `soundfile` | BSD-3-Clause | WAV I/O. |
| ONNX Runtime (via `kokoro-onnx`) | MIT | Inference runtime (CoreML provider on Apple Silicon). |

## 3. AI model weights (downloaded at runtime — not in this repo)

Pulled by [`models/pull-models.sh`](models/pull-models.sh) and the TTS setup; see
[`docs/MODELS.md`](docs/MODELS.md). **These are the licenses most likely to restrict
commercial use — review them carefully.**

| Model | Source | License | Notes |
|-------|--------|---------|-------|
| Qwen 3.5 9B (`Qwen3.5-9B-Q4_K_M.gguf`) | external `~/llama.cpp` (not fetched by this repo) | Apache-2.0 / MIT (per the Qwen release) | Primary local model; lives outside this repo. Confirm the exact license of the specific GGUF you run. |
| Qwen 3.5 2B (`Qwen3.5-2B-Q4_K_M.gguf`) | `unsloth/Qwen3.5-2B-GGUF` | Apache-2.0 / MIT (per the Qwen release) | "Quick" tier / speculative-decoding draft. |
| Gemma 3 4B (`gemma-3-4b-it-Q4_K_M.gguf`) | `unsloth/gemma-3-4b-it-GGUF` | **Gemma Terms of Use** (not an OSI license) | Selectable hot-swap model. The Gemma terms impose use restrictions — review <https://ai.google.dev/gemma/terms> before commercial use or redistribution. |
| Kokoro v1.0 (`kokoro-v1.0.onnx`) + `voices-v1.0.bin` | `thewh1teagle/kokoro-onnx` releases | Apache-2.0 (Kokoro-82M) | Optional TTS voice model. |
| Piper voice `en_GB-alan-medium` (`.onnx` + `.onnx.json`) | `rhasspy/piper-voices` | Permissive (per the voice's model card) | Voice weights are distinct from, and not GPL like, the Piper engine. |

## 4. External tools & binaries (depended on, not vendored)

Jarvis supervises or talks to these; it does not contain or distribute them.

| Tool | License | Role |
|------|---------|------|
| llama.cpp (`~/llama.cpp`, source-built) | MIT | Runs `llama-server` for local inference (`:8080`/`:8081`). |
| xcodegen | MIT | Generates the Xcode project from `app/project.yml`. |
| Router proxy (`~/.claude/router/proxy.py`) | external — not in this repo | Routes requests by model name; outside Jarvis's distribution. |

## 5. macOS application (`app/`)

The SwiftUI app has **no third-party Swift Package Manager dependencies** — it uses
only Apple system frameworks (SwiftUI, Speech, AVFoundation, ScreenCaptureKit, etc.),
which are governed by Apple's SDK/OS license terms.

---

*This manifest is informational and is not legal advice. Component licenses can change
between versions; confirm the current upstream terms for the exact versions you ship.*
