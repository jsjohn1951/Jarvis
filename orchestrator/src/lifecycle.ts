import { spawn } from "node:child_process";
import { join } from "node:path";
import { config } from "./config.js";

/** Health of the pieces the app shows in its status row. */
export interface Health {
  llama: boolean; // :8080 (9B, via router)
  router: boolean; // :9090
  quick: boolean; // :8081 (2B)
}

async function ok(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkHealth(): Promise<Health> {
  const [llama, router, quick] = await Promise.all([
    ok("http://127.0.0.1:8080/health"),
    // The router has no /health; a 404 still means it's listening and answering.
    fetch(config.routerUrl, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false),
    ok("http://127.0.0.1:8081/health"),
  ]);
  return { llama, router, quick };
}

/**
 * Ensure the hybrid backend (llama :8080 + router :9090) is up. Reuses the same
 * shell script the zsh `claude-hybrid` function will call, so there's one source
 * of truth for how the backend starts. Idempotent — the script no-ops if already
 * listening. Returns once healthy or throws on timeout.
 */
export async function ensureBackend(): Promise<void> {
  const h = await checkHealth();
  if (h.llama && h.router) return;

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", [join(config.scriptsDir, "hybrid-up.sh")], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`hybrid-up.sh exited ${code}`)),
    );
  });
}
