import assert from "node:assert/strict";
import { resolve } from "node:path";
import { safeResolveInBase } from "../src/paths.js";

const base = "/Users/me/repo";

// Allowed: ordinary relative paths inside the repo.
assert.equal(safeResolveInBase(base, "src/foo.ts"), resolve(base, "src/foo.ts"));
assert.equal(safeResolveInBase(base, "a/b/c.txt"), resolve(base, "a/b/c.txt"));
assert.equal(safeResolveInBase(base, "./nested/file.js"), resolve(base, "nested/file.js"));

// Refused: traversal, absolute paths, the base itself, NUL bytes, empties.
for (const bad of [
  "../outside.ts",
  "../../etc/passwd",
  "src/../../escape.ts",
  "/etc/passwd",
  "",
  ".",
  "foo\0.ts",
]) {
  assert.equal(safeResolveInBase(base, bad), null, `should refuse: ${JSON.stringify(bad)}`);
}

// A `..` that stays inside is fine (normalised back under base).
assert.equal(safeResolveInBase(base, "src/sub/../foo.ts"), resolve(base, "src/foo.ts"));

console.log("paths: all assertions passed");
