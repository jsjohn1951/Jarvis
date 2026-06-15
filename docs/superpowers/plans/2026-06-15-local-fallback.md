# Local-9B Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a hybrid agent's cloud turn fails because Claude is rate-limited/overloaded, transparently re-run it on the local 9B with the same tool loop, and trip a self-healing circuit breaker so subsequent requests skip the cloud during a cooldown.

**Architecture:** A new `fallback.ts` module holds circuit-breaker state and an error-classification predicate. `runHybrid` chooses cloud vs. local 9B by model name (the router routes any `gguf`/`qwen*` model name to `:8080` with full tool translation), trips the breaker on a Claude-unavailable error, and retries locally if no tokens were emitted. Background memory consolidation is gated off while the breaker is open.

**Tech Stack:** Node 22, TypeScript (NodeNext ESM, `.js` import specifiers), `@anthropic-ai/claude-agent-sdk` 0.3.177, `tsx` for running tests (no test framework — standalone scripts with `node:assert`).

---

## Verified facts this plan depends on

- The router (`~/.claude/router/proxy.py`) `routes_to_local()` sends a request to the local 9B (`:8080`) when the model name contains `gguf`, starts with `qwen`, or is in its local set. So `model: "Qwen3.5-9B-Q4_K_M.gguf"` routes **locally, with tool-call translation** (same path subagents already use).
- The SDK surfaces a failed turn as either (a) a thrown error from the `query()` async iterator, or (b) a `result` message with `subtype:"error_during_execution"` (one of `error_during_execution | error_max_turns | error_max_budget_usd | error_max_structured_output_retries`), `is_error:true`, and an `errors: string[]` field. Current `runHybrid` ignores case (b).
- `tests` run via `npx tsx test/<file>.ts` and import source as `../src/<name>.js`. `config` is an exported mutable object, so tests can override `config.fallbackCooldownMs` directly.

## File structure

- **Create** `orchestrator/src/fallback.ts` — breaker state (`isOpen`/`trip`/`reset`) + `isClaudeUnavailable(err)` predicate. One responsibility: "should we be using local right now, and is this error a cloud-availability error?"
- **Modify** `orchestrator/src/config.ts` — add `localModel`, `fallbackCooldownMs`.
- **Modify** `orchestrator/src/runner.ts` — make `runHybrid` breaker-aware, normalize SDK error results into throws, add a `fallback` RunEvent; gate `cloudComplete`.
- **Modify** `orchestrator/src/memory.ts` — gate `maybeConsolidate` at the top while the breaker is open.
- **Modify** `orchestrator/src/server.ts` — on a `fallback` event, re-emit `agent` with `via:"local-fallback"`.
- **Create** `orchestrator/test/fallback-test.ts` — unit test for the breaker + predicate.

> **Note on the predicate (learning hand-off):** `isClaudeUnavailable` is the one human-judgment seam — it decides which failures get silently masked by local vs. surfaced loudly. The reference implementation below is complete and correct; at execution time the implementer (the user) is invited to review/own it. If they defer, the reference version stands. The plan is not blocked on it.

All commands below assume CWD `orchestrator/`.

---

### Task 1: Circuit breaker + error predicate (`fallback.ts`) and config

**Files:**
- Modify: `orchestrator/src/config.ts`
- Create: `orchestrator/src/fallback.ts`
- Test: `orchestrator/test/fallback-test.ts`

- [ ] **Step 1: Add config values**

In `src/config.ts`, inside the `config` object (after the `cloudModel` block, before `repoDir`), add:

```ts
  // Local 9B used when the cloud is unavailable. The name must satisfy the
  // router's routes_to_local() (contains "gguf" / starts with "qwen") so the
  // request is served by llama.cpp on :8080 with tool-call translation.
  localModel: process.env.JARVIS_LOCAL_MODEL ?? "Qwen3.5-9B-Q4_K_M.gguf",
  // Circuit-breaker cooldown: after a Claude-unavailable error, requests go
  // straight to local for this long before the next one probes the cloud again.
  fallbackCooldownMs: Number(process.env.JARVIS_FALLBACK_COOLDOWN_MS ?? 5 * 60_000),
```

- [ ] **Step 2: Write the failing test**

Create `test/fallback-test.ts`:

