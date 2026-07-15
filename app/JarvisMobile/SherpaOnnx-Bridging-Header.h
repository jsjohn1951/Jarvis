// Exposes the sherpa-onnx C API to Swift (used by the vendored
// Vendor/SherpaOnnxSwift/SherpaOnnx.swift wrapper for on-device TTS).
// Resolved via HEADER_SEARCH_PATHS → app/Vendor/sherpa-onnx-headers,
// populated by scripts/build-sherpa-tts.sh from the pinned checkout.
#import "sherpa-onnx/c-api/c-api.h"
