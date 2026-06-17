import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

/**
 * Alternate cloud providers used as a fallback before local (currently Ollama
 * Cloud). The app collects the key in its Settings pane and pushes it over the
 * WebSocket as a `provider_config` message; we persist it 0600 to `providersFile`
 * so the **router** can read it to route + authenticate (it keeps full tool use,
 * unlike a direct text-only call). State is also held in-memory for the runner's
 * fallback chain.
 */
export interface OllamaProvider {
  enabled: boolean;
  model: string;
  apiKey: string;
  baseUrl: string;
}

interface ProvidersState {
  ollama?: OllamaProvider;
}

let state: ProvidersState = load();

function load(): ProvidersState {
  try {
    return JSON.parse(readFileSync(config.providersFile, "utf8")) as ProvidersState;
  } catch {
    return {};
  }
}

/**
 * The Ollama fallback the runner should insert into its chain — only when it's
 * enabled and actually usable (has a key + model). Returns the model name the
 * router keys on, or null to skip the tier (chain becomes just Claude → local).
 */
export function getOllamaFallback(): { model: string } | null {
  const o = state.ollama;
  return o && o.enabled && o.apiKey && o.model ? { model: o.model } : null;
}

/** Apply a `provider_config` message from the app and persist it for the router. */
export function applyProviderConfig(msg: any): void {
  if (msg?.provider !== "ollama") return;
  const ollama: OllamaProvider = {
    enabled: msg.enabled === true,
    model: typeof msg.model === "string" ? msg.model.trim() : "",
    apiKey: typeof msg.apiKey === "string" ? msg.apiKey : "",
    baseUrl: typeof msg.baseUrl === "string" && msg.baseUrl ? msg.baseUrl : config.ollamaBaseUrl,
  };
  state = { ...state, ollama };
  persist();
}

function persist(): void {
  try {
    mkdirSync(dirname(config.providersFile), { recursive: true });
    // 0600 — the file holds the API key in plaintext (router reads it per request).
    writeFileSync(config.providersFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error("[jarvis] failed to write providers.json:", err);
  }
}
