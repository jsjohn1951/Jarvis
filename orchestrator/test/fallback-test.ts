import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { isOpen, trip, reset, isClaudeUnavailable } from "../src/fallback.js";

// Use a tiny cooldown so the test runs fast.
config.fallbackCooldownMs = 50;

// 1. Breaker starts closed.
reset();
assert.equal(isOpen(), false, "breaker should start closed");

// 2. trip() opens it, and it stays open within the cooldown.
trip();
assert.equal(isOpen(), true, "breaker should be open right after trip()");

// 3. After the cooldown elapses it closes again (lazy recovery, no timer).
await new Promise((r) => setTimeout(r, 70));
assert.equal(isOpen(), false, "breaker should close after cooldown");

// 4. reset() clears an open breaker immediately.
trip();
reset();
assert.equal(isOpen(), false, "reset() should clear the breaker");

// 5. Predicate: cloud-availability errors → true.
for (const m of [
  "API Error: Server is temporarily limiting requests",
  "This request would exceed your account's rate limit",
  "Error: overloaded_error (529)",
  "fetch failed",
  "connect ECONNREFUSED 127.0.0.1:443",
]) {
  assert.equal(isClaudeUnavailable(new Error(m)), true, `should be unavailable: ${m}`);
}

// 6. Predicate: real failures → false (must not be masked).
for (const m of [
  "Authentication failed: invalid api key",
  "401 Unauthorized",
  "TypeError: cannot read property 'x' of undefined",
]) {
  assert.equal(isClaudeUnavailable(new Error(m)), false, `should NOT be unavailable: ${m}`);
}

// 6b. Deny-list wins when both lists would match (priority ordering is the
//     core safety property — an auth error must never be treated as unavailable).
assert.equal(
  isClaudeUnavailable(new Error("503 authentication required")),
  false,
  "deny-list (authentication) must beat allow-list (503)",
);

// 6c. Numeric status codes are word-bounded — they must not match inside a
//     larger number, or unrelated errors would wrongly trigger fallback.
assert.equal(
  isClaudeUnavailable(new Error("RangeError at offset 15042")),
  false,
  "504 inside 15042 must not count as unavailable",
);

console.log("fallback-test: OK");
process.exit(0);
