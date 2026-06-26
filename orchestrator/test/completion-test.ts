import assert from "node:assert/strict";
import { classify, assessCompletion, speakVerdict, type TurnEvidence } from "../src/completion.js";

const base: TurnEvidence = {
  task: "implement get_next_line",
  reason: "natural",
  toolRan: true,
  result: "Done — wrote the function.",
  writtenPaths: [],
  filesPresent: true,
  continuationsUsed: 0,
  isLocal: true,
};

// ── classify(): the pure decision tree ──────────────────────────────────────

// 1. Natural completion with a result → done.
assert.equal(classify(base, 2).kind, "done", "natural + result → done");

// 2. Natural but a promised file is missing, budget left → auto-continue.
{
  const v = classify({ ...base, writtenPaths: ["/tmp/gnl.c"], filesPresent: false }, 2);
  assert.equal(v.kind, "continue", "missing file with budget → continue");
}

// 3. Same, but budget exhausted → ask the user (don't loop).
{
  const v = classify({ ...base, writtenPaths: ["/tmp/gnl.c"], filesPresent: false, continuationsUsed: 2 }, 2);
  assert.equal(v.kind, "ask", "missing file, no budget → ask");
}

// 4. Natural but produced nothing and ran no tools → ask.
assert.equal(classify({ ...base, result: "", toolRan: false }, 2).kind, "ask", "empty no-op → ask");

// 5. Stall with budget → continue; with progress but no budget → ask; no progress, no budget → giveup.
assert.equal(classify({ ...base, reason: "stall" }, 2).kind, "continue", "stall + budget → continue");
assert.equal(
  classify({ ...base, reason: "stall", continuationsUsed: 2 }, 2).kind,
  "ask",
  "stall, no budget, has progress → ask",
);
assert.equal(
  classify({ ...base, reason: "stall", continuationsUsed: 2, toolRan: false, result: "" }, 2).kind,
  "giveup",
  "stall, no budget, no progress → giveup",
);

// 6. max_turns behaves like stall (incomplete, continuable).
assert.equal(classify({ ...base, reason: "max_turns" }, 2).kind, "continue", "max_turns + budget → continue");

// 7. A hard error always gives up.
assert.equal(classify({ ...base, reason: "error" }, 2).kind, "giveup", "error → giveup");

// 8. continuationsUsed >= max forbids continue across the board (loop safety).
assert.notEqual(
  classify({ ...base, reason: "max_turns", continuationsUsed: 5 }, 2).kind,
  "continue",
  "exhausted budget must never return continue",
);

// ── assessCompletion(): IO + self-check wiring (deps injected) ───────────────

// 9. Natural + self-check says NOT done & recoverable → continue with its "missing" note.
{
  const v = await assessCompletion(
    { ...base, filesPresent: undefined as any } as any,
    { selfCheck: async () => ({ done: false, missing: "tests still failing", recoverable: true }) },
  );
  assert.equal(v.kind, "continue");
  if (v.kind === "continue") assert.match(v.remaining, /tests still failing/);
}

// 10. Natural + self-check says done → done.
{
  const v = await assessCompletion(
    { task: "x", reason: "natural", toolRan: true, result: "ok", writtenPaths: [], continuationsUsed: 0, isLocal: true },
    { selfCheck: async () => ({ done: true, missing: "", recoverable: true }) },
  );
  assert.equal(v.kind, "done");
}

// 11. Missing file is detected via injected fileExists even when the model claims success.
{
  const v = await assessCompletion(
    { task: "x", reason: "natural", toolRan: true, result: "wrote it", writtenPaths: ["/tmp/nope.c"], continuationsUsed: 0, isLocal: true },
    { fileExists: async () => false, selfCheck: async () => ({ done: true, missing: "", recoverable: true }) },
  );
  assert.equal(v.kind, "continue", "a claimed-but-absent file overrides a 'done' self-check");
}

// 12. speakVerdict renders a spoken line with the options.
{
  const line = speakVerdict({ kind: "giveup", reason: "I couldn't finish.", options: ["try again", "use the cloud"] });
  assert.match(line, /I couldn't finish\./);
  assert.match(line, /try again, or use the cloud/);
}

console.log("completion-test: OK");
process.exit(0);
