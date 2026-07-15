#!/usr/bin/env bash
# Build sherpa-onnx as an XCFramework + fetch the Piper voice for on-device iOS TTS.
#
# Clones k2-fsa/sherpa-onnx at a PINNED tag (reproducible laptop builds), runs its
# supported build-ios.sh (static libs, device + simulator slices), and copies into
# app/Vendor/ everything project.yml references for the JarvisMobile target:
#
#   sherpa-onnx.xcframework        static TTS engine (linked, not embedded)
#   onnxruntime.xcframework        static ONNX runtime it depends on
#   sherpa-onnx-headers/           C headers for the bridging header import
#   SherpaOnnxSwift/SherpaOnnx.swift   Swift wrapper vendored from the SAME
#                                  checkout so struct fields match the C headers
#   vits-piper-en_US-joe-medium/   the voice: .onnx + tokens.txt + espeak-ng-data
#
# Everything under app/Vendor/ is gitignored; re-run on a fresh checkout or to
# bump the pin. Idempotent: skips work already done at the pinned tag.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Bump deliberately, and only together: LocalPiperTTS.swift talks to the C API
# through the vendored SherpaOnnx.swift, which must come from this same tag.
SHERPA_TAG="${SHERPA_TAG:-v1.13.4}"

VOICE_ID="vits-piper-en_US-joe-medium"
VOICE_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${VOICE_ID}.tar.bz2"

VENDOR="$ROOT/app/Vendor"
CLONE="$VENDOR/sherpa-onnx"
OUT="$VENDOR/sherpa-onnx.xcframework"
STAMP="$OUT/.jarvis-tag"

mkdir -p "$VENDOR"

if [[ -d "$OUT" && -f "$STAMP" && "$(cat "$STAMP")" == "$SHERPA_TAG" ]]; then
  echo "[sherpa-tts] sherpa-onnx.xcframework already built at $SHERPA_TAG — skipping build"
else
  if [[ ! -d "$CLONE/.git" ]]; then
    echo "[sherpa-tts] cloning sherpa-onnx @ ${SHERPA_TAG}…"
    git clone --depth 1 --branch "$SHERPA_TAG" https://github.com/k2-fsa/sherpa-onnx "$CLONE"
  else
    echo "[sherpa-tts] fetching ${SHERPA_TAG}…"
    git -C "$CLONE" fetch --depth 1 origin tag "$SHERPA_TAG"
    git -C "$CLONE" checkout -f "$SHERPA_TAG"
  fi

  echo "[sherpa-tts] building XCFramework (this takes a while)…"
  (cd "$CLONE" && ./build-ios.sh)

  echo "[sherpa-tts] copying artifacts → app/Vendor/…"
  rm -rf "$OUT" "$VENDOR/onnxruntime.xcframework" "$VENDOR/sherpa-onnx-headers" "$VENDOR/SherpaOnnxSwift"
  cp -R "$CLONE/build-ios/sherpa-onnx.xcframework" "$OUT"

  # onnxruntime is downloaded by build-ios.sh into a versioned subdir — find it.
  ORT="$(find "$CLONE/build-ios" -maxdepth 3 -type d -name 'onnxruntime.xcframework' | head -1)"
  [[ -n "$ORT" ]] || { echo "[sherpa-tts] onnxruntime.xcframework not found under build-ios/" >&2; exit 1; }
  cp -R "$ORT" "$VENDOR/onnxruntime.xcframework"

  # Flatten the C headers out of the xcframework (per-slice layout varies) so
  # HEADER_SEARCH_PATHS can point at one stable dir.
  HDR_SRC="$(find "$OUT" -type d -path '*sherpa-onnx/c-api' | head -1)"
  [[ -n "$HDR_SRC" ]] || { echo "[sherpa-tts] c-api headers not found in xcframework" >&2; exit 1; }
  mkdir -p "$VENDOR/sherpa-onnx-headers/sherpa-onnx/c-api"
  cp "$HDR_SRC"/*.h "$VENDOR/sherpa-onnx-headers/sherpa-onnx/c-api/"

  mkdir -p "$VENDOR/SherpaOnnxSwift"
  cp "$CLONE/swift-api-examples/SherpaOnnx.swift" "$VENDOR/SherpaOnnxSwift/SherpaOnnx.swift"

  echo "$SHERPA_TAG" > "$STAMP"
fi

if [[ -f "$VENDOR/$VOICE_ID/tokens.txt" && -d "$VENDOR/$VOICE_ID/espeak-ng-data" ]]; then
  echo "[sherpa-tts] voice $VOICE_ID already present — skipping download"
else
  echo "[sherpa-tts] downloading voice ${VOICE_ID}…"
  rm -rf "$VENDOR/$VOICE_ID"
  curl -fL --retry 3 "$VOICE_URL" | tar -xj -C "$VENDOR"
  [[ -f "$VENDOR/$VOICE_ID/tokens.txt" ]] || { echo "[sherpa-tts] voice extract failed" >&2; exit 1; }
fi

echo "[sherpa-tts] → $OUT"
echo "[sherpa-tts] → $VENDOR/onnxruntime.xcframework"
echo "[sherpa-tts] → $VENDOR/$VOICE_ID"
