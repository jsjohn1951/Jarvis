import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import type { AgentDef } from "./agents/index.js";
import * as fallback from "./fallback.js";
import * as providers from "./providers.js";
import { decomposeLocal, stepPrompt } from "./local-plan.js";
import { getSkillNames } from "./skills-catalog.js";

/**
 * MCP plugin servers the hybrid agents must never use. Jarvis owns real screen
 * capture and app launching natively (capture_screen / open_target), so a headless
 * browser must not stand in for "take a screenshot" or "open VS Code". Listing the
 * `mcp__<server>` prefix disallows every tool that server exposes.
 */
const BROWSER_PLUGINS = ["mcp__plugin_playwright_playwright"];
// Agents that must run shell commands in the user's VISIBLE Terminal (via the
// mcp__jarvis__run_terminal tool) rather than a headless Bash. Disallowing Bash forces the
// model onto run_terminal. Scoped to the interactive agents — the PM pipeline's batch coder
// (a separate agent def) keeps Bash for throughput.
const VISIBLE_TERMINAL_AGENTS = new Set(["dev", "desktop"]);

/**
 * A short human summary of a tool call's argument, for the agent log — so the HUD can
 * show WHICH skill/file/command a spawn used, not just the bare tool name. Probes the
 * most informative field per tool, with a generic fallback, and truncates.
 */
export function toolDetail(name: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const clip = (s: unknown, n = 80): string | undefined => {
    const str = typeof s === "string" ? s : s == null ? "" : String(s);
    const t = str.replace(/\s+/g, " ").trim();
    return t ? (t.length > n ? t.slice(0, n - 1) + "…" : t) : undefined;
  };
  switch (name) {
    case "Task": {
      const sub = clip(input.subagent_type, 40);
      const desc = clip(input.description, 60);
      return [sub, desc].filter(Boolean).join(": ") || undefined;
    }
    case "Skill": return clip(input.command ?? input.skill ?? input.name);
    case "Bash": return clip(input.command);
    case "Read": case "Write": case "Edit": case "NotebookEdit":
      return clip(input.file_path ?? input.path ?? input.notebook_path);
    case "Glob": case "Grep": return clip(input.pattern);
    case "WebFetch": return clip(input.url);
    case "WebSearch": return clip(input.query);
    case "TodoWrite": return undefined;
    default:
      // Generic: first informative field present.
      return clip(input.command ?? input.skill ?? input.file_path ?? input.path ??
        input.pattern ?? input.query ?? input.url ?? input.prompt ?? input.description);
  }
}

export type RunEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; path?: string; detail?: string }   // path: Write/Edit target (completion evidence); detail: arg summary for the log
  | { type: "result"; text: string }
  | { type: "reset" }       // discard partial output: we're restarting on the next provider
  | { type: "fallback" };   // switched off the cloud because it was unavailable

/**
 * The agent's stream went SILENT for longer than the watchdog allows. Distinct from
 * a normal failure so the caller can treat it as "turn incomplete" (offer to continue
 * / retry) rather than a hard error. A small local model that loops a tool or whose
 * stream never closes manifests as a stall, never as a clean result.
 */
export class StallError extends Error {
  constructor(public readonly model: string, public readonly idleMs: number) {
    super(`agent stream stalled — no output for ${idleMs}ms`);
    this.name = "StallError";
  }
}

/** The agent ran out of agentic turns without finishing — incomplete, not failed. */
export class MaxTurnsError extends Error {
  constructor(public readonly model: string) {
    super("agent reached its turn limit without finishing");
    this.name = "MaxTurnsError";
  }
}

/** A turn ended without producing a clean result (stall / turn-limit). */
export function isIncomplete(err: unknown): boolean {
  return err instanceof StallError || err instanceof MaxTurnsError;
}

/**
 * Idle-reset stall watchdog. Wraps an async iterator and re-yields its values, but throws
 * `StallError` if no value arrives within `stallMs` (SILENCE — not slowness). Each value
 * resets the timer, so a slow-but-progressing stream is never killed; a wedged one is. The
 * source iterator is always closed (`return()`) on exit, whether it ends, stalls, or the
 * consumer aborts — so the caller can cancel the underlying request without leaking it.
 *
 * Exported (not inlined) so the timing contract is unit-testable against a fake iterator.
 */
