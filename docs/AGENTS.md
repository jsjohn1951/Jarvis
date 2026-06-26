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

**Plan-and-confirm gate (dev/coder).** Code-writing agents present a short plan and wait for the user's spoken go-ahead before touching anything (`runPlanGate`, parked in `pendingPlans[ws]`). This is **multi-turn**: the planner asks at most one clarifying question; the user's next utterance is read as **affirmation → execute**, a **clarifying answer → continue planning** (re-run the gate with the conversation so far), or a **close intent → drop**. Every planning exchange is recorded to memory + the session, so context carries across clarification turns and into execution. (Earlier, any non-"yes" reply was treated as "declined" and re-planned from scratch — which looped.)

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
- `{ "type": "cancel" }` — **barge-in**: abort the in-flight turn/project (aborts the SDK stream via a threaded `AbortSignal`). Processed concurrently with the running turn.
- `{ "type": "session_open" }` / `{ "type": "session_close" }` — explicit session controls (HUD buttons); the voice "Hey Jarvis" / "goodbye" do the same.

**Outbound (orchestrator → app):**
- `{ "type": "status", "state": "thinking" | "idle", "detail"?: "..." }`
- `{ "type": "agent", "name": "...", "via": "keyword|classifier|fallback|explicit" }`
- `{ "type": "text", "delta": "..." }` — streamed output
- `{ "type": "reset" }` — discard partial output: the chain switched to a fallback provider (Claude → Ollama → local), so the HUD/TTS should clear and re-stream
- `{ "type": "tool", "name": "..." }` — a tool the hybrid agent invoked (for the HUD)
- `{ "type": "done", "result": "..." }` — final text (spoken via TTS)
- `{ "type": "error", "message": "..." }`
- `{ "type": "health", "llama": bool, "router": bool, "quick": bool, "convo": bool }` (`convo` = Gemma `:8083`)
- `{ "type": "agents", "list": [{ "name", "description", "tier" }] }`
- `{ "type": "models", "list": [...], "current": "..." }`
- `{ "type": "session", "state": "open" | "closed", "id"?: "..." }` — a conversation session opened ("Hey Jarvis") or closed ("goodbye")
- `{ "type": "cancelled" }` — the in-flight turn was aborted (barge-in confirmation)
- `{ "type": "project", "event": "created"|"progress"|"done"|"failed", "id", "goal"?, "state"?, "tasks"?: [{ "id", "title", "state" }], "detail"? }` — PM pipeline lifecycle + live task board
- `{ "type": "act", "id": "...", "action": "open|applescript|capture", "app"?, "url"?, "script"? }` — desktop/web tool asking the app to perform a system action

**Inbound reply for `act`:**
- `{ "type": "act_result", "id": "...", "ok": bool, "output"?: "...", "image"?: "<base64 png>", "error"?: "..." }`

### The `act` protocol (desktop/web actuation)

A `desktop`/`web` agent's tool call → `runAct(ws, …)` sends `{type:"act", id, …}` to the app and awaits the `{type:"act_result", id}` with the matching `id` (JSON-RPC-style correlation; times out if the app is disconnected). The app runs it in [Actuator.swift](../app/Jarvis/Context/Actuator.swift) (`open`, `NSAppleScript`, `ScreenContext`) and replies. Keystrokes into other apps need **Accessibility**; `open`/AppleScript need **Automation** (both granted on first use).

## Conversation sessions

A **session** ([session.ts](../orchestrator/src/session.ts)) is opened by "Hey Jarvis" (or `session_open`) and closed only on an explicit close intent — "goodbye" / "new conversation" / "that's all" (`isCloseIntent`, or `session_close`). On close, the conversation is consolidated to long-term memory and the short-term buffer is cleared. Sessions are **additive and opt-in**: with no session open, turns behave exactly as before (the global 12-turn buffer in [memory.ts](../orchestrator/src/memory.ts) is still the source of truth). A session adds an identity, its own persisted turn log (`memory/sessions/<id>.json`), and a handle to any active project. All session calls are wrapped so a session failure never breaks a turn.

## Skills awareness

Work agents (`planner`, `dev`, `coder`, `reviewer`, `researcher`) get a compact **skills catalog** ("name: use when…") injected into their system prompt ([skills-catalog.ts](../orchestrator/src/skills-catalog.ts), from `~/.claude/skills`), and `runHybrid` passes that **curated allowlist** (not `"all"`) to the SDK's `skills` option. This fixes "Jarvis didn't realise it could use a skill" — the catalog is the steering; the allowlist is the enablement. Crucially, the allowlist is a **context filter**: it HIDES plugin *process* skills (`superpowers:*`, `plugin-dev:*`, …) and output-style **personas** (detected by their "Use when user types /…" trigger) — without this, a simple "create an Excel file" request pulled in `superpowers:brainstorming` and derailed into a spec-writing workflow. Only the user's curated task skills under `~/.claude/skills` are offered. The **`planner` gets no skills at all** (`runHybrid` passes `[]` for it): it must *plan*, not execute — a task skill like `terminal-dev` would grant it Bash and it would do the work during "planning". Planning stays read-only; the dev/coder executor gets the skills.

## PM pipeline (planner → coder → reviewer)

Routing to the **`planner`** agent enters the PM pipeline — the orchestrator-side state machine in [pm.ts](../orchestrator/src/pm.ts) + [project.ts](../orchestrator/src/project.ts):

1. **Planner Q&A** ([server.ts](../orchestrator/src/server.ts) `runPlannerTurn`): the planner asks clarifying questions one turn at a time (parked in `pendingPlans[ws].qa`), then emits a final plan after a `PLAN_JSON:` marker. The plan is parsed into tasks, spoken back, and parked awaiting the user's go-ahead (the same `isAffirmation` gate as the dev/coder gate).
2. **Project** (`makeProject`, persisted atomically to `memory/projects/<id>.json` — the source of truth, so a cloud outage or restart is resumable): an ordered list of tasks with `dependsOn` edges.
3. **Execution** (`runProject`): the coder model is hot-swapped onto `:8080` once; `nextRunnableTasks` yields up to `config.coderParallel` (default 2) tasks honoring dependencies, dispatched **concurrently** against the `-np 2 -cb` coder server. Each task runs **locally** (`runHybrid` with `localOnly` on `config.coderModel`), is verified by the same `assessCompletion` gate the server uses (incomplete → bounded re-attempts), then gated by the **reviewer** agent (cloud-first). Rejections re-queue the task with the reviewer's feedback until the attempt budget (`config.projectMaxTaskContinuations`) is spent. The 9B is restored (`restore9B`) when the project ends.

Division of labor matches the design: **implementation is local** (spares the cloud session), **review + PM summary prefer the cloud** with a local fallback. Progress streams to the HUD as `project` events; a barge-in `cancel` pauses the project (left resumable).
