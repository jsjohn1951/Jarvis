#!/usr/bin/env bash
# Build llama.cpp as an XCFramework for the iOS app's on-device model tier.
#
# Clones ggml-org/llama.cpp at a PINNED tag (reproducible laptop builds), runs its
# supported build-xcframework.sh (device + simulator + macOS slices, Metal on), and
# copies the result to app/Vendor/llama.xcframework — which project.yml embeds into
# the JarvisMobile target. Both the clone and the framework are gitignored; re-run
# this script on a fresh checkout or to bump the pin.
#
# Idempotent: skips the build when the framework already exists at the pinned tag.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Bump deliberately; the LlamaEngine.swift wrapper only uses the stable C core
# (llama_model_load_from_file / llama_decode / sampler chain / chat template).
LLAMA_TAG="${LLAMA_TAG:-b9976}"

VENDOR="$ROOT/app/Vendor"
CLONE="$VENDOR/llama.cpp"
OUT="$VENDOR/llama.xcframework"
STAMP="$OUT/.jarvis-tag"

if [[ -d "$OUT" && -f "$STAMP" && "$(cat "$STAMP")" == "$LLAMA_TAG" ]]; then
  echo "[llama-xc] llama.xcframework already built at $LLAMA_TAG — nothing to do"
  exit 0
fi

mkdir -p "$VENDOR"
if [[ ! -d "$CLONE/.git" ]]; then
  echo "[llama-xc] cloning llama.cpp @ ${LLAMA_TAG}…"
  git clone --depth 1 --branch "$LLAMA_TAG" https://github.com/ggml-org/llama.cpp "$CLONE"
else
  echo "[llama-xc] fetching ${LLAMA_TAG}…"
  git -C "$CLONE" fetch --depth 1 origin tag "$LLAMA_TAG"
  git -C "$CLONE" checkout -f "$LLAMA_TAG"
fi

echo "[llama-xc] building XCFramework (this takes a few minutes)…"
(cd "$CLONE" && bash build-xcframework.sh)

rm -rf "$OUT"
cp -R "$CLONE/build-apple/llama.xcframework" "$OUT"
echo "$LLAMA_TAG" > "$STAMP"
echo "[llama-xc] → $OUT"
