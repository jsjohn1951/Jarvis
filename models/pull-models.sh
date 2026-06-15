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

# --- optional specialists (uncomment to fetch; hot-swapped, not co-loaded) ---
# pull "unsloth/Qwen3.5-4B-GGUF" "Qwen3.5-4B-Q4_K_M.gguf"   # bigger local agent

echo "[done] models in $DEST"
ls -lh "$DEST"/*.gguf
