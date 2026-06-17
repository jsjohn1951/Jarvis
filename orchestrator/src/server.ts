import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { AGENTS, DEFAULT_AGENT, greetingPrompt } from "./agents/index.js";
import { dispatch, isAddressed, isAffirmation, answersConfidently } from "./dispatcher.js";
import { quickStream, quickComplete } from "./quick.js";
import { runHybrid } from "./runner.js";
import { makeTrace, type Trace } from "./trace.js";
import { checkHealth } from "./lifecycle.js";
import { listModels, getCurrentModel, swapModel } from "./models.js";
import { systemBase } from "./personality.js";
import { buildJarvisTools } from "./tools.js";
import { resolveAct } from "./actuation.js";
import { isClaudeUnavailable } from "./fallback.js";
import * as providers from "./providers.js";
import * as memory from "./memory.js";
import * as vscodeBridge from "./vscode-bridge.js";
import { CodeStreamRouter } from "./code-stream.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { safeResolveInBase } from "./paths.js";

// ── Wire protocol (app ↔ orchestrator) ────────────────────────────────────────
// inbound:  {type:"prompt", text, agent?}  |  {type:"health"}
// outbound: {type:"status"|"agent"|"text"|"tool"|"done"|"error"|"health", ...}
type Outbound =
  | { type: "status"; state: string; detail?: string }
  | { type: "agent"; name: string; via: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string }
  | { type: "reset" }   // discard partial output (switching to a fallback provider)
  | { type: "done"; result: string }
  | { type: "error"; message: string }
  | { type: "ignored" }   // wake heard, but the 2B judged it wasn't addressed to Jarvis
  | { type: "addressed" }  // 2B confirmed the speaker IS addressing Jarvis → app reveals HUD
  | { type: "ack"; text: string }  // instant local acknowledgment, spoken before cloud work
  | { type: "health"; llama: boolean; router: boolean; quick: boolean }
  | { type: "agents"; list: { name: string; description: string; tier: string }[] }
  | { type: "models"; list: string[]; current: string }
  // Per-agent lifecycle for the node-graph visualization. `role` distinguishes the
  // phases the orchestrator drives (interpret/ack/plan/implement); `parent` links
  // children to the node that spawned them.
  | { type: "agent_spawn"; id: string; name: string; parent?: string; tier: string; role: string }
  | { type: "agent_thought"; id: string; text: string }
  | { type: "agent_tool"; id: string; name: string }
  | { type: "agent_done"; id: string; ok: boolean };

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

/** Code agents (dev/coder) go through a plan-and-confirm gate before touching code. */
const GATED_AGENTS = new Set(["dev", "coder"]);

/** A command parked awaiting the user's spoken go-ahead (the dev/coder plan gate). */
interface PendingPlan { agent: string; userText: string; honorific?: string; nowPlaying?: string }
const pendingPlans = new Map<WebSocket, PendingPlan>();

/** One-sentence in-character "working on it" line, spoken immediately while the
 *  cloud works. It must tell the user you're STARTING the task and to give you a
 *  moment — never a generic greeting ("ready to assist", "how can I help"), since
 *  the user just gave a command and is waiting. */
