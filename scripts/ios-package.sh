#!/usr/bin/env bash
# Package + install the Jarvis iOS companion from this laptop, end to end:
#
#   1. preflight     : xcodegen/xcodebuild, brew-installs tailscale + qrencode + jq
#   2. llama.cpp     : build the pinned llama.xcframework (on-device model tier)
#   3. token         : ensure ~/.jarvis/mobile-token (0600) — the pairing secret
#   4. build+install : xcodebuild the JarvisMobile scheme, install via devicectl
#   5. pairing QR    : terminal QR the phone scans (host/ports/token/model URL)
#   6. stack         : optionally bring everything up with mobile exposure (--up)
#
# Flags:
#   --team <TEAMID>   Apple Development team for signing (else Xcode's default;
#                     for a free Apple ID, sign into Xcode once so a personal
#                     team exists, then find it in Xcode → Settings → Accounts)
#   --serve-model     serve ~/models/gemma-3-4b-it-Q4_K_M.gguf on :8090 so the
#                     phone downloads it at LAN/tailnet speed (one-shot server)
#   --up              start the Mac stack with JARVIS_WS_HOST=0.0.0.0 etc.
#   --skip-install    build only (no connected-device install)
#
# Free Apple ID notes: the app expires after 7 days — just re-run this script
# (the phone keeps its data, including the downloaded model, as long as the
# bundle id com.jsjohn1951.jarvis.mobile and your team stay the same). First install needs
# Settings → General → VPN & Device Management → trust your developer profile.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TEAM_ID="${DEVELOPMENT_TEAM:-}"
SERVE_MODEL=0
BRING_UP=0
SKIP_INSTALL=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --team) TEAM_ID="$2"; shift 2 ;;
    --serve-model) SERVE_MODEL=1; shift ;;
    --up) BRING_UP=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

MODEL_FILE="$HOME/models/gemma-3-4b-it-Q4_K_M.gguf"
MODEL_HF_URL="https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/resolve/main/gemma-3-4b-it-Q4_K_M.gguf"
TOKEN_FILE="$HOME/.jarvis/mobile-token"

echo "[1/6] preflight…"
command -v xcodegen >/dev/null || { echo "xcodegen missing — brew install xcodegen"; exit 1; }
command -v xcodebuild >/dev/null || { echo "Xcode command line tools missing"; exit 1; }
if command -v brew >/dev/null; then
  command -v qrencode >/dev/null || brew install qrencode
  command -v jq >/dev/null || brew install jq
  if [[ ! -d /Applications/Tailscale.app ]] && ! command -v tailscale >/dev/null; then
    echo "      installing Tailscale (brew cask)…"
    brew install --cask tailscale
    echo "      → open Tailscale.app and log in, then re-run this script"
  fi
else
  echo "      ⚠️  Homebrew not found — install tailscale/qrencode/jq manually"
fi

echo "[2/6] llama.cpp XCFramework…"
bash "$ROOT/scripts/build-llama-xcframework.sh"

echo "[3/6] pairing token…"
if [[ ! -s "$TOKEN_FILE" ]]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  openssl rand -hex 24 > "$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  echo "      generated $TOKEN_FILE"
else
  echo "      exists"
fi
TOKEN="$(cat "$TOKEN_FILE")"

echo "[4/6] building JarvisMobile…"
cd "$ROOT/app"
xcodegen generate >/dev/null
TEAM_ARGS=()
[[ -n "$TEAM_ID" ]] && TEAM_ARGS=(DEVELOPMENT_TEAM="$TEAM_ID")

# Find the connected iPhone up front: building against the CONCRETE device (not
# generic/platform=iOS) is what makes Xcode auto-register it with the team — a
# free account's first build fails on a generic destination ("team has no
# devices") because nothing triggers registration.
DEVICE_ID="$(xcrun devicectl list devices --hide-headers 2>/dev/null \
  | grep -i iphone | grep -ioE '[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}' | head -1)" || DEVICE_ID=""
DEST=(-destination generic/platform=iOS)
if [[ -n "$DEVICE_ID" ]]; then
  UDID="$(xcrun devicectl device info details --device "$DEVICE_ID" 2>/dev/null \
    | grep -iE '^\s*.?\s*udid:' | grep -ioE '[0-9A-F]{8}-[0-9A-F]{16}' | head -1)" || UDID=""
  [[ -n "$UDID" ]] && DEST=(-destination "platform=iOS,id=$UDID")
