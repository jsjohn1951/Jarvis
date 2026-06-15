import { config } from "./config.js";

/**
 * Circuit breaker for cloud (Claude) availability. When the cloud returns a
 * rate-limit/overload error, we `trip()` it; while `isOpen()` is true, callers
 * route to the local 9B instead of paying a doomed cloud round-trip. Recovery is
 * lazy: once the cooldown elapses, `isOpen()` returns false and the next request
 * probes the cloud again (which re-trips on failure, or `reset()`s on success).
 */
let trippedAt: number | null = null;

export function isOpen(): boolean {
  return trippedAt !== null && Date.now() - trippedAt < config.fallbackCooldownMs;
}

export function trip(): void {
  trippedAt = Date.now();
}

export function reset(): void {
  trippedAt = null;
}

/**
 * Policy predicate — the human-judgment seam.
 *
 * Returns true when `err` means "the cloud is temporarily unavailable, so trying
 * the local model is the right move" (capacity rate limits, overload, transient
 * network failures). Returns false when it means "a real failure we must NOT
 * mask behind a local answer" (auth/permission problems, genuine agent errors) —
 * those should surface to the user unchanged.
 */
export function isClaudeUnavailable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();

  // A purely-numeric token (an HTTP status) matches only when it isn't embedded
  // in a larger number — so "504" doesn't match inside "15042". Textual tokens
  // match as plain substrings.
  const has = (tokens: string[]): boolean =>
    tokens.some((t) =>
      /^\d+$/.test(t) ? new RegExp(`(?<![0-9])${t}(?![0-9])`).test(msg) : msg.includes(t),
    );

  // Real failures first: never mask these, even if other words also match.
  if (has([
    "authentication", "unauthorized", "invalid api key", "invalid_api_key",
    "oauth", "permission", "401", "403",
  ])) return false;

  // Cloud-capacity / transient errors: safe to fall back to local.
  return has([
    "rate limit", "rate_limit", "temporarily limiting", "exceed your account",
    "overloaded", "529", "502", "503", "504", "429",
    "timeout", "timed out", "etimedout", "econnrefused", "econnreset",
    "socket hang up", "fetch failed", "network error",
  ]);
}
