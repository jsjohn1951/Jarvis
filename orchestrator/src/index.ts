import { ensureBackend } from "./lifecycle.js";
import { startServer } from "./server.js";
import { getSkillsCatalog } from "./skills-catalog.js";
import { loadActiveProjects } from "./project.js";
import { loadOpenSessions } from "./session.js";

async function main() {
  console.log("[jarvis] ensuring hybrid backend (llama :8080 + router :9090)…");
  try {
    await ensureBackend();
    console.log("[jarvis] backend ready");
  } catch (err) {
    console.warn(`[jarvis] backend not ready (${err instanceof Error ? err.message : err}); serving anyway — hybrid agents will fail until it's up`);
  }
  startServer();

  // Warm the skills catalog and surface any resumable state (don't auto-run projects —
  // they resume on the next user interaction). All best-effort.
  void getSkillsCatalog()
    .then((s) => s.length && console.log(`[jarvis] ${s.length} skills available to agents`))
    .catch(() => {});
  void loadActiveProjects()
    .then((ps) => ps.length && console.log(`[jarvis] ${ps.length} project(s) resumable`))
    .catch(() => {});
  void loadOpenSessions()
    .then((ss) => ss.length && console.log(`[jarvis] ${ss.length} open session(s) from a prior run`))
    .catch(() => {});
}

main().catch((err) => {
  console.error("[jarvis] fatal:", err);
  process.exit(1);
});