fi

# ${arr[@]+…} guard: an empty array under `set -u` is "unbound" on macOS bash 3.2.
xcodebuild -project Jarvis.xcodeproj -scheme JarvisMobile -configuration Debug \
  "${DEST[@]}" -derivedDataPath DerivedData \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  ${TEAM_ARGS[@]+"${TEAM_ARGS[@]}"} build
APP_PATH="$ROOT/app/DerivedData/Build/Products/Debug-iphoneos/JarvisMobile.app"

if [[ "$SKIP_INSTALL" == 0 ]]; then
  if [[ -n "$DEVICE_ID" ]]; then
    # ${…} braces: macOS bash 3.2 parses a bare $VAR followed by a multibyte char
    # (the ellipsis) as one variable name → "unbound variable" under set -u.
    echo "      installing on ${DEVICE_ID}…"
    xcrun devicectl device install app --device "$DEVICE_ID" "$APP_PATH"
  else
    echo "      ⚠️  no iPhone connected (USB/Wi-Fi) — skipping install."
    echo "         connect the phone and re-run, or: xcrun devicectl device install app --device <id> $APP_PATH"
  fi
fi

echo "[5/6] pairing…"
HOST=""
if command -v tailscale >/dev/null || [[ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]]; then
  TS="tailscale"; command -v tailscale >/dev/null || TS="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  HOST="$($TS status --json 2>/dev/null | jq -r '.Self.DNSName // empty' | sed 's/\.$//')" || HOST=""
fi
if [[ -z "$HOST" ]]; then
  HOST="$(ipconfig getifaddr en0 2>/dev/null || true)"
  echo "      ⚠️  Tailscale not logged in — using LAN IP ${HOST:-unknown}. For remote"
  echo "         access: open Tailscale.app, log in, install the iOS Tailscale app"
  echo "         (https://apps.apple.com/app/tailscale/id1470499037), then re-run."
fi

MODEL_URL="$MODEL_HF_URL"
MODEL_SHA=""
if [[ -f "$MODEL_FILE" ]]; then
  echo "      hashing local model (once per run)…"
  MODEL_SHA="$(shasum -a 256 "$MODEL_FILE" | awk '{print $1}')"
  [[ "$SERVE_MODEL" == 1 ]] && MODEL_URL="http://$HOST:8090/$(basename "$MODEL_FILE")"
fi

PAYLOAD="$(jq -cn --arg host "$HOST" --arg token "$TOKEN" --arg url "$MODEL_URL" --arg sha "$MODEL_SHA" \
  '{v:1, host:$host, wsPort:7777, ttsPort:8082, token:$token, modelURL:$url, modelSHA256:$sha}')"
echo
echo "Scan from Jarvis iOS → Settings → Scan pairing QR:"
qrencode -t ansiutf8 "$PAYLOAD"
echo

if [[ "$SERVE_MODEL" == 1 && -f "$MODEL_FILE" ]]; then
  echo "[model] serving $(basename "$MODEL_FILE") on :8090 (ctrl-C when the download finishes)…"
  ( cd "$(dirname "$MODEL_FILE")" && python3 -m http.server 8090 --bind 0.0.0.0 ) &
  MODEL_SRV_PID=$!
  trap 'kill $MODEL_SRV_PID 2>/dev/null || true' EXIT
fi

echo "[6/6] stack…"
if [[ "$BRING_UP" == 1 ]]; then
  JARVIS_WS_HOST=0.0.0.0 PIPER_HOST=0.0.0.0 KOKORO_HOST=0.0.0.0 PIPER_TOKEN="$TOKEN" \
    bash "$ROOT/scripts/start-jarvis.sh"
else
  echo "      to expose the stack to the phone:"
  echo "      JARVIS_WS_HOST=0.0.0.0 PIPER_HOST=0.0.0.0 PIPER_TOKEN=\$(cat $TOKEN_FILE) ./scripts/start-jarvis.sh"
fi

[[ "$SERVE_MODEL" == 1 && -f "$MODEL_FILE" ]] && wait || true