async function quickAck(userText: string, honorific?: string): Promise<string> {
  const addr = honorific === "sir" ? ' Address the user as "Sir".'
    : honorific === "maam" ? ' Address the user as "Ma\'am".' : "";
  const sys =
    "You are Jarvis and you have JUST received a task you are about to start working on. " +
    "Reply with ONE short spoken sentence that (a) names what you're doing, in your own words, and " +
    "(b) asks the user to give you a moment while you do it — e.g. \"Working on that now — give me a moment.\" " +
    "Do NOT actually answer or attempt the request. Do NOT greet or say you're \"ready to assist\" / " +
    "\"how can I help\" — you are already working. Plain text, no emoji, no markdown." + addr;
  return (await quickComplete(`The user asked: "${userText}". Say you're starting on it and to wait a moment.`, sys, 48)
    .catch(() => "")).trim();
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
  // Confirmed (or typed): the speaker IS addressing Jarvis — tell the app so it can
  // reveal the floating HUD. (Cheap, idempotent; the app shows the panel once.)
  if (triage) send(ws, { type: "addressed" });

  // Node-graph trace for this turn: the local "interpret" node fronts every turn.
  const trace = makeTrace((m) => send(ws, m));
  const interp = trace.spawn({ name: "interpret", tier: "local", role: "interpret" });

  // "Jarvis, do X" → route on "do X". Bare "Jarvis" → greet.
  const stripped = triage ? stripWakeAnywhere(rawText) : stripWake(rawText);
  const greetingOnly = stripped.length === 0 && rawText.trim().length > 0;
  const text = greetingOnly ? rawText : stripped || rawText;

  // Plan gate: if a dev/coder plan is parked for this connection, this utterance is
  // the user's verdict. Approval releases the parked command; anything else drops the
  // plan and the utterance is handled fresh below.
  const pending = pendingPlans.get(ws);
  if (pending && !greetingOnly) {
    pendingPlans.delete(ws);
    if (await isAffirmation(text)) {
      interp.thought(`Approved — executing parked ${pending.agent} task.`);
      interp.done();
      await runResolved(ws, trace, interp.id, { agent: pending.agent, via: "approved" }, pending.userText, {
        honorific: pending.honorific,
        nowPlaying: pending.nowPlaying,
      });
      return;
    }
    interp.thought("Plan declined or revised — treating as a new request.");
  }

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

  // A3 — don't let the local tier guess. If it routed a factual question to itself
  // but isn't confident it knows the answer, escalate to a tool-using agent that can
  // actually look it up (web/research) instead of fabricating.
  if (resolved.agent === "quick" && !greetingOnly && !image && !(await answersConfidently(text))) {
    interp.thought("Not certain from memory — escalating to look it up rather than guess.");
    resolved = { agent: "researcher", via: "escalated" };
  }
  interp.done();

  // A5 — plan-and-confirm gate. Code-writing agents must present a plan and wait for
  // the user's spoken go-ahead before touching anything (unless already approved).
  if (GATED_AGENTS.has(resolved.agent) && resolved.via !== "approved" && !greetingOnly && !image) {
    await runPlanGate(ws, trace, interp.id, resolved.agent, text, honorific, nowPlaying);
    send(ws, { type: "status", state: "idle" });
    return;
  }

  await runResolved(ws, trace, interp.id, resolved, text, { greetingOnly, honorific, image, nowPlaying });
}

/**
 * Execute a resolved agent and stream its events. Two-phase for cloud work: a local
 * 2B acknowledgment is spoken first (A2), then the hybrid agent does the real work.
 * Also emits node-graph lifecycle events (A6) and persists the turn.
 */
