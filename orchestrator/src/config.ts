import { homedir } from "node:os";
import { join } from "node:path";

/** Central config. Override any value via env without touching code. */
export const config = {
  // WebSocket the SwiftUI app connects to.
  wsPort: Number(process.env.JARVIS_WS_PORT ?? 7777),
  // Host the WebSocket binds to. Default loopback-only. scripts/ios-package.sh sets
  // JARVIS_WS_HOST=0.0.0.0 so the iOS client can connect over the tailnet — remote
  // (non-loopback) sockets must then authenticate with the mobile token.
  wsHost: process.env.JARVIS_WS_HOST ?? "127.0.0.1",

  // Existing hybrid backend (do not change unless the router/llama ports move).
  routerUrl: process.env.JARVIS_ROUTER_URL ?? "http://127.0.0.1:9090",
  // The 'quick' tier — 2B served directly (see scripts/llama-quick.sh). Used for
  // cheap INTERNAL utility only: dispatch classification, addressee triage, memory
  // retrieve/capture, completion self-check. NOT user-facing conversation.
  quickUrl: process.env.JARVIS_QUICK_URL ?? "http://127.0.0.1:8081/v1",
  quickModel: process.env.JARVIS_QUICK_MODEL ?? "Qwen3.5-2B-Q4_K_M.gguf",

  // The 'conversation' tier — Gemma 3 4B served directly on :8083, always on (see
  // scripts/llama-convo.sh). Handles USER-FACING dialog: the instant ack, greetings,
  // smalltalk and the local factual answer. A separate server from the 2B so the
  // capable-but-slower conversation model never blocks the cheap internal classifiers.
  convoUrl: process.env.JARVIS_CONVO_URL ?? "http://127.0.0.1:8083/v1",
  convoModel: process.env.JARVIS_CONVO_MODEL ?? "gemma-3-4b-it-Q4_K_M.gguf",

  // Cloud model for the main turn of hybrid agents (routes through the router
  // to Anthropic). Subagents declared with the local model fall through to llama.
  cloudModel: process.env.JARVIS_CLOUD_MODEL ?? "claude-sonnet-4-6",

  // Local 9B used when the cloud is unavailable. The name must satisfy the
  // router's routes_to_local() (contains "gguf" / starts with "qwen") so the
  // request is served by llama.cpp on :8080 with tool-call translation.
  localModel: process.env.JARVIS_LOCAL_MODEL ?? "Qwen3.5-9B-Q4_K_M.gguf",
  // Dedicated local CODER model — hot-swapped onto the :8080 slot (displacing the 9B)
  // while a coding project runs locally. Name must contain "gguf" so the router's
  // routes_to_local() sends it to :8080 with tool-call translation.
  coderModel: process.env.JARVIS_CODER_MODEL ?? "qwen2.5-coder-7b-instruct-q4_k_m.gguf",
  // Max coder tasks the PM may dispatch concurrently against the -np 2 -cb coder server.
  coderParallel: Number(process.env.JARVIS_CODER_PARALLEL ?? 2),
  // Circuit-breaker cooldown: after a Claude-unavailable error, requests go
  // straight to local for this long before the next one probes the cloud again.
  fallbackCooldownMs: Number(process.env.JARVIS_FALLBACK_COOLDOWN_MS ?? 5 * 60_000),

  // Stall watchdog: max time a hybrid agent's SDK stream may go SILENT (no new
  // message/token) before we abort it. Local GGUFs can wedge mid-turn (looping a
  // tool, or a stream that never closes); this guarantees the turn ends instead of
  // hanging the HUD on "THINKING" forever. Idle-reset, so a slow-but-progressing
  // turn is never killed — only true silence.
  localStallMs: Number(process.env.JARVIS_LOCAL_STALL_MS ?? 60_000),
  // Same idea for the CLOUD tier, but a longer budget: Sonnet can be slow to first
  // token under load, and a hung cloud connection is rarer — so we wait longer before
  // aborting (a cloud StallError is "advanceable" and falls through to local anyway).
  cloudStallMs: Number(process.env.JARVIS_CLOUD_STALL_MS ?? 180_000),
  // Max times the completion verifier may auto-continue an incomplete job before it
  // must instead ask the user or give up — bounds runaway self-continuation.
  maxContinuations: Number(process.env.JARVIS_MAX_CONTINUATIONS ?? 2),
  // Per-turn agentic step cap. The cloud path keeps the SDK default headroom; the
  // local tier gets a tighter cap so a confused small model can't burn turns.
  cloudMaxTurns: Number(process.env.JARVIS_CLOUD_MAX_TURNS ?? 24),
  localMaxTurns: Number(process.env.JARVIS_LOCAL_MAX_TURNS ?? 16),

  // Optional second cloud provider (e.g. Ollama Cloud) tried as a fallback BEFORE
  // local. The key + model are supplied at runtime via the app's `provider_config`
  // and persisted to providersFile, which the router reads to route + authenticate.
  providersFile: process.env.JARVIS_PROVIDERS_FILE ?? join(homedir(), ".claude", "router", "providers.json"),
  ollamaBaseUrl: process.env.JARVIS_OLLAMA_BASE_URL ?? "https://ollama.com/v1",

  // Shared secret gating the privileged "editor" role on the :7777 socket. Generated
  // on first run, persisted 0600, and read by the VS Code extension so a random local
  // process can't register as the editor and receive the coder code stream.
  editorTokenFile: process.env.JARVIS_EDITOR_TOKEN_FILE ?? join(homedir(), ".jarvis", "editor-token"),
  // Shared secret gating the remote "mobile" role (iOS client). Same pattern as the
  // editor token; delivered to the phone via the pairing QR from scripts/ios-package.sh.
  mobileTokenFile: process.env.JARVIS_MOBILE_TOKEN_FILE ?? join(homedir(), ".jarvis", "mobile-token"),

  // Where the `dev` agent operates. Defaults to the user's home — set per-project.
  repoDir: process.env.JARVIS_REPO ?? homedir(),

  // Project root + the scripts/memory/personality dirs derived from it.
  root: process.env.JARVIS_ROOT ?? join(homedir(), "Desktop", "jarvis"),
  get scriptsDir() { return process.env.JARVIS_SCRIPTS ?? join(this.root, "scripts"); },
  get memoryDir() { return process.env.JARVIS_MEMORY ?? join(this.root, "memory"); },
  get personalityDir() { return process.env.JARVIS_PERSONALITY ?? join(this.root, "personality"); },
  // Persisted conversation sessions and PM projects (one JSON file each).
  get sessionsDir() { return process.env.JARVIS_SESSIONS ?? join(this.memoryDir, "sessions"); },
  get projectsDir() { return process.env.JARVIS_PROJECTS ?? join(this.memoryDir, "projects"); },

  // Memory tuning.
  shortTermTurns: Number(process.env.JARVIS_SHORT_TERM_TURNS ?? 12),   // turns kept in the live buffer
  consolidateEvery: Number(process.env.JARVIS_CONSOLIDATE_EVERY ?? 8), // turns between cloud consolidations
  maxMemoryChars: Number(process.env.JARVIS_MAX_MEMORY_CHARS ?? 4000), // cap on injected long-term context

  // PM pipeline tuning: how many times one coder task may be auto-re-attempted (on an
  // incomplete verdict or a reviewer rejection) before it's marked failed.
  projectMaxTaskContinuations: Number(process.env.JARVIS_PROJECT_TASK_CONTINUATIONS ?? 2),
};
