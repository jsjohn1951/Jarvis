# Local-9B fallback when Claude is unavailable

**Date:** 2026-06-15
**Status:** Approved design, pending implementation plan
**Area:** `orchestrator/`

## Problem

When a hybrid agent's cloud turn fails because Claude is rate-limited or
overloaded, the orchestrator catches the error in [server.ts](../../../orchestrator/src/server.ts)
and emits `{type:"error"}`. The user — who hears Jarvis spoken aloud — gets a
dead end. The observed trigger is the Anthropic message:

```
API Error: Server is temporarily limiting requests (not your usage limit)
This request would exceed your account's rate limit. Please try again later.
```

This is an account-level / capacity rate limit, not a usage-cap exhaustion, so
the local models (which cost nothing and need no cloud auth) are a valid
substitute for the duration of the outage.

## Goal

When the cloud turn fails because Claude is unavailable, transparently re-run
the request on the local 9B with the **same tool loop** (Read/Edit/Bash etc.),
and stop hammering the cloud for a cooldown window. Recover automatically.

## Decisions (locked)

- **Fallback scope:** keep the Agent SDK tool loop, but point the model at the
  local 9B via the router (model-name routing). Full capability — the fallback
  agent can still read, edit, and run commands. The 2B "quick" tier is *not*
  used for fallback because it has no tools.
- **Trigger:** automatic, with a circuit breaker. On a Claude-unavailable error,
  retry that request locally **and** trip a breaker so subsequent requests go
  straight to local during a cooldown. After the cooldown, the next request
  probes the cloud again; if it fails, the breaker re-trips. No manual UI.

## Architecture

### 1. `orchestrator/src/fallback.ts` (new)

The circuit breaker and the error-classification predicate.

- Module-level state: `trippedAt: number | null`.
- `isOpen(): boolean` — `trippedAt !== null && Date.now() - trippedAt < cooldownMs`.
- `trip(): void` — sets `trippedAt = Date.now()`.
- `reset(): void` — sets `trippedAt = null` (used by tests; also called on a
  successful cloud probe so state stays clean).
- `isClaudeUnavailable(err: unknown): boolean` — **the policy predicate.**
  Returns true when the error means "cloud capacity is unavailable, try local"
  (rate limit, HTTP 429, overloaded/HTTP 529, transient network failure) and
  false when it means "a real failure we must not mask" (auth/OAuth failure, a
  genuine error produced by the agent's own work). This is the human-judgment
  seam and is implemented as a user contribution.

No timers: recovery is lazy. `isOpen()` simply returns false once the cooldown
has elapsed, so the next request naturally probes the cloud.

### 2. `orchestrator/src/config.ts` (extend)

Two new env-overridable values, matching the existing config style:

- `localModel` — the model name the router maps to `:8080` (the loaded 9B).
  Default: the 9B gguf name used in [models.ts](../../../orchestrator/src/models.ts)
  (`Qwen3.5-9B-Q4_K_M.gguf`), subject to verification of the exact string the
  router accepts.
- `fallbackCooldownMs` — breaker cooldown. Default 5 minutes
  (`JARVIS_FALLBACK_COOLDOWN_MS`).

### 3. `orchestrator/src/runner.ts` (modify `runHybrid`)

`runHybrid` becomes breaker-aware:

1. Choose the starting model: if `fallback.isOpen()`, start on `config.localModel`
   (skip the doomed cloud round-trip entirely — this is what keeps a sustained
   rate-limit fast). Otherwise start on `config.cloudModel`.
2. Run the cloud attempt. If the stream throws **and** `isClaudeUnavailable(err)`
   **and** no text tokens have been emitted yet:
   - call `fallback.trip()`,
   - restart the generator on `config.localModel` with the identical options.
3. Any other error (or an error after tokens have streamed) re-throws unchanged —
   the existing `server.ts` catch handles it.
4. On a successful cloud completion, call `fallback.reset()` so a stale breaker
   doesn't linger.

`cloudComplete` (background memory consolidation) also checks `fallback.isOpen()`:
when open it skips/defers rather than firing cloud calls that will fail. (It must
not block or fail the foreground reply — consolidation is best-effort already.)

### 4. `orchestrator/src/server.ts` (minimal change)

When `runHybrid` used the local fallback path, the emitted `agent` message
carries `via: "local-fallback"`. The app already renders the `via` field, so the
HUD reflects "running local" with no new UI. `runHybrid` communicates which path
it took (e.g. an event or a returned flag — exact mechanism decided in the plan).

## Data flow

```
prompt -> handlePrompt -> runHybrid
  breaker open?  --yes--> local 9B + tools   (via: local-fallback)
       | no
       v
   cloud Sonnet + tools
       | throws + isClaudeUnavailable + no tokens emitted yet
       v
   trip() -> restart on local 9B + tools     (via: local-fallback)
```

## Why double-speak is not a problem

Rate-limit / overload errors reject the request *before* any tokens stream, so
the in-place retry is clean. Once the breaker is open, every subsequent request
starts on the local model from token zero. The only guarded case is the first
failing request, which is why the retry condition includes "no tokens emitted
yet" — if the cloud somehow failed mid-stream, we surface the error rather than
re-speak from the top.

## Testing (TDD)

`orchestrator/test/fallback-test.ts`:

- `isClaudeUnavailable` returns true for rate-limit / 429 / overloaded / 529 /
  network errors and false for auth failures and generic agent errors.
- `trip()` makes `isOpen()` true; it stays true within the cooldown and becomes
  false after it (inject/override the cooldown for the test).
- `reset()` clears the breaker.

Follows the existing lightweight `test/*.ts` script pattern in the repo.

## Unknowns to verify during implementation (do not assume)

1. **How the SDK surfaces the rate-limit** — as a thrown exception from the
   `query()` async iterator, or as a `result` message with an error subtype.
   [runner.ts](../../../orchestrator/src/runner.ts) currently only handles
   `subtype:"success"`; the error path must be confirmed against the real SDK
   behaviour before the predicate and retry can be wired correctly.
2. **The exact model-name string the router maps to `:8080`** — verify against
   `~/.claude/router/proxy.py` so `config.localModel` is a name the router
   actually routes, not merely the gguf filename.

## Out of scope (YAGNI)

- Manual HUD toggle / force-local / force-cloud controls.
- Falling further back to the no-tools chat tier if the local 9B itself fails.
- Surfacing breaker state as a distinct health field (the `via` reuse suffices).
