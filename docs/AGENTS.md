# Agents

An **agent** is a named configuration the orchestrator dispatches a command to. Hybrid agents are Claude Code sessions launched (via the Claude Agent SDK) with `ANTHROPIC_BASE_URL=http://127.0.0.1:9090`, so they inherit hybrid routing — main turn → cloud Sonnet (your **Pro subscription**), subagents → local Qwen. The `quick` agent skips Claude Code entirely and calls the local 2B directly.

## Seed agents

| Agent | Tier | Purpose |
|-------|------|---------|
| `dev` | hybrid | Real software work in the repo — read/edit/run/debug. **Default.** |
| `researcher` | hybrid | Read-only exploration / explanation (no edits). |
| `planner` | hybrid | Break a goal into ordered steps (no edits). |
| `reviewer` | hybrid | Review code/diff for bugs, security, quality (no edits). |
| `quick` | local | Instant factual/conceptual answers via the 2B (`:8081`). $0, ~instant. |

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

**Outbound (orchestrator → app):**
- `{ "type": "status", "state": "thinking" | "idle", "detail"?: "..." }`
- `{ "type": "agent", "name": "...", "via": "keyword|classifier|fallback|explicit" }`
- `{ "type": "text", "delta": "..." }` — streamed output
- `{ "type": "tool", "name": "..." }` — a tool the hybrid agent invoked (for the HUD)
- `{ "type": "done", "result": "..." }` — final text (spoken via TTS)
- `{ "type": "error", "message": "..." }`
- `{ "type": "health", "llama": bool, "router": bool, "quick": bool }`
- `{ "type": "agents", "list": [{ "name", "description", "tier" }] }`
- `{ "type": "models", "list": [...], "current": "..." }`