async function runResolved(
  ws: WebSocket,
  trace: Trace,
  parentId: string,
  resolved: { agent: string; via: string },
  text: string,
  opts: { greetingOnly?: boolean; honorific?: string; image?: string; nowPlaying?: string } = {},
) {
  const { greetingOnly = false, honorific, image, nowPlaying } = opts;
  const { agent, via } = resolved;
  send(ws, { type: "agent", name: agent, via });

  const def = AGENTS[agent] ?? AGENTS[DEFAULT_AGENT];
  const promptText = greetingOnly ? greetingPrompt() : text;
  let system = await buildSystem(def.systemPrompt, text, honorific);
  if (nowPlaying) system += `\n\nThe user is currently playing: ${nowPlaying}.`;
  const history = greetingOnly ? [] : memory.recentTurns();
  let full = "";

  // A2 — for real cloud work (hybrid, not a greeting), speak an instant local ack so
  // the user hears "on it" immediately while the cloud agent spins up.
  if (def.tier === "hybrid" && !greetingOnly) {
    const ackNode = trace.spawn({ name: "ack", tier: "local", role: "ack", parent: parentId });
    const ackText = await quickAck(text, honorific);
    if (ackText) { ackNode.thought(ackText); send(ws, { type: "ack", text: ackText }); }
    ackNode.done();
  }

  // The work node: the cloud planner / local implementer that does the real task.
  const work = trace.spawn({
    name: agent,
    tier: def.tier,
    role: greetingOnly ? "answer" : def.tier === "local" ? "answer" : GATED_AGENTS.has(agent) ? "implement" : "answer",
    parent: parentId,
  });

  try {
    if (def.tier === "local" && !image) {
      for await (const delta of quickStream(promptText, system, history)) {
        full += delta;
        work.thought(delta);
        send(ws, { type: "text", delta });
      }
    } else if (def.name === "coder") {
      // Live-coding: the model emits its file body as text (no Write tool), which we
      // stream token-by-token into VS Code via the editor extension. `full` collects
      // only the spoken narration — the code body is typed into the editor, never read
      // aloud. If no editor is connected we degrade gracefully: show the code in the
      // HUD and write it to disk on completion.
      const histText = history.map((t) => `${t.role}: ${t.content}`).join("\n");
      const sysWithHistory = histText ? `${system}\n\n## Recent conversation\n${histText}` : system;
      const live = vscodeBridge.isConnected();
      const streamId = `code-${Date.now()}`;
      // Graph node currently producing work — reassigned to a local node on fallback.
      let active = work;

      // The model picks the file path, so it's untrusted: refuse anything resolving
      // outside the agent's repo (safeResolveInBase handles `..`, absolute, NUL).
      const base = def.cwd ?? config.repoDir;

      // Per-attempt write state (recreated on a provider reset so a retry starts clean).
      let diskPath: string | null = null;
      let diskBuffer = "";
      let blocked = false; // path was rejected — swallow this block's code
      const makeRouter = () => {
        blocked = false;
        return new CodeStreamRouter({
          onNarration: (delta) => {
            full += delta;
            active.thought(delta);
            send(ws, { type: "text", delta });
          },
          onCodeBegin: (relPath) => {
            const abs = safeResolveInBase(base, relPath);
            if (!abs) {
              blocked = true;
              const note = ` (I refused to write "${relPath}" — it's outside the project.)`;
              full += note;
              send(ws, { type: "text", delta: note });
              return;
            }
            if (live) vscodeBridge.beginStream(streamId, abs);
            else { diskPath = abs; diskBuffer = ""; }
          },
          onCodeDelta: (delta) => {
            if (blocked) return;
            if (live) vscodeBridge.delta(streamId, delta);
            else { diskBuffer += delta; send(ws, { type: "text", delta }); }
          },
          onCodeEnd: () => {
            if (blocked) return;
            if (live) vscodeBridge.endStream(streamId, true);
            else if (diskPath) {
              const path = diskPath, body = diskBuffer;
              void mkdir(dirname(path), { recursive: true })
                .then(() => writeFile(path, body))
                .catch((e) => console.error("[jarvis] coder disk write failed:", e));
            }
          },
        });
      };

      let router = makeRouter();
      for await (const ev of runHybrid(def, promptText, { system: sysWithHistory, partial: true })) {
        if (ev.type === "text") router.push(ev.delta);
        else if (ev.type === "fallback") {
          send(ws, { type: "agent", name: agent, via: "local-fallback" });
          active = trace.spawn({ name: "local", tier: "local", role: "fallback", parent: work.id });
        } else if (ev.type === "reset") {
          // Provider failed mid-stream: drop partial narration, un-type the editor, and
          // start a fresh splitter so the retry types cleanly from scratch.
          full = "";
          if (live) vscodeBridge.abortStream(streamId);
          router = makeRouter();
          send(ws, { type: "reset" });
        } else if (ev.type === "tool") { active.tool(ev.name); send(ws, { type: "tool", name: ev.name }); }
        // `result` carries the whole assistant text (code + markers) — ignore it so
        // `full` stays narration-only for TTS.
      }
      router.flush();
      if (active !== work) active.done();
      if (!live) full += " I couldn't reach VS Code, so I wrote the file to disk instead.";
    } else {
      // Hybrid agents take system-only; fold the recent conversation into it.
      const histText = history.map((t) => `${t.role}: ${t.content}`).join("\n");
      const sysWithHistory = histText ? `${system}\n\n## Recent conversation\n${histText}` : system;
      // The desktop/web agents drive the app via in-process tools bound to this ws.
      const usesJarvisTools = def.allowedTools?.some((t) => t.startsWith("mcp__jarvis__"));
      const mcpServers = usesJarvisTools ? { jarvis: buildJarvisTools(ws) } : undefined;
      // Graph node currently producing work — reassigned to a local node on fallback,
      // which is exactly the "cloud planned, local now implementing" handoff.
      let active = work;
      for await (const ev of runHybrid(def, promptText, { system: sysWithHistory, imageBase64: image, mcpServers, decompose: true })) {
        if (ev.type === "text") {
          full += ev.delta;
          active.thought(ev.delta);
          send(ws, { type: "text", delta: ev.delta });
        } else if (ev.type === "fallback") {
          send(ws, { type: "agent", name: agent, via: "local-fallback" });
          active = trace.spawn({ name: "local", tier: "local", role: "fallback", parent: work.id });
        } else if (ev.type === "reset") {
          // A provider failed mid-stream; drop the partial answer so the HUD/TTS
          // only ever reflect the provider that actually completes.
          full = "";
          send(ws, { type: "reset" });
        } else if (ev.type === "tool") {
          active.tool(ev.name);
          send(ws, { type: "tool", name: ev.name });
        } else if (ev.type === "result") {
          full = ev.text || full;
        }
      }
      if (active !== work) active.done();
    }
    work.done(true);
    send(ws, { type: "done", result: full.trim() });
  } catch (err) {
    work.done(false);
    // Never surface a raw provider error. If the whole chain was unavailable,
    // speak a calm fallback line; only genuine failures (auth, bugs) show as errors.
    console.error("[jarvis] turn failed:", err);
    if (isClaudeUnavailable(err)) {
      const msg = "I can't reach the cloud or the local models right now — please try again shortly.";
      send(ws, { type: "reset" });
      send(ws, { type: "text", delta: msg });
      send(ws, { type: "done", result: msg });
      full = "";   // don't persist a failed turn
    } else {
      send(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }
  send(ws, { type: "status", state: "idle" });

  // Persist to memory + curate in the background (don't delay the reply).
  if (!greetingOnly && full.trim()) {
    memory.appendTurn(text, full.trim());
    void memory.capture().then(() => memory.maybeConsolidate()).catch(() => {});
  }
}

/**
 * A5 — run a cloud planning turn for a dev/coder request, speak the plan + any
 * clarifying questions, and PARK the original command awaiting the user's spoken
 * go-ahead. The next utterance is read as the verdict (see the plan gate in
 * handlePrompt). Cloud does the thinking here; nothing is edited until approval.
 */
async function runPlanGate(
  ws: WebSocket,
  trace: Trace,
  parentId: string,
  agent: string,
  text: string,
  honorific?: string,
  nowPlaying?: string,
) {
  send(ws, { type: "agent", name: "planner", via: "gate" });
  const node = trace.spawn({ name: "planner", tier: "hybrid", role: "plan", parent: parentId });

  const planSystem = await buildSystem(
    "You are Jarvis's planner. The user wants the `" + agent + "` agent to do real work, but you must " +
      "plan and confirm FIRST — nothing is edited yet. Read the project if helpful (Read/Glob/Grep), then give " +
      "a SHORT spoken plan: 2–4 concrete steps broken small enough to do one at a time. Ask any clarifying " +
      "question you genuinely need. End by asking the user to confirm before you proceed. Plain text, no markdown — " +
      "it is read aloud, so keep it brief.",
    text,
    honorific,
  );
  const history = memory.recentTurns();
  const histText = history.map((t) => `${t.role}: ${t.content}`).join("\n");
  const sysWithHistory = histText ? `${planSystem}\n\n## Recent conversation\n${histText}` : planSystem;

  let full = "";
  try {
    for await (const ev of runHybrid(AGENTS.planner, text, { system: sysWithHistory })) {
      if (ev.type === "text") { full += ev.delta; node.thought(ev.delta); send(ws, { type: "text", delta: ev.delta }); }
      else if (ev.type === "tool") { node.tool(ev.name); send(ws, { type: "tool", name: ev.name }); }
      else if (ev.type === "fallback") send(ws, { type: "agent", name: "planner", via: "local-fallback" });
      else if (ev.type === "reset") { full = ""; send(ws, { type: "reset" }); }
      else if (ev.type === "result") full = ev.text || full;
    }
    node.done(true);
    // Park the real command; the user's next utterance approves or revises it.
    pendingPlans.set(ws, { agent, userText: text, honorific, nowPlaying });
    send(ws, { type: "done", result: full.trim() });
  } catch (err) {
    node.done(false);
    console.error("[jarvis] plan gate failed:", err);
    const msg = isClaudeUnavailable(err)
      ? "I can't reach the models to plan that right now — please try again shortly."
      : "I hit a problem planning that.";
    send(ws, { type: "text", delta: msg });
    send(ws, { type: "done", result: msg });
  }
}

export function startServer() {
  vscodeBridge.ensureToken(); // create the editor secret file before the extension connects
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
    ws.on("close", () => pendingPlans.delete(ws)); // drop any unanswered plan gate

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "error", message: "invalid JSON" });
      }
      switch (msg.type) {
        case "hello":
          // The VS Code extension introduces itself so we route the coder stream to
          // it. Gated by the shared secret so an arbitrary local process can't pose as
          // the editor; a bad/absent token closes the socket.
          if (msg.role === "editor") {
            if (vscodeBridge.verifyToken(msg.token)) vscodeBridge.register(ws);
            else { console.warn("[jarvis] editor hello rejected (bad token)"); ws.close(); }
          }
          break;
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
        case "act_result":
          // Reply from the app for a desktop/web tool call — resolve its pending Promise.
          resolveAct(msg);
          break;
        case "provider_config":
          // App pushed alternate-provider settings (e.g. Ollama Cloud key) — persist
          // for the router and update the runner's fallback chain.
          providers.applyProviderConfig(msg);
          break;
        default:
          send(ws, { type: "error", message: `unknown message: ${msg.type}` });
      }
    });
  });

  console.log(`[jarvis] orchestrator listening on ws://127.0.0.1:${config.wsPort}`);
  return wss;
}
