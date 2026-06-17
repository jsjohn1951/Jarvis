# Jarvis Live Coder (VS Code extension)

Lets the Jarvis orchestrator type code **live** into your editor — you watch the
`coder` agent write a file token-by-token, ChatGPT-style, instead of the file just
appearing on disk.

## How it works

On startup the extension opens a WebSocket to the orchestrator (`ws://127.0.0.1:7777`
by default) and announces itself with `{type:"hello", role:"editor"}`. When you ask
Jarvis to "write X in VS Code", the orchestrator routes to the `coder` agent and
streams the model's tokens here as `editor_stream_*` messages, which are typed into
the active editor on a short flush loop. See `docs/EDITOR.md` in the Jarvis repo for
the full protocol.

## Build & install

```bash
cd editor-extension
npm install
npm run package            # produces jarvis-editor-<version>.vsix
code --install-extension jarvis-editor-0.1.0.vsix
```

Then reload VS Code. Confirm in the orchestrator log that an editor client connected
(`[jarvis] VS Code editor connected`). Use **Jarvis: Reconnect to orchestrator** from
the command palette if the orchestrator restarts.

## Settings

- `jarvis.orchestratorUrl` — orchestrator WebSocket URL (default `ws://127.0.0.1:7777`).
- `jarvis.typeIntervalMs` — flush interval in ms; lower = snappier typing (default 24).

## Notes

- The whole generated file is one undo step — a single Ctrl/Cmd+Z removes it.
- v1 streams **whole-file** creates/rewrites. Targeted in-place edits stay on Jarvis's
  silent `dev` agent.