```ts
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { isOpen, trip, reset, isClaudeUnavailable } from "../src/fallback.js";

// Use a tiny cooldown so the test runs fast.
config.fallbackCooldownMs = 50;

// 1. Breaker starts closed.
reset();
assert.equal(isOpen(), false, "breaker should start closed");

// 2. trip() opens it, and it stays open within the cooldown.
trip();
assert.equal(isOpen(), true, "breaker should be open right after trip()");

// 3. After the cooldown elapses it closes again (lazy recovery, no timer).
await new Promise((r) => setTimeout(r, 70));
assert.equal(isOpen(), false, "breaker should close after cooldown");

// 4. reset() clears an open breaker immediately.
trip();
reset();
assert.equal(isOpen(), false, "reset() should clear the breaker");

// 5. Predicate: cloud-availability errors → true.
for (const m of [
  "API Error: Server is temporarily limiting requests",
  "This request would exceed your account's rate limit",
  "Error: overloaded_error (529)",
  "fetch failed",
  "connect ECONNREFUSED 127.0.0.1:443",
]) {
  assert.equal(isClaudeUnavailable(new Error(m)), true, `should be unavailable: ${m}`);
}

// 6. Predicate: real failures → false (must not be masked).
for (const m of [
  "Authentication failed: invalid api key",
  "401 Unauthorized",
  "TypeError: cannot read property 'x' of undefined",
]) {
  assert.equal(isClaudeUnavailable(new Error(m)), false, `should NOT be unavailable: ${m}`);
}

console.log("fallback-test: OK");
process.exit(0);
```

- [ ] **Step 3: Run the test — verify it fails**

Run: `npx tsx test/fallback-test.ts`
Expected: FAIL — `Cannot find module '../src/fallback.js'` (module not yet created).

- [ ] **Step 4: Implement `fallback.ts`**

Create `src/fallback.ts`:

```ts
import { config } from "./config.js";

/**
 * Circuit breaker for cloud (Claude) availability. When the cloud returns a
 * rate-limit/overload error, we `trip()` it; while `isOpen()` is true, callers
 * route to the local 9B instead of paying a doomed cloud round-trip. Recovery is
 * lazy: once the cooldown elapses, `isOpen()` returns false and the next request
 * probes the cloud again (which re-trips on failure, or `reset()`s on success).
 */
let trippedAt: number | null = null;

export function isOpen(): boolean {
  return trippedAt !== null && Date.now() - trippedAt < config.fallbackCooldownMs;
}

export function trip(): void {
  trippedAt = Date.now();
}

export function reset(): void {
  trippedAt = null;
}

/**
 * Policy predicate — the human-judgment seam.
 *
 * Returns true when `err` means "the cloud is temporarily unavailable, so trying
 * the local model is the right move" (capacity rate limits, overload, transient
 * network failures). Returns false when it means "a real failure we must NOT
 * mask behind a local answer" (auth/permission problems, genuine agent errors) —
 * those should surface to the user unchanged.
 */
export function isClaudeUnavailable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // Real failures first: never mask these, even if other words also match.
  const realFailure = [
    "authentication", "unauthorized", "invalid api key", "invalid_api_key",
    "oauth", "permission", "401", "403",
  ];
  if (realFailure.some((p) => msg.includes(p))) return false;

  // Cloud-capacity / transient errors: safe to fall back to local.
  const unavailable = [
    "rate limit", "rate_limit", "temporarily limiting", "exceed your account",
    "overloaded", "529", "502", "503", "504", "429",
    "timeout", "timed out", "etimedout", "econnrefused", "econnreset",
    "socket hang up", "fetch failed", "network",
  ];
  return unavailable.some((p) => msg.includes(p));
}
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `npx tsx test/fallback-test.ts`
Expected: PASS — prints `fallback-test: OK`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/fallback.ts test/fallback-test.ts
git commit -m "feat(orchestrator): add cloud-availability circuit breaker + predicate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Make `runHybrid` breaker-aware (`runner.ts`)

**Files:**
- Modify: `orchestrator/src/runner.ts`

This task rewrites `runHybrid` to: pick cloud or local by breaker state, normalize SDK error-result messages into thrown errors, retry locally on a Claude-unavailable error when no text has streamed, and emit a `fallback` event so the server can reflect it.

- [ ] **Step 1: Add the `fallback` RunEvent variant**

In `src/runner.ts`, extend the `RunEvent` union:

```ts
export type RunEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "result"; text: string }
  | { type: "fallback" }; // switched to the local 9B because the cloud was unavailable
