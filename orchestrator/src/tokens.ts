import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/**
 * File-backed shared secret for gating privileged roles on the :7777 socket.
 * One store per role (editor, mobile). The secret is generated on first run,
 * persisted 0600, and read out-of-band by the client that needs it (the VS Code
 * extension reads the file; the phone receives it via the pairing QR).
 */

export interface TokenStore {
  /** Load the token, generating + persisting it 0600 on first run. */
  ensure(): string;
  /** True when `token` matches the secret. */
  verify(token: unknown): boolean;
}

export function makeTokenStore(file: string): TokenStore {
  let secret = "";
  const ensure = (): string => {
    if (secret) return secret;
    try {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return (secret = existing);
    } catch { /* not created yet */ }
    secret = randomBytes(24).toString("hex");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
    return secret;
  };
  return {
    ensure,
    verify: (token) => typeof token === "string" && token.length > 0 && token === ensure(),
  };
}
