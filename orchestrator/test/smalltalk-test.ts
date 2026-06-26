// Verifies: social chit-chat ("how are you", "thanks", "good morning") is answered on
// the local tier as quick/smalltalk with NO "working on it" ack and NO cloud dispatch —
// while real tasks/questions are NOT misclassified as smalltalk. Local-only.
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";
import { config } from "../src/config.js";

const wss = startServer();
await new Promise((r) => setTimeout(r, 300));

const ackPhrase = /working on|give me a moment|one moment|hang on|give me a sec/i;

async function ask(text: string): Promise<{ via: string; reply: string; gotAck: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${config.wsPort}`);
    let reply = "", via = "", gotAck = false;
    ws.on("open", () => ws.send(JSON.stringify({ type: "prompt", text })));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "agent") via = `${m.name}/${m.via}`;
      if (m.type === "ack") gotAck = true;
      if (m.type === "text") reply += m.delta;
      if (m.type === "done") { ws.close(); resolve({ via, reply: (m.result || reply).trim(), gotAck }); }
    });
  });
}

let failures = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}  ${detail}`);
  if (!cond) failures++;
}

// Positive: smalltalk → quick/smalltalk, no ack, no "working on it" language.
for (const text of ["how are you", "thanks", "good morning", "nice work"]) {
  const r = await ask(text);
  check(`smalltalk "${text}"`,
    r.via === "quick/smalltalk" && !r.gotAck && !ackPhrase.test(r.reply),
    `via:${r.via} ack:${r.gotAck} | ${r.reply.slice(0, 70)}`);
}

// Negative: real tasks/questions must NOT be classified as smalltalk.
for (const text of ["open the terminal", "what is a mutex", "refactor the parser"]) {
  const r = await ask(text);
  check(`task "${text}"`, r.via !== "quick/smalltalk", `via:${r.via}`);
}

// Ordering: the "new conversation" command precedes the smalltalk check.
{
  const r = await ask("start over");
  check(`"start over"`, r.via === "quick/command", `via:${r.via}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
wss.close();
process.exit(failures === 0 ? 0 : 1);
