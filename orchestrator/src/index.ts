import { ensureBackend } from "./lifecycle.js";
import { startServer } from "./server.js";

async function main() {
  console.log("[jarvis] ensuring hybrid backend (llama :8080 + router :9090)…");
  try {
    await ensureBackend();
    console.log("[jarvis] backend ready");
  } catch (err) {
    console.warn(`[jarvis] backend not ready (${err instanceof Error ? err.message : err}); serving anyway — hybrid agents will fail until it's up`);
  }
  startServer();
}

main().catch((err) => {
  console.error("[jarvis] fatal:", err);
  process.exit(1);
});
