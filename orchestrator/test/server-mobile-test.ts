import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// Isolate config BEFORE importing the server: ephemeral port + temp token files.
const dir = mkdtempSync(join(tmpdir(), "jarvis-server-mobile-"));
const port = 20000 + Math.floor(Math.random() * 10000);
process.env.JARVIS_WS_PORT = String(port);
process.env.JARVIS_MOBILE_TOKEN_FILE = join(dir, "mobile-token");
process.env.JARVIS_EDITOR_TOKEN_FILE = join(dir, "editor-token");

const { startServer } = await import("../src/server.js");
const wss = startServer();
const url = `ws://127.0.0.1:${port}`;

/** A client whose message buffer starts filling at CONSTRUCTION — the server's
 *  welcome burst is sent synchronously on connect, before any later listener
 *  could attach, so buffering must not race it. */
class Client {
  ws: WebSocket;
  msgs: any[] = [];
  private waiters: { done: (msgs: any[]) => boolean; resolve: (m: any[]) => void }[] = [];
  constructor() {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      this.msgs.push(JSON.parse(raw.toString()));
      this.waiters = this.waiters.filter((w) => !(w.done(this.msgs) && (w.resolve(this.msgs), true)));
    });
  }
  send(msg: unknown) { this.ws.send(JSON.stringify(msg)); }
  until(done: (msgs: any[]) => boolean, timeoutMs = 4000): Promise<any[]> {
    if (done(this.msgs)) return Promise.resolve(this.msgs);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; got: ${types(this.msgs).join(",")}`)), timeoutMs);
      this.waiters.push({ done, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }
}

const types = (msgs: any[]) => msgs.map((m) => m.type);

// 1. REGRESSION: a loopback client that never says hello (the Mac app) still gets
//    the welcome burst — agents + models immediately, health when the check lands.
{
  const c = new Client();
  const msgs = await c.until((m) => ["health", "agents", "models"].every((t) => types(m).includes(t)));
  assert.ok(msgs.find((m) => m.type === "agents")?.list?.length > 0, "agents list is populated");
  assert.ok(Array.isArray(msgs.find((m) => m.type === "models")?.list), "models list arrives");
  c.ws.close();
}

// 2. A loopback client sending a valid mobile hello is acknowledged with hello_ok
//    (this is exactly what the iOS simulator does) and then welcomed.
{
  const token = readFileSync(process.env.JARVIS_MOBILE_TOKEN_FILE!, "utf8").trim();
  const c = new Client();
  c.ws.once("open", () => c.send({ type: "hello", role: "mobile", token, device: "test-suite" }));
  const msgs = await c.until((m) => types(m).includes("hello_ok") && types(m).includes("models"));
  assert.equal(msgs.find((m) => m.type === "hello_ok")?.role, "mobile");

  // 3. Mobile role is fenced off the desktop-only controls.
  c.send({ type: "shutdown" });
  await c.until((m) => m.some((x) => x.type === "error" && /Mac app/.test(x.message)));
  c.send({ type: "swap", model: "whatever.gguf" });
  await c.until((m) => m.filter((x) => x.type === "error" && /Mac app/.test(x.message)).length >= 2);
  c.ws.close();
}

// 4. A bad mobile token closes the socket (4001).
{
  const c = new Client();
  c.ws.once("open", () => c.send({ type: "hello", role: "mobile", token: "wrong" }));
  const code = await new Promise<number>((res) => c.ws.once("close", (x) => res(x)));
  assert.equal(code, 4001, "bad token → close 4001");
}

wss.close();
console.log("server-mobile-test: OK");
process.exit(0);
