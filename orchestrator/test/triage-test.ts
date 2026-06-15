// Verifies addressee triage: utterances that mention "Jarvis" are answered only
// when actually addressing it. Local-only (2B).
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";
import { config } from "../src/config.js";

const wss = startServer();
await new Promise((r) => setTimeout(r, 300));

function ask(text: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.wsPort}`);
    let reply = "", outcome = "";
    ws.on("open", () => ws.send(JSON.stringify({ type: "prompt", text, triage: true })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "ignored") outcome = "IGNORED";
      if (m.type === "text") reply += m.delta;
      if (m.type === "done") outcome = "ANSWERED";
      if (m.type === "ignored" || m.type === "done") {
        ws.close();
        resolve(`${outcome}${reply ? " — " + reply.slice(0, 60) : ""}`);
      }
    });
  });
}

const cases = [
  "jarvis what is a mutex in one sentence",   // addressed → ANSWERED
  "jarvis open the terminal",                 // addressed → ANSWERED
  "i'll ask jarvis about that later",         // about it → IGNORED
  "jarvis is really helpful isn't he",        // about it → IGNORED
];
for (const c of cases) console.log(`"${c}"  →  ${await ask(c)}`);

wss.close();
process.exit(0);
