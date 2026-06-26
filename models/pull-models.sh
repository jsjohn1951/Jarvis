#!/usr/bin/env bash
# Pull GGUF models Jarvis uses into ~/models. Requires the `hf` CLI
# (pip install -U "huggingface_hub[cli]"). brew binaries are fine here —
# this only downloads files; Metal acceleration comes from your source-built
# llama.cpp, not from these blobs.
set -euo pipefail
DEST="${MODELS_DIR:-$HOME/models}"
mkdir -p "$DEST"

pull() { # repo file
  local repo="$1" file="$2"
  if [[ -f "$DEST/$file" ]]; then echo "[have] $file"; return; fi
  echo "[pull] $repo :: $file"
  hf download "$repo" "$file" --local-dir "$DEST"
}

# Speculative-decoding draft for Qwen3.5-9B (vocab 248320, verified compatible).
pull "unsloth/Qwen3.5-2B-GGUF" "Qwen3.5-2B-Q4_K_M.gguf"

# Google Gemma 3 4B — the DEFAULT conversation tier (served always-on on :8083 by
# scripts/llama-convo.sh). Small/fast (~3 GB) and a natural voice for chat/dialog. Tool
# use is best-effort (the router's Qwen3 <tool_call> translation isn't Gemma-native — see
# docs/MODELS.md), which is fine: conversation doesn't call tools. Qwen3.5-9B stays the
# wired auto-fallback for tool-using agents.
pull "unsloth/gemma-3-4b-it-GGUF" "gemma-3-4b-it-Q4_K_M.gguf"

# Qwen2.5-Coder-7B-Instruct — the dedicated local CODER model. Hot-swapped onto :8080
# (displacing the 9B) while a coding project runs locally, served with continuous batching
# so the PM pipeline can fan out coder tasks. ~4.7 GB; same Qwen tool-call format the router
# already bridges.
pull "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF" "qwen2.5-coder-7b-instruct-q4_k_m.gguf"

# --- optional specialists (uncomment to fetch; hot-swapped, not co-loaded) ---
# pull "unsloth/Qwen3.5-4B-GGUF" "Qwen3.5-4B-Q4_K_M.gguf"   # bigger local agent

echo "[done] models in $DEST"
ls -lh "$DEST"/*.gguf
