import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

// Isolate config BEFORE importing the server: ephemeral port + temp token files.
const dir = mkdtempSync(join(tmpdir(), "jarvis-phone-broadcast-"));
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
      const timer = setTimeout(() => reject(new Error(`timeout; got: ${JSON.stringify(this.msgs.map((m) => m.type))}`)), timeoutMs);
      this.waiters.push({ done, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.ws.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }
  phones(): any[] { return this.msgs.filter((m) => m.type === "phone"); }
  lastPhone(): any { return this.phones().at(-1); }
}

const token = () => readFileSync(process.env.JARVIS_MOBILE_TOKEN_FILE!, "utf8").trim();
const mobileHello = (c: Client, device: string) =>
  c.ws.once("open", () => c.send({ type: "hello", role: "mobile", token: token(), device }));

// 1. A desktop client's welcome burst reports no phone.
const desktop = new Client();
await desktop.until((m) => m.some((x) => x.type === "phone"));
assert.equal(desktop.lastPhone().connected, false, "welcome reports no phone yet");

// 2. A phone authenticates → the desktop is told, with the device name.
const phoneA = new Client();
mobileHello(phoneA, "test-phone");
await desktop.until(() => desktop.lastPhone()?.connected === true);
assert.equal(desktop.lastPhone().device, "test-phone", "broadcast carries device name");

// 3. A desktop connecting AFTER the phone learns the state from its welcome burst.
{
  const late = new Client();
  await late.until((m) => m.some((x) => x.type === "phone"));
  assert.equal(late.lastPhone().connected, true, "late desktop welcome says phone connected");
  late.ws.close();
}

// 4. Two phones; the first leaves → still connected (count-based status).
const phoneB = new Client();
mobileHello(phoneB, "phone-b");
await desktop.until(() => desktop.phones().length >= 3);
phoneA.ws.close();
await desktop.until(() => desktop.phones().length >= 4);
assert.equal(desktop.lastPhone().connected, true, "one phone left → still connected");
assert.equal(desktop.lastPhone().device, "phone-b", "remaining phone's device reported");

// 5. The last phone leaves → disconnected.
phoneB.ws.close();
await desktop.until(() => desktop.lastPhone()?.connected === false);
assert.equal(desktop.lastPhone().device, undefined, "no device once nothing is connected");

desktop.ws.close();
wss.close();
console.log("phone-broadcast-test: OK");
process.exit(0);
