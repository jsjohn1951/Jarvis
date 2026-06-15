# Memory & Personality

Jarvis has a short-term conversation buffer and a curated long-term memory, plus an editable personality — all plain markdown.

## Personality (`personality/`)
- `jarvis.md` — core persona, tone, rules. Loaded into **every** agent's system prompt.
- `voice.md` — spoken-reply style.
Edit these to change Jarvis's character; no code change. Cached at orchestrator start (restart to reload). Composed by [personality.ts](../orchestrator/src/personality.ts).

## Short-term memory (the context fix)
[memory.ts](../orchestrator/src/memory.ts) keeps a rolling buffer of recent turns (default 12), in-memory and mirrored to `memory/short-term/session.md`. It's injected into every prompt — quick agent gets it as message history; hybrid agents get it folded into the system prompt. This is why Jarvis now keeps context across turns (the orchestrator was previously stateless). "forget that" / "new conversation" clears it.

## Long-term memory — hub & spoke (`memory/`)
```
memory/MEMORY.md          # HUB: index of categories
memory/long-term/*.md     # SPOKES: preferences, projects, people, facts (+ new as curated)
```
- **Retrieval:** each turn loads the small hub, the 2B picks the relevant categories, and only those spoke files are read and injected (capped). Fast, category-scoped lookup — not a full memory read.
- **Curation (hybrid):**
  - *Capture (local 2B, continuous, free):* after each exchange, the 2B extracts durable candidate facts → `memory/short-term/candidates.md`.
  - *Consolidate (cloud Sonnet, periodic):* every ~8 turns (or on "remember …"), Sonnet reviews candidates + existing spokes, keeps only what matters, dedupes, files each into the best category, and updates the hub. Runs in the background — never blocks a reply.

## Tuning (env on the orchestrator)
`JARVIS_SHORT_TERM_TURNS` (12), `JARVIS_CONSOLIDATE_EVERY` (8), `JARVIS_MAX_MEMORY_CHARS` (4000), `JARVIS_MEMORY` / `JARVIS_PERSONALITY` (dir overrides).

## Privacy
All capture/retrieval is local (2B). Only the periodic consolidation pass uses the cloud (your Pro plan). `memory/short-term/` is gitignored; `personality/` and `memory/long-term/` are kept.