export async function* withStallWatchdog<T>(
  iter: AsyncIterator<T>,
  stallMs: number,
  model: string,
): AsyncGenerator<T> {
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stall = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StallError(model, stallMs)), stallMs);
      });
      const nextP = iter.next();
      nextP.catch(() => {}); // swallow a late rejection if the stall wins the race
      let res: IteratorResult<T>;
      try {
        res = await Promise.race([nextP, stall]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res.done) return;
      yield res.value;
    }
  } finally {
    await iter.return?.(undefined as any)?.catch?.(() => {});
  }
}

/**
 * The ordered provider fallback chain by model name: Claude → Ollama Cloud (only
 * when configured) → local GGUF. Pure + exported so the ordering is unit-tested.
 */
export function buildChain(cloudModel: string, ollamaModel: string | null, localModel: string): string[] {
  return ollamaModel ? [cloudModel, ollamaModel, localModel] : [cloudModel, localModel];
}

/**
 * Run a hybrid agent (Claude Code via the router) and yield stream events.
 *
 * The key line is `env.ANTHROPIC_BASE_URL = config.routerUrl`: every request the
 * agent makes goes to the local router, which sends the main turn to cloud Sonnet
 * and any locally-modelled subagents to llama.cpp — i.e. exactly claude-hybrid,
 * but driven programmatically.
 */
