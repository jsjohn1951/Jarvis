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

  // Scripts that bring the backend up (shared with the zsh function).
  scriptsDir: process.env.JARVIS_SCRIPTS ?? join(homedir(), "Desktop", "jarvis", "scripts"),
} as const;
