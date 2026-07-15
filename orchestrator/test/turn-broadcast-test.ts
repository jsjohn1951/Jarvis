import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// Turn events (prompt echo + agent graph) must reach EVERY desktop/mobile client,
// not just the socket that sent the prompt — the Mac HUD and the phone render one
// shared view of the orchestrator. Model-independent: prompt_echo and the root
// "interpret" spawn are emitted before any model call in handlePrompt.

// Isolate config BEFORE importing the server: ephemeral port + temp token files.
const dir = mkdtempSync(join(tmpdir(), "jarvis-turn-broadcast-"));
const port = 20000 + Math.floor(Math.random() * 10000);
process.env.JARVIS_WS_PORT = String(port);
process.env.JARVIS_MOBILE_TOKEN_FILE = join(dir, "mobile-token");
process.env.JARVIS_EDITOR_TOKEN_FILE = join(dir, "editor-token");

const { startServer } = await import("../src/server.js");
const wss = startServer();
const url = `ws://127.0.0.1:${port}`;

/** Buffers from construction so the synchronous welcome burst can't be missed. */
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
      const timer = setTimeout(() => reject(new Error(`timeout; got: ${JSON.stringify(this.msgs.map((m) => m.type))}`)), timeoutMs);
      this.waiters.push({ done, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }
  ofType(t: string): any[] { return this.msgs.filter((m) => m.type === t); }
}

const token = () => readFileSync(process.env.JARVIS_MOBILE_TOKEN_FILE!, "utf8").trim();

// A desktop (loopback-trusted) and an authenticated mobile client.
const desktop = new Client();
await desktop.until((m) => m.some((x) => x.type === "phone"));
const phone = new Client();
phone.ws.once("open", () => phone.send({ type: "hello", role: "mobile", token: token(), device: "test-phone" }));
await phone.until((m) => m.some((x) => x.type === "hello_ok"));

// 1. The phone prompts → the DESKTOP sees the echo and the root interpret spawn.
phone.send({ type: "prompt", text: "what time is it" });
await desktop.until((m) => m.some((x) => x.type === "agent_spawn"));
assert.equal(desktop.ofType("prompt_echo").at(-1)?.text, "what time is it", "desktop got the phone's prompt echo");
const spawn = desktop.ofType("agent_spawn")[0];
assert.equal(spawn.role, "interpret", "desktop sees the turn's root node");
assert.equal(spawn.parent, undefined, "root node has no parent (clients reset their graph on it)");

// 2. The originating phone gets the graph too, but NOT its own echo.
await phone.until((m) => m.some((x) => x.type === "agent_spawn"));
assert.equal(phone.ofType("prompt_echo").length, 0, "origin never receives its own prompt echo");

// 3. Reverse direction: the desktop prompts → the phone sees echo + graph.
desktop.send({ type: "prompt", text: "jarvis status report" });
await phone.until((m) => m.some((x) => x.type === "prompt_echo"));
assert.equal(phone.ofType("prompt_echo").at(-1)?.text, "jarvis status report", "phone mirrors desktop-initiated turns");

desktop.ws.close();
phone.ws.close();
wss.close();
console.log("turn-broadcast-test: OK");
process.exit(0);
