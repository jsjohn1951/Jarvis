import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import type { AgentDef } from "./agents/index.js";

export type RunEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "result"; text: string };

/**
 * Run a hybrid agent (Claude Code via the router) and yield stream events.
 *
 * The key line is `env.ANTHROPIC_BASE_URL = config.routerUrl`: every request the
 * agent makes goes to the local router, which sends the main turn to cloud Sonnet
 * and any locally-modelled subagents to llama.cpp — i.e. exactly claude-hybrid,
 * but driven programmatically.
 */
export async function* runHybrid(agent: AgentDef, prompt: string): AsyncGenerator<RunEvent> {
  const stream = query({
    prompt,
    options: {
      model: config.cloudModel,
      cwd: agent.cwd ?? config.repoDir,
      allowedTools: agent.allowedTools,
      systemPrompt: agent.systemPrompt,
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
    }
  }
}
