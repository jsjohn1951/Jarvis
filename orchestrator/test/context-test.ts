// Verifies short-term memory: turn 2 remembers what was said in turn 1.
// Local-only (2B). Was impossible before (stateless orchestrator).
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";
import { config } from "../src/config.js";

const wss = startServer();
await new Promise((r) => setTimeout(r, 300));
const ws = new WebSocket(`ws://127.0.0.1:${config.wsPort}`);
await new Promise((r) => ws.on("open", r));

function ask(text: string): Promise<string> {
  return new Promise((resolve) => {
    let reply = "";
    const onMsg = (raw: Buffer) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "text") reply += m.delta;
      if (m.type === "done") { ws.off("message", onMsg); resolve(reply.trim()); }
    };
    ws.on("message", onMsg);
    ws.send(JSON.stringify({ type: "prompt", text }));
  });
}

const r1 = await ask("My name is Dade and I prefer tabs over spaces.");
console.log("TURN1:", r1.slice(0, 80));
const r2 = await ask("What is my name?");
console.log("TURN2:", r2.slice(0, 80));
console.log(/dade/i.test(r2) ? "PASS: remembered the name" : "FAIL: forgot the name");
ws.close(); wss.close(); process.exit(0);
