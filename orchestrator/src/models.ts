import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { config } from "./config.js";

const MODELS_DIR = process.env.MODELS_DIR ?? join(homedir(), "models");

// The GGUF currently loaded on :8080 (the 9B slot the router/subagents use).
let currentModel = process.env.JARVIS_MODEL_9B ?? "Qwen3.5-9B-Q4_K_M.gguf";

export function listModels(): string[] {
  try {
    return readdirSync(MODELS_DIR).filter((f) => f.endsWith(".gguf")).sort();
  } catch {
    return [];
  }
}

export const getCurrentModel = () => currentModel;

/**
 * Hot-swap the model on :8080. Restarts llama-server with a different GGUF — used
 * when an agent needs a specialist that can't co-reside with the 9B under the
 * ~14.3 GB GPU budget. Interrupts any in-flight local-subagent work (~model load
 * time). The router routes by model *name* to :8080, so whatever is loaded here
 * serves local subagent calls.
 */
export async function swapModel(file: string, parallel = 1): Promise<void> {
  if (!listModels().includes(file)) throw new Error(`unknown model: ${file}`);
  if (file === currentModel) return;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", [join(config.scriptsDir, "llama-swap.sh"), file], {
      stdio: "inherit",
      // >1 makes llama-swap.sh start the server with --parallel N -cb (continuous
      // batching), so the PM can run several coder tasks concurrently on one model.
      env: { ...process.env, LLAMA_PARALLEL: String(parallel) },
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`llama-swap exited ${code}`))));
  });
  currentModel = file;
}

/**
 * Hot-swap the dedicated coder model onto :8080 for a local coding project, with
 * continuous batching (config.coderParallel slots) so coder tasks can run concurrently.
 * Idempotent; returns false (without throwing) if the GGUF isn't installed so the PM
 * can degrade to whatever is already loaded rather than abort the whole project.
 */
export async function ensureCoderLoaded(): Promise<boolean> {
  if (currentModel === config.coderModel) return true;
  if (!listModels().includes(config.coderModel)) return false;
  await swapModel(config.coderModel, config.coderParallel);
  return true;
}

/** Restore the default 9B on :8080 after a coding project (single slot). */
export async function restore9B(): Promise<void> {
  if (currentModel === config.localModel) return;
  if (listModels().includes(config.localModel)) await swapModel(config.localModel, 1);
}
