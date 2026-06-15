// Standalone end-to-end check of the quick tier + dispatcher + WS protocol.
// Starts the server (no ensureBackend), connects, sends a prompt, prints events.
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";
import { config } from "../src/config.js";

const wss = startServer();
await new Promise((r) => setTimeout(r, 300));

const ws = new WebSocket(`ws://127.0.0.1:${config.wsPort}`);
let got = "";

ws.on("open", () => ws.send(JSON.stringify({ type: "prompt", text: "What is a mutex? One sentence." })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "text") got += m.delta;
  else console.log("EVENT", JSON.stringify(m));
  if (m.type === "done") {
    console.log("FINAL_TEXT:", got.slice(0, 160));
    ws.close();
    wss.close();
    process.exit(0);
  }
  if (m.type === "error") {
    console.error("ERROR_EVENT");
    process.exit(1);
  }
});
setTimeout(() => { console.error("TIMEOUT"); process.exit(1); }, 60000);
