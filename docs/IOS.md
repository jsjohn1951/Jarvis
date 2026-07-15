# Jarvis iOS Companion

The `JarvisMobile` target ([app/project.yml](../app/project.yml)) is a hybrid iOS client:

- **Connected mode** — the phone is a voice/text surface for the Mac's orchestrator
  (`ws://<mac>:7777`). Claude Agent SDK, agents, coder, and memory all stay on the
  Mac; only text crosses the network. **Voice is synthesized on-device** in both
  modes (Piper `en_US-joe-medium` via sherpa-onnx,
  [LocalPiperTTS.swift](../app/JarvisMobile/Voice/LocalPiperTTS.swift)) — the phone
  never calls the Mac's `:8082` TTS server.
- **Standalone mode** — an embedded llama.cpp runs the *same* Gemma 3 4B GGUF as the
  Mac's :8083 conversation tier for chat, plus a fixed research pipeline
  (search → fetch → extract → summarize). No long-term memory on-device; session-only.

Routing between the two lives in
[TurnRouter.swift](../app/JarvisMobile/Routing/TurnRouter.swift): agent-shaped work
always requires the Mac, **research always runs on-device** once the model is
downloaded, and chat follows the "Prefer local for chat" setting (Mac by default).

## Packaging & install (from the laptop)

```bash
./scripts/ios-package.sh --team <TEAMID> --serve-model --up
```

That script: checks tools (brew-installs Tailscale/qrencode/jq), builds the pinned
llama.cpp XCFramework ([scripts/build-llama-xcframework.sh](../scripts/build-llama-xcframework.sh)
→ `app/Vendor/llama.xcframework`, gitignored), builds the pinned sherpa-onnx
XCFramework and fetches the bundled Piper voice
([scripts/build-sherpa-tts.sh](../scripts/build-sherpa-tts.sh) → `app/Vendor/`,
gitignored; adds ~80 MB of on-device TTS to the app), ensures the pairing token
(`~/.jarvis/mobile-token`, 0600), xcodebuilds + installs `JarvisMobile.app` on a
connected iPhone, prints the **pairing QR**, optionally serves the local GGUF on
`:8090`, and brings the stack up with mobile exposure.

On the phone: install **Tailscale** from the App Store (one-time, guided by the
script output), then Jarvis iOS → Settings → *Scan pairing QR*. The QR carries
host / ports / token / model URL + sha256. Then Settings → *Download* the model.

## Security model

- All servers bind `127.0.0.1` by default — nothing changes for desktop use.
- `JARVIS_WS_HOST=0.0.0.0` widens the orchestrator bind; **loopback sockets keep
  today's trusted behavior byte-for-byte**, while non-loopback sockets are
  quarantined until a valid `{type:"hello", role:"mobile", token}`
  ([orchestrator/src/mobile-auth.ts](../orchestrator/src/mobile-auth.ts)); 10s
  timeout → close 4001. `shutdown`/`swap` are rejected for mobile sockets.
  Once `~/.jarvis/mobile-token` exists (a phone has been paired), both the Mac
  HUD's service controls ([ServiceController.swift](../app/Jarvis/MenuBar/ServiceController.swift))
  and a plain `./scripts/start-jarvis.sh` default to the same mobile-exposure env
  automatically, so every way of starting the stack behaves like `ios-package.sh --up`.
  Set `JARVIS_WS_HOST=127.0.0.1` explicitly to force loopback-only despite pairing.
- TTS needs **no network exposure**: the phone synthesizes speech on-device.
  (`PIPER_HOST=0.0.0.0` + `PIPER_TOKEN=<token>` can still expose the Mac's server
  manually — remote requests then require `X-Jarvis-Token` — but no mobile flow
  needs it anymore.)
- Licensing note: the on-device engine (sherpa-onnx, Apache-2.0) bundles
  `espeak-ng-data`, which is GPL-3.0 — same situation as the Mac's separate Piper
  *process* noted in [tts/README.md](../tts/README.md); fine for this personal,
  unredistributed build.