export async function* runHybrid(
  agent: AgentDef,
  prompt: string,
  opts: {
    system?: string;
    imageBase64?: string;
    mcpServers?: Record<string, McpServerConfig>;
    /**
     * Stream the model's text token-by-token instead of one block per assistant
     * message. Enables `includePartialMessages`; text is then yielded from the raw
     * `stream_event` deltas (the `coder` agent relies on this to type code live into
     * the editor). When off, behaviour is unchanged (one delta per text block).
     */
    partial?: boolean;
    /**
     * When the chain falls all the way to the local GGUF (cloud unavailable), first
     * DECOMPOSE the task into small steps and run them sequentially, so the limited
     * local model never has to hold the whole problem at once. Off for `coder` (its
     * live-typing marker protocol must run as one stream).
     */
    decompose?: boolean;
    /**
     * External cancel (barge-in): when this signal aborts, the in-flight SDK request is
     * aborted so the user can interrupt a turn mid-stream. The server initiates it, so it
     * treats the resulting abort as a cancellation rather than a failure.
     */
    signal?: AbortSignal;
    /**
     * Run ONLY the local tier (skip the cloud probe entirely). The PM pipeline uses this
     * for coder tasks — implementation runs on the local coder model to spare the cloud
     * session, while PM reasoning stays on the cloud.
     */
    localOnly?: boolean;
    /** Override the local model name (e.g. the dedicated coder GGUF). Routes to :8080. */
    localModel?: string;
  } = {},
): AsyncGenerator<RunEvent> {
  // Curated skill allowlist (cached) — hides plugin process skills + personas. See
  // skills-catalog.ts. Computed once per call; reused across provider attempts.
  // The PLANNER is intentionally skill-less: it must PLAN, not execute. A task skill like
  // terminal-dev would grant it Bash and it would just do the work during "planning" (then
  // the gate parks a redundant plan). Planning stays read-only (Read/Glob/Grep).
  const enabledSkills = agent.name === "planner" ? [] : await getSkillNames();
  // With an image, the prompt must be a streamed user message carrying an image
  // content block (Sonnet is vision-capable); otherwise a plain string prompt.
  // Built fresh per attempt: a streamed (image) prompt is a single-use async
  // generator, so the cloud attempt and any local retry must each get their own.
  const makePrompt = (): any =>
    opts.imageBase64
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
  const attempt = async function* (model: string, promptArg?: any): AsyncGenerator<RunEvent> {
    // Any GGUF name is the local tier (the 9B, or a hot-swapped coder model) — it routes
    // to :8080 and gets the local stall budget. Cloud/Ollama names fall through to cloud.
    const isLocal = model === config.localModel || /gguf/i.test(model);
    // Lets us cancel a wedged stream. llama.cpp is single-stream, so an un-aborted hung
    // request would also block the NEXT turn — aborting on stall is required, not optional.
    const controller = new AbortController();
    // Barge-in: relay an external cancel to this attempt's controller so the user can
    // interrupt mid-stream. Abort immediately if it's already fired.
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const stream = query({
      prompt: promptArg ?? makePrompt(),
      options: {
        model,
        cwd: agent.cwd ?? config.repoDir,
        allowedTools: agent.allowedTools,
        mcpServers: opts.mcpServers,         // in-process desktop/web tools (bound to the app ws)
        // We keep filesystem settings loaded so the local-code/local-explore subagents
        // (~/.claude/agents) are available for delegation — but under bypassPermissions
        // that also exposes globally-installed MCP plugins. Block the browser plugins so
        // the agent can't take a "screenshot" via a headless browser or open pages in
        // one: real screen capture goes through the jarvis capture_screen tool, and apps
        // open via open_target. (Listing the server prefix blocks all of its tools.)
        disallowedTools: VISIBLE_TERMINAL_AGENTS.has(agent.name) ? [...BROWSER_PLUGINS, "Bash"] : BROWSER_PLUGINS,
        // Enable only the curated, task-appropriate skills (no need to add 'Skill' to
        // allowedTools). This is a context filter: it HIDES plugin process skills
        // (superpowers:*, plugin-dev:*, …) and output-style personas that otherwise derail
        // a simple task into a brainstorming/spec workflow. The injected per-agent catalog
        // steers WHICH of these to reach for. Empty list ⇒ skills off (safe).
        skills: enabledSkills,
        systemPrompt: opts.system ?? agent.systemPrompt,
        permissionMode: "bypassPermissions", // headless: no interactive prompts
        // Tighter turn budget for the limited local tier; cloud keeps full headroom.
        maxTurns: isLocal ? config.localMaxTurns : config.cloudMaxTurns,
        includePartialMessages: opts.partial, // token-level text deltas (coder agent)
        env: { ...process.env, ANTHROPIC_BASE_URL: config.routerUrl },
        abortController: controller,
      },
    });

    // Guard the stream with the idle-reset watchdog so a wedged local turn can't hang the
    // HUD forever; abort the underlying request on any abnormal exit (frees llama.cpp).
    const iter = (stream as AsyncIterable<any>)[Symbol.asyncIterator]();
    try {
      for await (const message of withStallWatchdog(iter, isLocal ? config.localStallMs : config.cloudStallMs, model)) {
        if (message.type === "stream_event") {
          // Partial mode only: raw Anthropic SSE. A text_delta is one token's worth of
          // assistant text — yield it so the code-stream splitter can type it live.
          const ev = message.event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text)
            yield { type: "text", delta: ev.delta.text };
        } else if (message.type === "assistant") {
          for (const block of message.message?.content ?? []) {
            // In partial mode the text already arrived as stream_event deltas above;
            // emitting the assembled block too would double every token.
            if (block.type === "text" && block.text && !opts.partial) yield { type: "text", delta: block.text };
            else if (block.type === "tool_use" && block.name) {
              // Carry the Write/Edit target so the completion verifier can confirm the
              // file the task was supposed to produce actually exists on disk; `detail`
              // is the arg summary the agent log shows (skill name, file, command…).
              const path = typeof block.input?.file_path === "string" ? block.input.file_path : undefined;
              yield { type: "tool", name: block.name, path, detail: toolDetail(block.name, block.input) };
            }
          }
        } else if (message.type === "result" && message.subtype === "success") {
          yield { type: "result", text: message.result ?? "" };
        } else if (message.type === "result" && message.is_error) {
          // Ran out of agentic turns → "incomplete" (the verifier may continue), distinct
          // from a genuine execution failure. Other error results throw as before so the
          // same fallback logic handles both the throw and the message paths.
          if (message.subtype === "error_max_turns") throw new MaxTurnsError(model);
          const detail = Array.isArray(message.errors) && message.errors.length
            ? message.errors.join("; ")
            : message.subtype || "agent error";
          throw new Error(detail);
        }
      }
    } catch (err) {
      // Cancel the underlying request on any abnormal exit (stall, turn-limit, error) so
      // single-stream llama.cpp is freed for the next turn. The watchdog's own finally has
      // already closed the iterator.
      controller.abort();
      throw err;
    }
  };

  // Walk the provider chain Claude → Ollama (if configured) → local. An
  // "unavailable" (capacity/transient) error advances to the next provider; a
  // clean run on any provider returns. If the breaker is already open we skip the
  // doomed cloud round-trip and start at the next tier.
  const ollama = providers.getOllamaFallback();
  const localModel = opts.localModel ?? config.localModel;
  // localOnly: skip cloud/Ollama and run just the local model (PM coder tasks). Otherwise
  // the normal Claude → Ollama → local chain, with the breaker skipping a doomed cloud probe.
  const chain = opts.localOnly
    ? [localModel]
    : buildChain(config.cloudModel, ollama?.model ?? null, localModel);
  const start = opts.localOnly ? 0 : fallback.isOpen() ? 1 : 0;

  for (let i = start; i < chain.length; i++) {
    const model = chain[i];
    const isCloud = !opts.localOnly && i === 0;
    if (i > 0) yield { type: "fallback" };   // app shows "via: local-fallback"

    let toolRan = false;
    // Full-local fallback (last tier, local GGUF): decompose into small steps and run
    // them in sequence so the limited local model never juggles the whole task.
    const decomposeHere = opts.decompose && model === config.localModel && !opts.imageBase64;
    try {
      if (decomposeHere) {
        const steps = await decomposeLocal(prompt);
        for (let s = 0; s < steps.length; s++) {
          for await (const ev of attempt(model, stepPrompt(prompt, steps[s], s, steps.length))) {
            if (ev.type === "tool") toolRan = true;
            yield ev;
          }
        }
      } else {
        for await (const ev of attempt(model)) {
          if (ev.type === "tool") toolRan = true;
          yield ev;
        }
      }
      if (isCloud) fallback.reset();   // a clean cloud run clears any stale breaker state
      return;                          // success on this provider — done
    } catch (err) {
      if (isCloud && fallback.isClaudeUnavailable(err)) fallback.trip();
      const last = i === chain.length - 1;
      // A stall on a non-last provider (e.g. a wedged cloud connection) is treated like
      // unavailability: advance to the next tier rather than give up. MaxTurnsError is NOT
      // advanceable — the model used its budget; retrying from scratch could repeat work.
      const advanceable = fallback.isClaudeUnavailable(err) || err instanceof StallError;
      // Stop (the server then speaks a graceful line / runs the verifier) when the error
      // isn't advanceable, a side-effecting tool already ran this turn (re-running could
      // repeat it — e.g. opening a URL twice), or no provider is left. Nothing is spoken
      // until `done`, so a pre-tool restart is clean.
      if (!advanceable || toolRan || last) throw err;
      yield { type: "reset" };   // discard any partial text, retry on the next provider
    }
  }
}

/**
 * One-shot cloud (Sonnet via the router → Pro subscription) text completion, no
 * tools. Used by memory consolidation. Returns the final result text.
 */
export async function cloudComplete(prompt: string, system?: string): Promise<string> {
  if (fallback.isOpen()) return ""; // cloud unavailable — skip rather than fail
  const stream = query({
    prompt,
    options: {
      model: config.cloudModel,
      systemPrompt: system,
      allowedTools: [],
      permissionMode: "bypassPermissions",
      maxTurns: 1,
      env: { ...process.env, ANTHROPIC_BASE_URL: config.routerUrl },
    },
  });
  let result = "";
  for await (const message of stream as AsyncIterable<any>) {
    if (message.type === "result" && message.subtype === "success") result = message.result ?? "";
  }
  return result;
}
