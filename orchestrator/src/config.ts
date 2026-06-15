import { homedir } from "node:os";
import { join } from "node:path";

/** Central config. Override any value via env without touching code. */
export const config = {
  // WebSocket the SwiftUI app connects to.
  wsPort: Number(process.env.JARVIS_WS_PORT ?? 7777),

  // Existing hybrid backend (do not change unless the router/llama ports move).
  routerUrl: process.env.JARVIS_ROUTER_URL ?? "http://127.0.0.1:9090",
  // The 'quick' tier — 2B served directly (see scripts/llama-quick.sh).
  quickUrl: process.env.JARVIS_QUICK_URL ?? "http://127.0.0.1:8081/v1",
  quickModel: process.env.JARVIS_QUICK_MODEL ?? "Qwen3.5-2B-Q4_K_M.gguf",

  // Cloud model for the main turn of hybrid agents (routes through the router
  // to Anthropic). Subagents declared with the local model fall through to llama.
  cloudModel: process.env.JARVIS_CLOUD_MODEL ?? "claude-sonnet-4-6",

  // Where the `dev` agent operates. Defaults to the user's home — set per-project.
  repoDir: process.env.JARVIS_REPO ?? homedir(),

  // Project root + the scripts/memory/personality dirs derived from it.
  root: process.env.JARVIS_ROOT ?? join(homedir(), "Desktop", "jarvis"),
  get scriptsDir() { return process.env.JARVIS_SCRIPTS ?? join(this.root, "scripts"); },
  get memoryDir() { return process.env.JARVIS_MEMORY ?? join(this.root, "memory"); },
  get personalityDir() { return process.env.JARVIS_PERSONALITY ?? join(this.root, "personality"); },

  // Memory tuning.
  shortTermTurns: Number(process.env.JARVIS_SHORT_TERM_TURNS ?? 12),   // turns kept in the live buffer
  consolidateEvery: Number(process.env.JARVIS_CONSOLIDATE_EVERY ?? 8), // turns between cloud consolidations
  maxMemoryChars: Number(process.env.JARVIS_MAX_MEMORY_CHARS ?? 4000), // cap on injected long-term context
};
