import assert from "node:assert/strict";
import { makeAct } from "../src/tools.js";
import { resolveAct } from "../src/actuation.js";

// A minimal stand-in for the app's WebSocket: it just records what was sent.
class FakeWS {
  sent: any[] = [];
  send(s: string) { this.sent.push(JSON.parse(s)); }
}

// 1. No desktop app connected → immediate graceful error, no timeout, nothing sent.
{
  const act = makeAct(() => undefined);
  const r = await act({ action: "applescript", script: "beep" });
  assert.equal(r.ok, false, "must fail without a desktop actuator");
  assert.match(r.error ?? "", /no desktop Jarvis app connected/, "explains the missing desktop app");
}

// 2. With a desktop app the request is forwarded and its result returned.
{
  const ws = new FakeWS();
  const act = makeAct(() => ws as any);
  const p = act({ action: "open", url: "https://example.com" });
  const sent = ws.sent[0];
  assert.equal(sent.type, "act", "forwards an act message to the desktop app");
  resolveAct({ type: "act_result", id: sent.id, ok: true, output: "opened" });
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.output, "opened");
}

// 3. The actuator is resolved PER CALL: a desktop app appearing between calls is
//    picked up without rebuilding the tools (reconnect mid-turn).
{
  let current: FakeWS | undefined;
  const act = makeAct(() => current as any);
  const r1 = await act({ action: "capture" });
  assert.equal(r1.ok, false, "first call fails while disconnected");

  current = new FakeWS();
  const p2 = act({ action: "capture" });
  const sent = current.sent[0];
  assert.equal(sent.action, "capture", "second call reaches the reconnected app");
  resolveAct({ type: "act_result", id: sent.id, ok: true, image: "PNGDATA" });
  const r2 = await p2;
  assert.equal(r2.image, "PNGDATA");
}

console.log("act-routing-test: OK");
