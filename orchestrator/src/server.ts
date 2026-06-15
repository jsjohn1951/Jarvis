import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { AGENTS, DEFAULT_AGENT, GREETING_PROMPT } from "./agents/index.js";
import { dispatch, isAddressed } from "./dispatcher.js";
import { quickStream } from "./quick.js";
import { runHybrid } from "./runner.js";
import { checkHealth } from "./lifecycle.js";
import { listModels, getCurrentModel, swapModel } from "./models.js";
import { systemBase } from "./personality.js";
import * as memory from "./memory.js";

// ── Wire protocol (app ↔ orchestrator) ────────────────────────────────────────
// inbound:  {type:"prompt", text, agent?}  |  {type:"health"}
// outbound: {type:"status"|"agent"|"text"|"tool"|"done"|"error"|"health", ...}
type Outbound =
  | { type: "status"; state: string; detail?: string }
  | { type: "agent"; name: string; via: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "done"; result: string }
  | { type: "error"; message: string }
  | { type: "ignored" }   // wake heard, but the 2B judged it wasn't addressed to Jarvis
  | { type: "health"; llama: boolean; router: boolean; quick: boolean }
  | { type: "agents"; list: { name: string; description: string; tier: string }[] }
  | { type: "models"; list: string[]; current: string };

const send = (ws: WebSocket, msg: Outbound) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

/** Remove a leading "jarvis" address from a typed/dispatched command. */
function stripWake(text: string): string {
  return text.replace(/^\s*(hey\s+)?jarvis[\s,.:!-]*/i, "").trim();
}

/** Remove everything up to and including the first "jarvis" (for wake captures,
 *  where the name may appear mid-utterance: "okay jarvis, open the terminal"). */
function stripWakeAnywhere(text: string): string {
  return text.replace(/^.*?\bjarvis\b[\s,.:!?-]*/i, "").trim();
}

/** Compose personality + retrieved long-term memory + honorific + role prompt. */
async function buildSystem(roleSystem: string | undefined, userText: string, honorific?: string): Promise<string> {
  const parts = [systemBase()];
  const longterm = await memory.retrieve(userText);
  if (longterm) parts.push(longterm);
  if (honorific === "sir" || honorific === "maam") {
    parts.push(`For this turn, address the user as "${honorific === "sir" ? "Sir" : "Ma'am"}" — naturally and sparingly.`);
  }
  if (roleSystem) parts.push(roleSystem);
  return parts.join("\n\n");
}

async function handlePrompt(
  ws: WebSocket,
  rawText: string,
  forcedAgent?: string,
  triage = false,
  honorific?: string,
  image?: string,
  nowPlaying?: string,
) {
  send(ws, { type: "status", state: "thinking" });

  // Wake captures are triaged: did the speaker actually address Jarvis?
  if (triage && !(await isAddressed(rawText))) {
    send(ws, { type: "ignored" });
    send(ws, { type: "status", state: "idle" });
    return;
  }

  // "Jarvis, do X" → route on "do X". Bare "Jarvis" → greet.
  const stripped = triage ? stripWakeAnywhere(rawText) : stripWake(rawText);
  const greetingOnly = stripped.length === 0 && rawText.trim().length > 0;
  const text = greetingOnly ? rawText : stripped || rawText;

  // "new conversation" / "forget that" → clear short-term context.
  if (!greetingOnly && /^(new conversation|forget (that|this|it)|start over|clear (memory|context))\b/i.test(text)) {
    memory.clearShortTerm();
    send(ws, { type: "agent", name: "quick", via: "command" });
    const ack = "Context cleared. Starting fresh.";
    send(ws, { type: "text", delta: ack });
    send(ws, { type: "done", result: ack });
    send(ws, { type: "status", state: "idle" });
    return;
  }

  // An image needs a vision-capable hybrid agent — never the local 2B tier.
  let resolved = greetingOnly
    ? { agent: "quick", via: "greeting" }
    : forcedAgent && AGENTS[forcedAgent]
      ? { agent: forcedAgent, via: "explicit" }
      : await dispatch(text);
  if (image && AGENTS[resolved.agent]?.tier !== "hybrid") resolved = { agent: "researcher", via: "vision" };
  const { agent, via } = resolved;
  send(ws, { type: "agent", name: agent, via });

  const def = AGENTS[agent] ?? AGENTS[DEFAULT_AGENT];
  const promptText = greetingOnly ? GREETING_PROMPT : text;
  let system = await buildSystem(def.systemPrompt, text, honorific);
  if (nowPlaying) system += `\n\nThe user is currently playing: ${nowPlaying}.`;
  const history = greetingOnly ? [] : memory.recentTurns();
  let full = "";

  try {
    if (def.tier === "local" && !image) {
      for await (const delta of quickStream(promptText, system, history)) {
        full += delta;
        send(ws, { type: "text", delta });
      }
    } else {
      // Hybrid agents take system-only; fold the recent conversation into it.
      const histText = history.map((t) => `${t.role}: ${t.content}`).join("\n");
      const sysWithHistory = histText ? `${system}\n\n## Recent conversation\n${histText}` : system;
      for await (const ev of runHybrid(def, promptText, { system: sysWithHistory, imageBase64: image })) {
        if (ev.type === "text") {
          full += ev.delta;
          send(ws, { type: "text", delta: ev.delta });
        } else if (ev.type === "fallback") {
          send(ws, { type: "agent", name: agent, via: "local-fallback" });
        } else if (ev.type === "tool") {
          send(ws, { type: "tool", name: ev.name });
        } else if (ev.type === "result") {
          full = ev.text || full;
        }
      }
    }
    send(ws, { type: "done", result: full.trim() });
  } catch (err) {
    send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
  }
  send(ws, { type: "status", state: "idle" });

  // Persist to memory + curate in the background (don't delay the reply).
  if (!greetingOnly && full.trim()) {
    memory.appendTurn(text, full.trim());
    void memory.capture().then(() => memory.maybeConsolidate()).catch(() => {});
  }
}

export function startServer() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: config.wsPort });

  const sendAgents = (ws: WebSocket) =>
    send(ws, {
      type: "agents",
      list: Object.values(AGENTS).map((a) => ({ name: a.name, description: a.description, tier: a.tier })),
    });
  const sendModels = (ws: WebSocket) =>
    send(ws, { type: "models", list: listModels(), current: getCurrentModel() });

  wss.on("connection", (ws) => {
    checkHealth().then((h) => send(ws, { type: "health", ...h }));
    sendAgents(ws);
    sendModels(ws);

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "error", message: "invalid JSON" });
      }
      switch (msg.type) {
        case "health":
          send(ws, { type: "health", ...(await checkHealth()) });
          break;
        case "agents":
          sendAgents(ws);
          break;
        case "models":
          sendModels(ws);
          break;
        case "swap":
          if (typeof msg.model !== "string") return send(ws, { type: "error", message: "swap: missing model" });
          send(ws, { type: "status", state: "thinking", detail: `loading ${msg.model}` });
          try {
            await swapModel(msg.model);
            sendModels(ws);
            send(ws, { type: "health", ...(await checkHealth()) });
          } catch (err) {
            send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
          }
          send(ws, { type: "status", state: "idle" });
          break;
        case "prompt":
          if (typeof msg.text === "string")
            await handlePrompt(ws, msg.text, msg.agent, msg.triage === true, msg.honorific, msg.image, msg.nowPlaying);
          break;
        default:
          send(ws, { type: "error", message: `unknown message: ${msg.type}` });
      }
    });
  });

  console.log(`[jarvis] orchestrator listening on ws://127.0.0.1:${config.wsPort}`);
  return wss;
}
