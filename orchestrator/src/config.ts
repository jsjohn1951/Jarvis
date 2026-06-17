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

  // Local 9B used when the cloud is unavailable. The name must satisfy the
  // router's routes_to_local() (contains "gguf" / starts with "qwen") so the
  // request is served by llama.cpp on :8080 with tool-call translation.
  localModel: process.env.JARVIS_LOCAL_MODEL ?? "Qwen3.5-9B-Q4_K_M.gguf",
  // Circuit-breaker cooldown: after a Claude-unavailable error, requests go
  // straight to local for this long before the next one probes the cloud again.
  fallbackCooldownMs: Number(process.env.JARVIS_FALLBACK_COOLDOWN_MS ?? 5 * 60_000),

  // Optional second cloud provider (e.g. Ollama Cloud) tried as a fallback BEFORE
  // local. The key + model are supplied at runtime via the app's `provider_config`
  // and persisted to providersFile, which the router reads to route + authenticate.
  providersFile: process.env.JARVIS_PROVIDERS_FILE ?? join(homedir(), ".claude", "router", "providers.json"),
  ollamaBaseUrl: process.env.JARVIS_OLLAMA_BASE_URL ?? "https://ollama.com/v1",

  // Shared secret gating the privileged "editor" role on the :7777 socket. Generated
  // on first run, persisted 0600, and read by the VS Code extension so a random local
  // process can't register as the editor and receive the coder code stream.
  editorTokenFile: process.env.JARVIS_EDITOR_TOKEN_FILE ?? join(homedir(), ".jarvis", "editor-token"),

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
