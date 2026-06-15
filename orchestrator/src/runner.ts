import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import type { AgentDef } from "./agents/index.js";
import * as fallback from "./fallback.js";

export type RunEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "result"; text: string }
  | { type: "fallback" }; // switched to the local 9B because the cloud was unavailable

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

/**
 * One-shot cloud (Sonnet via the router → Pro subscription) text completion, no
 * tools. Used by memory consolidation. Returns the final result text.
 */
export async function cloudComplete(prompt: string, system?: string): Promise<string> {
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
