import assert from "node:assert/strict";
import { runAct, resolveAct } from "../src/actuation.js";

// A minimal stand-in for the app's WebSocket: it just records what was sent.
class FakeWS {
  sent: any[] = [];
  send(s: string) { this.sent.push(JSON.parse(s)); }
}

// 1. runAct emits a well-formed {type:"act"} and resolves when act_result arrives.
{
  const ws = new FakeWS();
  const p = runAct(ws as any, { action: "open", url: "https://example.com" });
  const sent = ws.sent[0];
  assert.equal(sent.type, "act", "should send an act message");
  assert.equal(sent.action, "open", "should carry the action");
  assert.equal(sent.url, "https://example.com", "should carry the url");
  assert.ok(typeof sent.id === "string" && sent.id.length > 0, "should assign an id");

  resolveAct({ type: "act_result", id: sent.id, ok: true, output: "opened" });
  const r = await p;
  assert.equal(r.ok, true, "result should be ok");
  assert.equal(r.output, "opened", "result should carry output");
}

// 2. A stray/unknown act_result id is ignored (no throw, no cross-talk).
{
  resolveAct({ type: "act_result", id: "does-not-exist", ok: true });
}

// 3. Concurrent calls resolve independently by id.
{
  const ws = new FakeWS();
  const p1 = runAct(ws as any, { action: "applescript", script: "a" });
  const p2 = runAct(ws as any, { action: "capture" });
  const [m1, m2] = ws.sent;
  resolveAct({ type: "act_result", id: m2.id, ok: true, image: "PNGDATA" });
  resolveAct({ type: "act_result", id: m1.id, ok: false, error: "nope" });
  const r2 = await p2;
  const r1 = await p1;
  assert.equal(r2.image, "PNGDATA", "capture call resolves with its image");
  assert.equal(r1.ok, false, "applescript call resolves with its error");
  assert.equal(r1.error, "nope");
}

// 4. Timeout path: a disconnected app yields a graceful error, not a hang.
{
  const ws = new FakeWS();
  const r = await runAct(ws as any, { action: "capture" }, 40);
  assert.equal(r.ok, false, "timeout should be a failed result");
  assert.match(r.error ?? "", /timed out/, "should explain the timeout");
}

console.log("actuation-test: OK");
