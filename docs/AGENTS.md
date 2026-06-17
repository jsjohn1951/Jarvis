# Agents

An **agent** is a named configuration the orchestrator dispatches a command to. Hybrid agents are Claude Code sessions launched (via the Claude Agent SDK) with `ANTHROPIC_BASE_URL=http://127.0.0.1:9090`, so they inherit hybrid routing — main turn → cloud Sonnet (your **Pro subscription**), subagents → local Qwen. The `quick` agent skips Claude Code entirely and calls the local 2B directly.

## Seed agents

| Agent | Tier | Purpose |
|-------|------|---------|
| `dev` | hybrid | Real software work in the repo — read/edit/run/debug. **Default.** |
| `coder` | hybrid | Write a whole file **live in VS Code** (typed out token-by-token). No `Write`/`Edit` — the body comes back as text and is streamed into the editor. See [EDITOR.md](EDITOR.md). |
| `researcher` | hybrid | Read-only exploration / explanation (no edits). |
| `planner` | hybrid | Break a goal into ordered steps (no edits). |
| `reviewer` | hybrid | Review code/diff for bugs, security, quality (no edits). |
| `desktop` | hybrid | Control on-screen apps: edit code in the open editor, click/type/menus via AppleScript. Sees the screen. |
| `web` | hybrid | Open Chrome/Safari and navigate to a constructed URL (YouTube search, weather, news). |
| `quick` | local | Instant factual/conceptual answers via the 2B (`:8081`). $0, ~instant. |

`desktop` and `web` call **in-process MCP tools** (`mcp__jarvis__open_target`, `mcp__jarvis__run_applescript`, `mcp__jarvis__capture_screen`, in [tools.ts](../orchestrator/src/tools.ts)). Those tools don't act directly — they forward to the **app** over the `act` protocol (below), which actually runs the AppleScript / `open` / screen capture, because the app holds the Automation + Screen Recording grants. The bridge lives in [actuation.ts](../orchestrator/src/actuation.ts).

Defined in [orchestrator/src/agents/index.ts](../orchestrator/src/agents/index.ts).

## Adding an agent

Add an entry to `AGENTS` in `orchestrator/src/agents/index.ts`:

```ts
myAgent: {
  name: "myAgent",
  description: "what it's for — the dispatcher reads this to route commands",
  tier: "hybrid",                 // or "local"
  allowedTools: ["Read", "Grep", "Bash"],  // hybrid only
  systemPrompt: "…",              // hybrid only
  cwd: config.repoDir,            // hybrid only
}
```

The dispatcher ([dispatcher.ts](../orchestrator/src/dispatcher.ts)) routes by: keyword fast-path → local-2B classification against `description` → fallback to `dev`. Tune that policy to change routing behaviour.

## WebSocket protocol (`:7777`)

The app and orchestrator speak JSON over one WebSocket.

**Inbound (app → orchestrator):**
- `{ "type": "prompt", "text": "...", "agent"?: "dev" }` — run a command (omit `agent` to auto-dispatch)
- `{ "type": "health" }` — request a health snapshot
- `{ "type": "agents" }` — request the agent registry
- `{ "type": "models" }` — request available GGUFs + the one loaded on :8080
- `{ "type": "swap", "model": "Foo.gguf" }` — hot-swap the :8080 model (see [MODELS.md](MODELS.md))
- `{ "type": "provider_config", "provider": "ollama", "enabled": bool, "model": "...", "apiKey": "..." }` — configure the Ollama Cloud fallback tier (persisted 0600 for the router; see [MODELS.md](MODELS.md))
- `{ "type": "hello", "role": "editor", "token": "..." }` — sent by the **VS Code extension** to register as the live-coding surface (not the app). The `token` must match the shared secret at `~/.jarvis/editor-token` or the socket is closed. The orchestrator then streams the `coder` agent's `editor_*` messages to it — see [EDITOR.md](EDITOR.md).

**Outbound (orchestrator → app):**
- `{ "type": "status", "state": "thinking" | "idle", "detail"?: "..." }`
- `{ "type": "agent", "name": "...", "via": "keyword|classifier|fallback|explicit" }`
- `{ "type": "text", "delta": "..." }` — streamed output
- `{ "type": "reset" }` — discard partial output: the chain switched to a fallback provider (Claude → Ollama → local), so the HUD/TTS should clear and re-stream
- `{ "type": "tool", "name": "..." }` — a tool the hybrid agent invoked (for the HUD)
- `{ "type": "done", "result": "..." }` — final text (spoken via TTS)
- `{ "type": "error", "message": "..." }`
- `{ "type": "health", "llama": bool, "router": bool, "quick": bool }`
- `{ "type": "agents", "list": [{ "name", "description", "tier" }] }`
- `{ "type": "models", "list": [...], "current": "..." }`
- `{ "type": "act", "id": "...", "action": "open|applescript|capture", "app"?, "url"?, "script"? }` — desktop/web tool asking the app to perform a system action

**Inbound reply for `act`:**
- `{ "type": "act_result", "id": "...", "ok": bool, "output"?: "...", "image"?: "<base64 png>", "error"?: "..." }`

### The `act` protocol (desktop/web actuation)

A `desktop`/`web` agent's tool call → `runAct(ws, …)` sends `{type:"act", id, …}` to the app and awaits the `{type:"act_result", id}` with the matching `id` (JSON-RPC-style correlation; times out if the app is disconnected). The app runs it in [Actuator.swift](../app/Jarvis/Context/Actuator.swift) (`open`, `NSAppleScript`, `ScreenContext`) and replies. Keystrokes into other apps need **Accessibility**; `open`/AppleScript need **Automation** (both granted on first use).
