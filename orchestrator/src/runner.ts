import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import type { AgentDef } from "./agents/index.js";
import * as fallback from "./fallback.js";
import * as providers from "./providers.js";
import { decomposeLocal, stepPrompt } from "./local-plan.js";

/**
 * MCP plugin servers the hybrid agents must never use. Jarvis owns real screen
 * capture and app launching natively (capture_screen / open_target), so a headless
 * browser must not stand in for "take a screenshot" or "open VS Code". Listing the
 * `mcp__<server>` prefix disallows every tool that server exposes.
 */
const BROWSER_PLUGINS = ["mcp__plugin_playwright_playwright"];

export type RunEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "result"; text: string }
  | { type: "reset" }       // discard partial output: we're restarting on the next provider
  | { type: "fallback" };   // switched off the cloud because it was unavailable

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
  } = {},
): AsyncGenerator<RunEvent> {
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
        disallowedTools: BROWSER_PLUGINS,
        systemPrompt: opts.system ?? agent.systemPrompt,
        permissionMode: "bypassPermissions", // headless: no interactive prompts
        maxTurns: 24,
        includePartialMessages: opts.partial, // token-level text deltas (coder agent)
        env: { ...process.env, ANTHROPIC_BASE_URL: config.routerUrl },
      },
    });

    for await (const message of stream as AsyncIterable<any>) {
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

  // Walk the provider chain Claude → Ollama (if configured) → local. An
  // "unavailable" (capacity/transient) error advances to the next provider; a
  // clean run on any provider returns. If the breaker is already open we skip the
  // doomed cloud round-trip and start at the next tier.
  const ollama = providers.getOllamaFallback();
  const chain = buildChain(config.cloudModel, ollama?.model ?? null, config.localModel);
  const start = fallback.isOpen() ? 1 : 0;

  for (let i = start; i < chain.length; i++) {
    const model = chain[i];
    const isCloud = i === 0;
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
      // Stop (the server then speaks a graceful line) when the error isn't a
      // transient capacity issue, a side-effecting tool already ran this turn
      // (re-running could repeat it — e.g. opening a URL twice), or no provider
      // is left. Nothing is spoken until `done`, so a pre-tool restart is clean.
      if (!fallback.isClaudeUnavailable(err) || toolRan || last) throw err;
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