```

- [ ] **Step 2: Import the breaker**

At the top of `src/runner.ts`, add to the imports:

```ts
import * as fallback from "./fallback.js";
```

- [ ] **Step 3: Replace the body of `runHybrid`**

Replace the existing `runHybrid` function (from `export async function* runHybrid` through its closing brace) with:

```ts
export async function* runHybrid(
  agent: AgentDef,
  prompt: string,
  opts: { system?: string; imageBase64?: string } = {},
): AsyncGenerator<RunEvent> {
  // With an image, the prompt must be a streamed user message carrying an image
  // content block (Sonnet is vision-capable); otherwise a plain string prompt.
  const promptInput: any = opts.imageBase64
    ? (async function* () {
        yield {
          type: "user" as const,
          parent_tool_use_id: null,
          message: {
            role: "user" as const,
            content: [
              { type: "text", text: prompt },
              { type: "image", source: { type: "base64", media_type: "image/png", data: opts.imageBase64 } },
            ],
          },
        };
      })()
    : prompt;

  // One run against a given model. Yields events; THROWS on an error result so
  // the caller can decide whether to fall back. The SDK reports a failed turn
  // either by throwing from the iterator or by a result message with is_error.
  const attempt = async function* (model: string): AsyncGenerator<RunEvent> {
    const stream = query({
      prompt: promptInput,
      options: {
        model,
        cwd: agent.cwd ?? config.repoDir,
        allowedTools: agent.allowedTools,
        systemPrompt: opts.system ?? agent.systemPrompt,
        permissionMode: "bypassPermissions", // headless: no interactive prompts
        maxTurns: 24,
        env: { ...process.env, ANTHROPIC_BASE_URL: config.routerUrl },
      },
    });

    for await (const message of stream as AsyncIterable<any>) {
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && block.text) yield { type: "text", delta: block.text };
          else if (block.type === "tool_use" && block.name) yield { type: "tool", name: block.name };
        }
      } else if (message.type === "result" && message.subtype === "success") {
        yield { type: "result", text: message.result ?? "" };
      } else if (message.type === "result" && message.is_error) {
        // Surface error results (e.g. error_during_execution) as a throw so the
        // same fallback logic handles both the throw and the message paths.
        const detail = Array.isArray(message.errors) && message.errors.length
          ? message.errors.join("; ")
          : message.subtype || "agent error";
        throw new Error(detail);
      }
    }
  };

  // Breaker already open → go straight to local, no doomed cloud round-trip.
  if (fallback.isOpen()) {
    yield { type: "fallback" };
    yield* attempt(config.localModel);
    return;
  }

  // Otherwise try the cloud. Only fall back if it fails BEFORE any text streamed
  // (rate-limit/overload errors reject up front), so we never re-speak a reply.
  let emittedText = false;
  try {
    for await (const ev of attempt(config.cloudModel)) {
      if (ev.type === "text") emittedText = true;
      yield ev;
    }
    fallback.reset(); // a clean cloud run clears any stale breaker state
  } catch (err) {
    if (!emittedText && fallback.isClaudeUnavailable(err)) {
      fallback.trip();
      yield { type: "fallback" };
      yield* attempt(config.localModel);
    } else {
      throw err;
    }
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If TS complains that `RunEvent` is missing `fallback` anywhere it's switched on, that is expected to be resolved in Task 3 where `server.ts` handles it — `server.ts` uses an `if/else if` chain, not an exhaustive switch, so this should still typecheck. If it does error, proceed to Task 3 then re-run.)

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts
git commit -m "feat(orchestrator): route runHybrid to local 9B when the cloud is unavailable

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Surface the fallback in the app protocol (`server.ts`)

**Files:**
- Modify: `orchestrator/src/server.ts`

The app already renders the `agent` message's `via` field. When `runHybrid` emits `fallback`, re-send the `agent` message with `via:"local-fallback"` so the HUD shows it's running local. No new UI.

- [ ] **Step 1: Handle the `fallback` event in the hybrid loop**

In `src/server.ts`, inside `handlePrompt`, find the hybrid streaming loop:

```ts
      for await (const ev of runHybrid(def, promptText, { system: sysWithHistory, imageBase64: image })) {
        if (ev.type === "text") {
          full += ev.delta;
          send(ws, { type: "text", delta: ev.delta });
        } else if (ev.type === "tool") {
          send(ws, { type: "tool", name: ev.name });
        } else if (ev.type === "result") {
          full = ev.text || full;
        }
      }
```

Add a branch for `fallback` (insert before the `tool` branch):

```ts
      for await (const ev of runHybrid(def, promptText, { system: sysWithHistory, imageBase64: image })) {
        if (ev.type === "text") {
          full += ev.delta;
          send(ws, { type: "text", delta: ev.delta });
        } else if (ev.type === "fallback") {
          send(ws, { type: "agent", name: agent, via: "local-fallback" });
        } else if (ev.type === "tool") {
          send(ws, { type: "tool", name: ev.name });
        } else if (ev.type === "result") {
          full = ev.text || full;
        }
      }
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (`agent` is already a valid `Outbound` type and `via` is a free-form string.)

- [ ] **Step 3: Commit**

```bash
git add src/server.ts
git commit -m "feat(orchestrator): report local-fallback via the agent message

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Gate background consolidation while the cloud is down (`memory.ts`, `runner.ts`)

**Files:**
- Modify: `orchestrator/src/memory.ts`
- Modify: `orchestrator/src/runner.ts`

`maybeConsolidate` resets its turn counter and **wipes the candidate file** even when `cloudComplete` returns empty (memory.ts:83 and memory.ts:118). So the gate must be at the very top of `maybeConsolidate`, before it consumes candidates — otherwise an outage would silently delete captured facts. `cloudComplete` is gated too, defensively, for any future caller.

- [ ] **Step 1: Gate `maybeConsolidate` at the top**

In `src/memory.ts`, add the import near the existing `import { cloudComplete } from "./runner.js";`:

```ts
import * as fallback from "./fallback.js";
```

Then change the first lines of `maybeConsolidate`:

```ts
export async function maybeConsolidate(force = false): Promise<void> {
  // Cloud consolidation needs Sonnet. If the breaker is open, defer WITHOUT
  // touching the turn counter or the candidate file, so captured facts survive
  // the outage and get consolidated once the cloud is back.
  if (fallback.isOpen()) return;
  turnsSinceConsolidate++;
```

(The existing `turnsSinceConsolidate++;` line is now the second line; do not duplicate it.)

- [ ] **Step 2: Gate `cloudComplete` defensively**

In `src/runner.ts`, at the start of `cloudComplete`, add the early return (the `fallback` import was already added in Task 2):

```ts
export async function cloudComplete(prompt: string, system?: string): Promise<string> {
  if (fallback.isOpen()) return ""; // cloud unavailable — skip rather than fail
  const stream = query({
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Re-run the breaker unit test (nothing should regress)**

Run: `npx tsx test/fallback-test.ts`
Expected: PASS — `fallback-test: OK`.

- [ ] **Step 5: Commit**

```bash
git add src/memory.ts src/runner.ts
git commit -m "feat(orchestrator): skip cloud memory consolidation while breaker is open

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Run the breaker unit test**

Run: `npx tsx test/fallback-test.ts`
Expected: PASS — `fallback-test: OK`.

- [ ] **Step 3: Smoke-test the local path is reachable (optional, needs llama on :8081/:8080)**

If the local stack is running, run the existing quick test to confirm nothing in the request path regressed:

Run: `npx tsx test/quick-test.ts`
Expected: prints `FINAL_TEXT:` with a one-sentence answer and exits 0. (If the local stack is down, skip this step — it is not part of the fallback logic.)

- [ ] **Step 4: Confirm and report**

Verify all five commits are present:

Run: `git log --oneline -5`
Expected: the five feature commits from Tasks 1–4 plus the spec commit.

Report what was built, that typecheck passes, and that the breaker unit test passes.

---

## Self-review

- **Spec coverage:**
  - `fallback.ts` breaker + `isClaudeUnavailable` → Task 1. ✓
  - `config.localModel` + `fallbackCooldownMs` → Task 1. ✓
  - `runHybrid` breaker-aware, model-by-name, no-double-speak guard → Task 2. ✓
  - SDK error-result normalization (the spec's unknown #1) → Task 2, Step 3. ✓
  - `via:"local-fallback"` surfaced, no new UI → Task 3. ✓
  - `cloudComplete` / consolidation gated → Task 4 (with the candidate-loss fix the spec implied by "skips/defers"). ✓
  - TDD test for breaker + predicate → Task 1. ✓
  - Router model-name string verified (the spec's unknown #2) → "Verified facts" section; `localModel` default is router-routable. ✓
- **Placeholder scan:** no TBD/TODO; every code step shows full code. The predicate is a complete reference impl, explicitly flagged as the optional user-contribution seam — not a placeholder. ✓
- **Type consistency:** `isOpen`/`trip`/`reset`/`isClaudeUnavailable` names match across `fallback.ts`, the test, `runner.ts`, and `memory.ts`. The `fallback` RunEvent is defined (Task 2 Step 1) before it's emitted (Task 2 Step 3) and consumed (Task 3 Step 1). `config.localModel` / `config.fallbackCooldownMs` defined in Task 1, used in Tasks 1–2. ✓
