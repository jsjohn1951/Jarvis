import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the providers module at a throwaway file BEFORE importing it (it reads
// config.providersFile at load time).
const dir = mkdtempSync(join(tmpdir(), "jarvis-providers-"));
const file = join(dir, "providers.json");
process.env.JARVIS_PROVIDERS_FILE = file;

const providers = await import("../src/providers.js");

try {
  // 1. Nothing configured → no Ollama fallback.
  assert.equal(providers.getOllamaFallback(), null, "starts with no fallback");

  // 2. A fully-configured, enabled provider becomes the fallback model.
  providers.applyProviderConfig({
    type: "provider_config", provider: "ollama",
    enabled: true, model: "gpt-oss:120b", apiKey: "sk-test",
  });
  assert.deepEqual(providers.getOllamaFallback(), { model: "gpt-oss:120b" });

  // 3. The file is written 0600 (it holds the API key in plaintext for the router).
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `providers.json must be 0600, got ${mode.toString(8)}`);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(onDisk.ollama.apiKey, "sk-test", "key persisted for the router to read");

  // 4. Disabled or key-less config → no fallback (chain stays Claude → local).
  providers.applyProviderConfig({ provider: "ollama", enabled: false, model: "gpt-oss:120b", apiKey: "sk-test" });
  assert.equal(providers.getOllamaFallback(), null, "disabled → skipped");
  providers.applyProviderConfig({ provider: "ollama", enabled: true, model: "gpt-oss:120b", apiKey: "" });
  assert.equal(providers.getOllamaFallback(), null, "missing key → skipped");

  // 5. A non-ollama provider message is ignored, not crashed on.
  providers.applyProviderConfig({ provider: "something-else" });

  console.log("providers-test: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
