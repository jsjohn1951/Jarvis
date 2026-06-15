// Verifies: bare "Hey Jarvis" → greeting (in character, no emoji); and
// "Hey Jarvis, <cmd>" → wake prefix stripped before routing. Local-only.
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";
import { config } from "../src/config.js";

const wss = startServer();
await new Promise((r) => setTimeout(r, 300));

const emoji = /\p{Extended_Pictographic}/u;

async function ask(text: string): Promise<{ via: string; reply: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.wsPort}`);
    let reply = "", via = "";
    ws.on("open", () => ws.send(JSON.stringify({ type: "prompt", text })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "agent") via = `${m.name}/${m.via}`;
      if (m.type === "text") reply += m.delta;
      if (m.type === "done") { ws.close(); resolve({ via, reply: (m.result || reply).trim() }); }
    });
  });
}

const greet = await ask("Hey Jarvis");
console.log("BARE   via:", greet.via, "| emoji:", emoji.test(greet.reply), "|", greet.reply.slice(0, 90));
const cmd = await ask("Hey Jarvis, what is a mutex in one sentence");
console.log("CMD    via:", cmd.via, "| emoji:", emoji.test(cmd.reply), "|", cmd.reply.slice(0, 90));

wss.close();
process.exit(0);