- Desktop actuation (`act`) is never sent to a mobile socket; a phone-originated
  "open Chrome" drives the *Mac* app when it's connected, else the tool returns a
  graceful error ([orchestrator/src/tools.ts](../orchestrator/src/tools.ts)).
- Prefer Tailscale (WireGuard-encrypted) over plain LAN: on LAN the pairing token
  travels cleartext. Acceptable for a personal LAN; not for hostile networks.

## Free-signing lifecycle (no paid account)

- Sign into Xcode once with your Apple ID → personal team; then `--team <TEAMID>`.
- Apps expire after **7 days** — re-run `ios-package.sh`. The app's data container
  (including the 2.5 GB model in Application Support) survives reinstalls **as long
  as the bundle id `com.jsjohn1951.jarvis.mobile` and team never change** — don't
  rename them. (Bundle ids are globally unique across Apple; the id is user-scoped
  because plain `com.jarvis.mobile` was taken by another team.)
- First install: trust the profile in Settings → General → VPN & Device Management.
- Cap of 3 app ids per free account; upgrade to a paid account ($99/yr) for 1-year
  profiles, TestFlight, and the increased-memory entitlement (only needed if you
  ever want a model bigger than ~4B Q4).

## Updating the app on the phone

The standard update procedure — after any code change, and for the 7-day re-sign:

1. Connect the iPhone to the Mac via **cable** (verify: `xcrun devicectl list devices`).
2. `./scripts/ios-package.sh --team <TEAMID>` — builds against the concrete device,
   signs, and installs over the cable in one step. No Xcode UI, **no simulator**.
3. That's it: the app's data (downloaded model, settings) survives, and the phone
   needs no re-pairing — the QR the script prints is only for first-time setup.

The script builds against the *connected device* rather than a generic destination
on purpose (free-account device registration; see comment in the script). If it
reports no iPhone found, check the cable and that the phone is unlocked/trusted.

## Model delivery

Default GGUF: `gemma-3-4b-it-Q4_K_M.gguf` — byte-identical to the Mac's convo tier
(`orchestrator/src/config.ts` `convoModel`). Downloaded on-device (never bundled)
to Application Support, resumable over HTTP Range, sha256-verified when the QR
provides a hash, excluded from iCloud backup. Sources: the Mac itself
(`--serve-model`, LAN/tailnet speed) or the ungated `unsloth/gemma-3-4b-it-GGUF`
HF repo. The gated Google QAT q4_0 works too if you pass your own URL+token.

## Shared code layout

`app/Jarvis/` compiles into **both** targets; macOS-only files are excluded in
`project.yml` (`MenuBar/**`, `Theme/**`, `Context/**`, hotkey/ducking/VoiceController).
Endpoints (host/ports/token) live in
[Endpoints.swift](../app/Jarvis/Orchestrator/Endpoints.swift) — Mac defaults are
loopback + empty token, so the desktop app is unchanged. iOS-only code lives in
`app/JarvisMobile/` (HUD, agent panel, pairing, audio session, local LLM, skills).

## Testing

- Orchestrator: `test/mobile-auth-test.ts`, `test/act-routing-test.ts`,
  `test/server-mobile-test.ts` (framework-less tsx; run via `./node_modules/.bin/tsx`).
- iOS verification: **prefer the real device** — cable the phone and run
  `./scripts/ios-package.sh --team <TEAMID>` (build + install is the compile check;
  see "Updating the app on the phone"). The simulator is deliberately not part of
  the workflow.
- Fallback compile check only when no device is reachable (CI, remote session):
  `xcodebuild -project Jarvis.xcodeproj -target JarvisMobile -sdk
  iphonesimulator<ver> CODE_SIGNING_ALLOWED=NO build` — build only, don't run it.
- Real-device checklist: mic/STT permission → prompt → streamed text → on-device
  Piper voice (Joe) with the Mac's `:8082` *not* exposed; barge-in; Wi-Fi→cellular
  reconnect (MagicDNS host); airplane-mode
  local chat in persona **with voice**; "research X" off-Mac; "open Chrome" with the Mac app
  closed → graceful error; agent panel live during a multi-agent turn; re-sign
  after 7 days → model still present.
