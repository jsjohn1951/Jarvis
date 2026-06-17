import assert from "node:assert/strict";
import { CodeStreamRouter } from "../src/code-stream.js";

/** Run a sequence of pushed deltas through the router and collect what it emitted. */
function run(deltas: string[]) {
  const out = { narration: "", code: "", path: "", begins: 0, ends: 0 };
  const r = new CodeStreamRouter({
    onNarration: (d) => (out.narration += d),
    onCodeBegin: (p) => { out.path = p; out.begins++; },
    onCodeDelta: (d) => (out.code += d),
    onCodeEnd: () => out.ends++,
  });
  for (const d of deltas) r.push(d);
  r.flush();
  return out;
}

// 1. Whole message in one delta: narration and code split correctly.
{
  const o = run([`Here you go.\n<<<JARVIS_WRITE path="src/foo.ts">>>const x = 1;\n<<<JARVIS_END>>>`]);
  assert.equal(o.narration, "Here you go.\n");
  assert.equal(o.path, "src/foo.ts");
  assert.equal(o.code, "const x = 1;\n");
  assert.equal(o.begins, 1);
  assert.equal(o.ends, 1);
}

// 2. Open marker split across many tiny deltas — must NOT leak marker chars as narration.
{
  const full = `Sure.\n<<<JARVIS_WRITE path="a.ts">>>let y = 2;<<<JARVIS_END>>>`;
  const o = run(full.split("")); // one char at a time — the worst case
  assert.equal(o.narration, "Sure.\n", `narration leaked: ${JSON.stringify(o.narration)}`);
  assert.equal(o.path, "a.ts");
  assert.equal(o.code, "let y = 2;");
  assert.equal(o.ends, 1);
}

// 3. Close marker split across two deltas — must not emit a half-marker as code.
{
  const o = run([`<<<JARVIS_WRITE path="b.ts">>>body`, `body<<<JARVIS_`, `END>>>trailing`]);
  assert.equal(o.code, "bodybody", `code leaked a marker: ${JSON.stringify(o.code)}`);
  assert.equal(o.narration, "trailing");
  assert.equal(o.ends, 1);
}

// 4. Unterminated code block (model stopped early) — flush still closes + keeps the body.
{
  const o = run([`<<<JARVIS_WRITE path="c.ts">>>half written`]);
  assert.equal(o.code, "half written");
  assert.equal(o.ends, 1, "flush must end an unterminated block so the file saves");
}

// 5. No markers at all → pure narration, no code stream opened.
{
  const o = run([`just talking`, `, no code here`]);
  assert.equal(o.narration, "just talking, no code here");
  assert.equal(o.begins, 0);
  assert.equal(o.ends, 0);
}

console.log("code-stream: all assertions passed");
