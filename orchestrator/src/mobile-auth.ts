import { config } from "./config.js";
import { makeTokenStore } from "./tokens.js";

/**
 * Auth for remote (non-loopback) clients — the iOS app.
 *
 * The server only ever binds beyond loopback when JARVIS_WS_HOST is set (e.g. by
 * scripts/ios-package.sh for tailnet access). A remote socket is quarantined at
 * connect: nothing is sent to it and only `{type:"hello", role:"mobile", token}`
 * is honored until the token matches this store. Loopback clients (the Mac app,
 * the VS Code extension, the iOS simulator) are trusted exactly as before.
 */

const store = makeTokenStore(config.mobileTokenFile);

export const ensureToken = store.ensure;
export const verifyToken = store.verify;

/** True when the peer address is loopback (IPv4 127/8, IPv6 ::1, or v4-mapped). */
export function isLoopback(addr?: string): boolean {
  if (!addr) return false;
  if (addr === "::1") return true;
  const v4 = addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr;
  return v4.startsWith("127.");
}
