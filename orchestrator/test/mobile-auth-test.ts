import assert from "node:assert/strict";
import { mkdtempSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTokenStore } from "../src/tokens.js";

// Point the mobile store at a temp file BEFORE importing mobile-auth (config
// reads the env at import time).
const dir = mkdtempSync(join(tmpdir(), "jarvis-mobile-auth-"));
process.env.JARVIS_MOBILE_TOKEN_FILE = join(dir, "mobile-token");
const { ensureToken, verifyToken, isLoopback } = await import("../src/mobile-auth.js");

// 1. makeTokenStore: first ensure generates + persists 0600; later ensures are stable.
{
  const file = join(dir, "store-token");
  const store = makeTokenStore(file);
  const t1 = store.ensure();
  assert.ok(/^[0-9a-f]{48}$/.test(t1), "token is 24 random bytes hex");
  assert.equal(statSync(file).mode & 0o777, 0o600, "token file is 0600");
  assert.equal(store.ensure(), t1, "ensure is stable");
  assert.equal(readFileSync(file, "utf8").trim(), t1, "persisted value matches");
}

// 2. makeTokenStore: an existing file is reused, not overwritten.
{
  const file = join(dir, "existing-token");
  writeFileSync(file, "preexisting-secret\n");
  const store = makeTokenStore(file);
  assert.equal(store.ensure(), "preexisting-secret", "trims and reuses the existing secret");
}

// 3. verify: accepts only the exact secret; rejects empties and non-strings.
{
  const store = makeTokenStore(join(dir, "verify-token"));
  const t = store.ensure();
  assert.equal(store.verify(t), true, "correct token accepted");
  assert.equal(store.verify(t + "x"), false, "wrong token rejected");
  assert.equal(store.verify(""), false, "empty token rejected");
  assert.equal(store.verify(undefined), false, "missing token rejected");
  assert.equal(store.verify(42), false, "non-string token rejected");
}

// 4. mobile-auth wires the store to config.mobileTokenFile.
{
  const t = ensureToken();
  assert.equal(readFileSync(process.env.JARVIS_MOBILE_TOKEN_FILE!, "utf8").trim(), t, "mobile token persisted at the configured path");
  assert.equal(statSync(process.env.JARVIS_MOBILE_TOKEN_FILE!).mode & 0o777, 0o600, "mobile token file is 0600");
  assert.equal(verifyToken(t), true);
  assert.equal(verifyToken("nope"), false);
}

// 5. isLoopback matrix: v4, v6, v4-mapped-v6 loopbacks in; everything else out.
{
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("127.0.0.53"), true, "whole 127/8 counts");
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("::ffff:127.0.0.1"), true, "v4-mapped loopback counts");
  assert.equal(isLoopback("192.168.1.20"), false, "LAN peer is remote");
  assert.equal(isLoopback("::ffff:192.168.1.20"), false, "v4-mapped LAN peer is remote");
  assert.equal(isLoopback("100.101.102.103"), false, "tailnet peer is remote");
  assert.equal(isLoopback(undefined), false, "missing address is never trusted");
}

console.log("mobile-auth-test: OK");
