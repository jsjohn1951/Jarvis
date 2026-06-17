import assert from "node:assert/strict";
import { buildChain } from "../src/runner.js";
import { isClaudeUnavailable } from "../src/fallback.js";

// 1. With no Ollama configured, the chain is just Claude → local (unchanged behavior).
{
  const chain = buildChain("claude-sonnet-4-6", null, "Qwen3.5-9B-Q4_K_M.gguf");
  assert.deepEqual(chain, ["claude-sonnet-4-6", "Qwen3.5-9B-Q4_K_M.gguf"]);
}

// 2. With Ollama configured, it slots BETWEEN Claude and local.
{
  const chain = buildChain("claude-sonnet-4-6", "gpt-oss:120b", "Qwen3.5-9B-Q4_K_M.gguf");
  assert.deepEqual(chain, ["claude-sonnet-4-6", "gpt-oss:120b", "Qwen3.5-9B-Q4_K_M.gguf"]);
  assert.equal(chain[0], "claude-sonnet-4-6", "cloud is always tried first");
  assert.equal(chain[chain.length - 1], "Qwen3.5-9B-Q4_K_M.gguf", "local is always last");
}

// 3. The reported error message must classify as "unavailable" so the chain advances
//    (this is the exact string the HUD showed).
{
  const reported =
    "Claude Code returned an error result: API Error: Server is temporarily limiting requests " +
    "(not your usage limit) · This request would exceed your account's rate limit. Please try again later.";
  assert.equal(isClaudeUnavailable(new Error(reported)), true,
    "the reported rate-limit error must trigger fallback");
}

// 4. Real failures must NOT advance the chain (they surface as errors, not fallback).
{
  for (const m of ["401 Unauthorized", "Authentication failed: invalid api key", "permission denied"]) {
    assert.equal(isClaudeUnavailable(new Error(m)), false, `must not mask: ${m}`);
  }
}

// 5. Guard policy (mirrors runHybrid's catch): advance only when recoverable AND no
//    side-effecting tool ran AND a provider remains.
{
  const shouldAdvance = (recoverable: boolean, toolRan: boolean, last: boolean) =>
    recoverable && !toolRan && !last;
  assert.equal(shouldAdvance(true, false, false), true, "recoverable, no tool, not last → advance");
  assert.equal(shouldAdvance(true, true, false), false, "a tool ran → stop (don't repeat actions)");
  assert.equal(shouldAdvance(true, false, true), false, "last provider → stop (graceful line)");
  assert.equal(shouldAdvance(false, false, false), false, "non-recoverable → stop (surface error)");
}

console.log("fallback-chain-test: OK");
