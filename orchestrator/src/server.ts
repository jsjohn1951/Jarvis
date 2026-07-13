import { WebSocketServer, type WebSocket } from "ws";
import { config } from "./config.js";
import { AGENTS, DEFAULT_AGENT, greetingPrompt, chatPrompt } from "./agents/index.js";
import { dispatch, isAddressed, isAffirmation, answersConfidently, isSmalltalk } from "./dispatcher.js";
import { quickStream, quickComplete } from "./quick.js";
import { convoStream, convoComplete } from "./convo.js";
import { runHybrid, StallError, MaxTurnsError, isIncomplete } from "./runner.js";
import { assessCompletion, speakVerdict, type TerminatedReason } from "./completion.js";
import { makeTrace, type Trace } from "./trace.js";
import { checkHealth } from "./lifecycle.js";
import { listModels, getCurrentModel, swapModel } from "./models.js";
import { systemBase } from "./personality.js";
import { catalogText, getSkillsCatalog } from "./skills-catalog.js";
import { buildJarvisTools } from "./tools.js";
import { resolveAct } from "./actuation.js";
import { isClaudeUnavailable } from "./fallback.js";
import * as providers from "./providers.js";
import * as memory from "./memory.js";
import * as session from "./session.js";
import { runProject, type PmDeps } from "./pm.js";
import { makeProject, saveProject } from "./project.js";
import * as vscodeBridge from "./vscode-bridge.js";
import * as mobileAuth from "./mobile-auth.js";
import { CodeStreamRouter } from "./code-stream.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { safeResolveInBase } from "./paths.js";

// ── Wire protocol (app ↔ orchestrator) ────────────────────────────────────────
// inbound:  {type:"prompt", text, agent?}  |  {type:"health"}
// outbound: {type:"status"|"agent"|"text"|"tool"|"done"|"error"|"health", ...}
type Outbound =
  | { type: "status"; state: string; detail?: string }
  | { type: "agent"; name: string; via: string }
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; detail?: string }
  | { type: "reset" }   // discard partial output (switching to a fallback provider)
  | { type: "done"; result: string }
  | { type: "error"; message: string }
  | { type: "ignored" }   // wake heard, but the 2B judged it wasn't addressed to Jarvis
  | { type: "addressed" }  // 2B confirmed the speaker IS addressing Jarvis → app reveals HUD
  | { type: "ack"; text: string }  // instant local acknowledgment, spoken before cloud work
  | { type: "session"; state: "open" | "closed"; id?: string }  // conversation session opened/closed
  | { type: "cancelled" }  // the in-flight turn was aborted by the user (barge-in)
  // PM pipeline: a project was created/advanced/finished. `tasks` is the live plan with
  // per-task state so the HUD can show the board. Streaming inside a task reuses text/agent.
  | { type: "project"; event: "created" | "progress" | "done" | "failed"; id: string;
      goal?: string; state?: string; tasks?: { id: string; title: string; state: string }[]; detail?: string }
  | { type: "health"; llama: boolean; router: boolean; quick: boolean; convo: boolean }
  | { type: "agents"; list: { name: string; description: string; tier: string }[] }
  | { type: "models"; list: string[]; current: string }
  // Per-agent lifecycle for the node-graph visualization. `role` distinguishes the
  // phases the orchestrator drives (interpret/ack/plan/implement); `parent` links
  // children to the node that spawned them.
  | { type: "agent_spawn"; id: string; name: string; parent?: string; tier: string; role: string }
  | { type: "agent_thought"; id: string; text: string }
  | { type: "agent_tool"; id: string; name: string }
  | { type: "agent_done"; id: string; ok: boolean }
  // Remote (mobile) client authenticated successfully — sent before the welcome burst.
  | { type: "hello_ok"; role: "mobile" }
  // A phone (mobile role) connected or disconnected — pushed to desktop clients and
  // included in every welcome burst so a late-connecting Mac gets the current state.
  | { type: "phone"; connected: boolean; device?: string };

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

/** Agents that do real work and benefit from knowing which skills exist. */
const SKILL_AWARE_AGENTS = new Set(["dev", "coder", "planner", "reviewer", "researcher"]);

/** Compose personality + retrieved long-term memory + honorific + role prompt
 *  (+ a skills catalog for the work agents, so they reach for a skill when one fits). */
async function buildSystem(
  roleSystem: string | undefined,
  userText: string,
  honorific?: string,
  agentName?: string,
): Promise<string> {
  const parts = [systemBase()];
  const longterm = await memory.retrieve(userText);
  if (longterm) parts.push(longterm);
  if (honorific === "sir" || honorific === "maam") {
    parts.push(`For this turn, address the user as "${honorific === "sir" ? "Sir" : "Ma'am"}" — naturally and sparingly.`);
  }
  if (roleSystem) parts.push(roleSystem);
  if (agentName && SKILL_AWARE_AGENTS.has(agentName)) {
    const catalog = catalogText(await getSkillsCatalog());
    if (catalog) parts.push(catalog);
  }
  return parts.join("\n\n");
}

/** Code agents (dev/coder) go through a plan-and-confirm gate before touching code. */
const GATED_AGENTS = new Set(["dev", "coder"]);

/** A command parked awaiting the user's spoken go-ahead.
 *  - dev/coder single-shot gate: `agent` + `userText` set.
 *  - PM project planner Q&A: `qa` set (the running planning conversation).
 *  - PM project ready: `project` set (a parsed plan awaiting final approval). */
interface PendingPlan {
  agent: string;
  userText: string;
  honorific?: string;
  nowPlaying?: string;
  qa?: { goal: string; turns: { role: "user" | "assistant"; content: string }[] };
  project?: { goal: string; tasks: { id: string; title: string; detail: string; dependsOn?: string[] }[] };
}
const pendingPlans = new Map<WebSocket, PendingPlan>();

/** The in-flight turn's abort controller, so a "cancel" message (barge-in) can abort it. */
const activeTurns = new Map<WebSocket, AbortController>();

/** Role of each authenticated socket. Loopback sockets are trusted as "desktop" at
 *  connect (the Mac app; also the iOS simulator, which may upgrade itself to
 *  "mobile" via hello). Non-loopback sockets have NO entry until a valid mobile
 *  hello — the message handler drops everything else from them. "editor" is the
 *  VS Code extension (loopback + editor token). */
const clientRole = new Map<WebSocket, "desktop" | "mobile" | "editor">();

/** The socket that should perform desktop actuation for a prompt from `ws`: the
 *  requesting desktop app itself, else the first connected desktop app (a prompt
 *  from the phone drives the Mac), else undefined → graceful tool error. */
function actuatorFor(ws: WebSocket): WebSocket | undefined {
  if (clientRole.get(ws) === "desktop" && ws.readyState === ws.OPEN) return ws;
  for (const [sock, role] of clientRole) {
    if (role === "desktop" && sock.readyState === sock.OPEN) return sock;
  }
  return undefined;
}

/** Device name from each mobile socket's hello, for the Mac HUD's phone chip. */
const mobileDevices = new Map<WebSocket, string>();

/** Current phone status, recomputed from the live socket set (count-based, so
 *  reconnects and multiple phones are correct by construction). */
function phoneStatus(): Outbound {
  let connected = false;
  let device: string | undefined;
  for (const [sock, role] of clientRole) {
    if (role === "mobile" && sock.readyState === sock.OPEN) {
      connected = true;
      device = mobileDevices.get(sock) ?? device;
    }
  }
  return device !== undefined ? { type: "phone", connected, device } : { type: "phone", connected };
}

/** Push a message to every connected desktop client (the Mac app). */
function broadcastToDesktop(msg: Outbound) {
  for (const [sock, role] of clientRole) {
    if (role === "desktop") send(sock, msg);  // send() already checks OPEN
  }
}

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
  // The ack is user-facing dialog → conversation tier (Gemma). Fall back to the 2B if
  // Gemma's server is down so the user still hears an acknowledgment.
  const ask = `The user asked: "${userText}". Say you're starting on it and to wait a moment.`;
  const text = await convoComplete(ask, sys, 48).catch(() => quickComplete(ask, sys, 48).catch(() => ""));
  return text.trim();
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

  // "Hey Jarvis" (bare greeting) opens a conversation session — additive: the global
  // short-term buffer is unchanged, so a no-session flow behaves exactly as before.
  if (greetingOnly) {
    try {
      const s = session.openSession(ws);
      send(ws, { type: "session", state: "open", id: s.id });
    } catch { /* sessions are an enhancement — never break the turn */ }
  }

  // Plan gate: if a dev/coder plan is parked for this connection, this utterance is
  // the user's verdict. Approval releases the parked command; anything else drops the
  // plan and the utterance is handled fresh below.
  const pending = pendingPlans.get(ws);
  if (pending && !greetingOnly) {
    pendingPlans.delete(ws);
    // PM project: a parsed plan awaiting the final go-ahead.
    if (pending.project) {
      if (await isAffirmation(text)) {
        interp.thought("Plan approved — starting the project.");
        interp.done();
        await startProject(ws, trace, interp.id, pending.project, honorific);
        send(ws, { type: "status", state: "idle" });
        return;
      }
      interp.thought("Plan not approved — treating as a new request.");
    }
    // PM project planner Q&A. Unless the user is bailing, this answers the planner.
    else if (pending.qa && pending.agent === "planner") {
      if (!session.isCloseIntent(text)) {
        interp.done();
        await runPlannerTurn(ws, trace, interp.id, pending.qa, text, pending.honorific ?? honorific);
        send(ws, { type: "status", state: "idle" });
        return;
      }
      interp.thought("Planning cancelled — treating as a new request.");
    }
    // dev/coder plan gate (multi-turn). Affirmation → execute; a clarifying answer →
    // continue planning (not "declined", which used to loop); close intent → drop.
    else if (pending.qa) {
      if (await isAffirmation(text)) {
        interp.thought(`Approved — executing parked ${pending.agent} task.`);
        interp.done();
        await runResolved(ws, trace, interp.id, { agent: pending.agent, via: "approved" }, pending.userText, {
          honorific: pending.honorific,
          nowPlaying: pending.nowPlaying,
        });
        return;
      }
      if (!session.isCloseIntent(text)) {
        interp.thought("Answering the planner's question — refining the plan.");
        interp.done();
        await runPlanGate(ws, trace, interp.id, pending.agent, pending.qa, text, pending.honorific ?? honorific, pending.nowPlaying);
        send(ws, { type: "status", state: "idle" });
        return;
      }
      interp.thought("Plan cancelled — treating as a new request.");
    }
    // Legacy single-shot re-prompt (the completion verifier's "ask" parks without qa).
    else if (await isAffirmation(text)) {
      interp.thought(`Approved — executing parked ${pending.agent} task.`);
      interp.done();
      await runResolved(ws, trace, interp.id, { agent: pending.agent, via: "approved" }, pending.userText, {
        honorific: pending.honorific,
        nowPlaying: pending.nowPlaying,
      });
      return;
    } else {
      interp.thought("Plan declined or revised — treating as a new request.");
    }
  }

  // Close intent ("goodbye" / "new conversation" / "forget that") → end the session and
  // clear short-term context. If a session is open we first consolidate it to long-term
  // memory; otherwise this stays the original "context cleared" command (backwards compatible).
  if (!greetingOnly && session.isCloseIntent(text)) {
    const closing = session.hasOpenSession(ws);
    if (closing) {
      void memory.maybeConsolidate(true).catch(() => {});   // persist durable facts before clearing
      const s = session.closeSession(ws);
      session.dropSession(ws);
      send(ws, { type: "session", state: "closed", id: s?.id });
    }
    memory.clearShortTerm();
    send(ws, { type: "agent", name: "quick", via: "command" });
    const ack = closing ? "Alright, we're all wrapped up. Talk to you soon." : "Context cleared. Starting fresh.";
    send(ws, { type: "text", delta: ack });
    send(ws, { type: "done", result: ack });
    send(ws, { type: "status", state: "idle" });
    return;
  }

  // Smalltalk ("how are you", "thanks") is conversation, not a task: answer it on the
  // local tier and never speak a "working on it" ack or dispatch cloud work. Excludes
  // greetings (handled above), forced agents, and images (which force a vision agent).
  const conversational = !greetingOnly && !forcedAgent && !image && (await isSmalltalk(text));

  // An image needs a vision-capable hybrid agent — never the local 2B tier.
  let resolved = greetingOnly
    ? { agent: "quick", via: "greeting" }
    : conversational
      ? { agent: "quick", via: "smalltalk" }
      : forcedAgent && AGENTS[forcedAgent]
        ? { agent: forcedAgent, via: "explicit" }
        : await dispatch(text);
  if (image && AGENTS[resolved.agent]?.tier !== "hybrid") resolved = { agent: "researcher", via: "vision" };

  // A3 — don't let the local tier guess. If it routed a factual question to itself
  // but isn't confident it knows the answer, escalate to a tool-using agent that can
  // actually look it up (web/research) instead of fabricating. Smalltalk is exempt:
  // "how are you" isn't a fact to look up, so it must never escalate to research.
  if (resolved.agent === "quick" && !greetingOnly && !conversational && !image && !(await answersConfidently(text))) {
    interp.thought("Not certain from memory — escalating to look it up rather than guess.");
    resolved = { agent: "researcher", via: "escalated" };
  }
  interp.done();

  // The planner agent is the entry to the PM pipeline: a brief Q&A to nail the goal, then
  // a plan the PM executes (planner→coder→reviewer). Single-shot dev/coder edits still use
  // the lightweight plan-and-confirm gate below.
  if (resolved.agent === "planner" && !greetingOnly && !image) {
    await runPlannerTurn(ws, trace, interp.id, { goal: text, turns: [] }, text, honorific);
    send(ws, { type: "status", state: "idle" });
    return;
  }

  // A5 — plan-and-confirm gate. Code-writing agents must present a plan and wait for
  // the user's spoken go-ahead before touching anything (unless already approved).
  if (GATED_AGENTS.has(resolved.agent) && resolved.via !== "approved" && !greetingOnly && !image) {
    await runPlanGate(ws, trace, interp.id, resolved.agent, { goal: text, turns: [] }, text, honorific, nowPlaying);
    send(ws, { type: "status", state: "idle" });
    return;
  }

  await runResolved(ws, trace, interp.id, resolved, text, { greetingOnly, conversational, honorific, image, nowPlaying });
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
  opts: { greetingOnly?: boolean; conversational?: boolean; honorific?: string; image?: string; nowPlaying?: string } = {},
) {
  const { greetingOnly = false, conversational = false, honorific, image, nowPlaying } = opts;
  const { agent, via } = resolved;
  send(ws, { type: "agent", name: agent, via });

  // Barge-in: register an abort controller for this turn so a "cancel" message can stop it
  // mid-stream. Cleared in the after-loop section (every path breaks there).
  const turnCtl = new AbortController();
  activeTurns.set(ws, turnCtl);
  let cancelled = false;

  const def = AGENTS[agent] ?? AGENTS[DEFAULT_AGENT];
  let system = await buildSystem(def.systemPrompt, text, honorific, def.name);
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

  // A7 — completion verification: the SDK loop ending doesn't prove the job is done.
  // After each run we assess the outcome and may auto-continue the remaining work (only
  // for repo-side agents; desktop/web/coder have real-world or live side effects we must
  // not silently repeat). Read-only/local-tier work and greetings finish without a check.
  const verifiable = def.tier === "hybrid" && def.name !== "coder" && !greetingOnly && !image;
  const NO_AUTOCONTINUE = new Set(["desktop", "web", "coder"]);
  let continuationsUsed = 0;
  // The prompt for the current run — replaced by the verifier's "remaining work" note
  // on each auto-continue so the model picks up where it left off.
  let runPrompt = greetingOnly ? greetingPrompt() : conversational ? chatPrompt(text) : text;

  // Continuation loop: runs the agent, verifies, and either stops or re-runs the remainder.
  // eslint-disable-next-line no-constant-condition
  while (true) {
  let reason: TerminatedReason = "natural";
  let toolRan = false;
  const writtenPaths: string[] = [];
  let ranLocal = false;
  let unavailable = false;
  const promptText = runPrompt;
  try {
    if (def.tier === "local" && !image) {
      // User-facing conversation (greeting / smalltalk / local factual answer) runs on
      // the Gemma conversation tier. If Gemma is unreachable before any token, degrade to
      // the 2B 'quick' tier so conversation never dies on a convo-server outage.
      let localEmitted = false;
      try {
        for await (const delta of convoStream(promptText, system, history, 1024, turnCtl.signal)) {
          localEmitted = true;
          full += delta;
          work.thought(delta);
          send(ws, { type: "text", delta });
        }
      } catch (convoErr) {
        // Aborted by barge-in, or already streamed partial output → don't restart on the 2B.
        if (turnCtl.signal.aborted) { cancelled = true; }
        else if (localEmitted) throw convoErr;
        else {
          for await (const delta of quickStream(promptText, system, history, 1024, turnCtl.signal)) {
            full += delta;
            work.thought(delta);
            send(ws, { type: "text", delta });
          }
        }
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
      for await (const ev of runHybrid(def, promptText, { system: sysWithHistory, partial: true, signal: turnCtl.signal })) {
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
        } else if (ev.type === "tool") { active.tool(ev.name, ev.detail); send(ws, { type: "tool", name: ev.name, detail: ev.detail }); }
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
      const mcpServers = usesJarvisTools ? { jarvis: buildJarvisTools(() => actuatorFor(ws)) } : undefined;
      // Graph node currently producing work — reassigned to a local node on fallback,
      // which is exactly the "cloud planned, local now implementing" handoff.
      let active = work;
      for await (const ev of runHybrid(def, promptText, { system: sysWithHistory, imageBase64: image, mcpServers, decompose: true, signal: turnCtl.signal })) {
        if (ev.type === "text") {
          full += ev.delta;
          active.thought(ev.delta);
          send(ws, { type: "text", delta: ev.delta });
        } else if (ev.type === "fallback") {
          ranLocal = true;
          send(ws, { type: "agent", name: agent, via: "local-fallback" });
          active = trace.spawn({ name: "local", tier: "local", role: "fallback", parent: work.id });
        } else if (ev.type === "reset") {
          // A provider failed mid-stream; drop the partial answer so the HUD/TTS
          // only ever reflect the provider that actually completes.
          full = "";
          send(ws, { type: "reset" });
        } else if (ev.type === "tool") {
          toolRan = true;
          if ((ev.name === "Write" || ev.name === "Edit") && ev.path) writtenPaths.push(ev.path);
          active.tool(ev.name, ev.detail);
          send(ws, { type: "tool", name: ev.name, detail: ev.detail });
        } else if (ev.type === "result") {
          full = ev.text || full;
        }
      }
      if (active !== work) active.done();
    }
  } catch (err) {
    if (turnCtl.signal.aborted) cancelled = true;   // user barge-in aborted the SDK stream
    else if (err instanceof StallError) reason = "stall";
    else if (err instanceof MaxTurnsError) reason = "max_turns";
    else if (isClaudeUnavailable(err)) { unavailable = true; reason = "error"; }
    else { reason = "error"; console.error("[jarvis] turn failed:", err); }
  }

  // Barge-in: the user interrupted. The cancel handler already sent {cancelled} + idle —
  // just stop here without speaking a reply or persisting a partial turn.
  if (cancelled) { work.done(false); break; }

  // Whole chain unreachable (cloud + local both down): keep the calm line, skip the
  // verifier — there's nothing to verify and no provider to continue on.
  if (unavailable) {
    work.done(false);
    const msg = "I can't reach the cloud or the local models right now — please try again shortly.";
    send(ws, { type: "reset" });
    send(ws, { type: "text", delta: msg });
    send(ws, { type: "done", result: msg });
    full = "";   // don't persist a failed turn
    break;
  }

  // Read-only / local-tier / greeting work isn't verified — finish as before.
  if (!verifiable) {
    work.done(reason === "natural");
    send(ws, { type: "done", result: full.trim() });
    break;
  }

  // Verify the outcome and decide: done / auto-continue / ask the user / give up.
  let verdict = await assessCompletion({
    task: text, reason, toolRan, result: full, writtenPaths, continuationsUsed, isLocal: ranLocal,
  });
  // Agents with real-world or live side effects must never be silently re-run.
  if (verdict.kind === "continue" && NO_AUTOCONTINUE.has(agent)) {
    verdict = { kind: "ask", summary: "That didn't fully complete.", options: ["try again", "adjust the approach", "stop here"] };
  }

  if (verdict.kind === "done") {
    work.done(reason === "natural");
    send(ws, { type: "done", result: full.trim() });
    break;
  }
  if (verdict.kind === "continue") {
    continuationsUsed++;
    work.tool("continue");
    send(ws, { type: "agent", name: agent, via: "continue" });
    runPrompt = verdict.remaining;
    continue;   // re-run the agent on the remaining work
  }
  // ask | giveup — speak the line, (for ask) park so the user's next reply steers it.
  work.done(false);
  const line = speakVerdict(verdict);
  full = line;
  if (verdict.kind === "ask") pendingPlans.set(ws, { agent, userText: text, honorific, nowPlaying });
  send(ws, { type: "text", delta: line });
  send(ws, { type: "done", result: line });
  break;
  }

  // Turn finished — release the barge-in controller for this connection.
  if (activeTurns.get(ws) === turnCtl) activeTurns.delete(ws);

  // On cancel the cancel handler already drove the HUD to idle; don't persist a partial turn.
  if (cancelled) return;

  send(ws, { type: "status", state: "idle" });

  // Persist to memory + curate in the background (don't delay the reply).
  if (!greetingOnly && full.trim()) {
    memory.appendTurn(text, full.trim());
    session.recordTurn(ws, text, full.trim());   // mirror into the session log if one is open
    void memory.capture().then(() => memory.maybeConsolidate()).catch(() => {});
  }
}

/**
 * A5 — run a cloud planning turn for a dev/coder request, speak the plan + any
 * clarifying questions, and PARK the original command awaiting the user's spoken
 * go-ahead. The next utterance is read as the verdict (see the plan gate in
 * handlePrompt). Cloud does the thinking here; nothing is edited until approval.
 */
/**
 * Plan-and-confirm gate for a dev/coder task. Multi-turn: the planner presents a short
 * plan (asking at most one clarifying question), and the conversation is carried in
 * `qa.turns`. Each exchange is recorded to memory + the session so context persists — both
 * across clarification turns and into execution. The user's next utterance is then read in
 * handlePrompt as: affirmation → execute; a clarifying answer → continue planning (re-run
 * this); a close/reject → drop. (Previously any non-"yes" reply was treated as "declined"
 * and re-planned from scratch, which looped — see the real-session bug this fixes.)
 */
async function runPlanGate(
  ws: WebSocket,
  trace: Trace,
  parentId: string,
  agent: string,
  qa: { goal: string; turns: { role: "user" | "assistant"; content: string }[] },
  userText: string,
  honorific?: string,
  nowPlaying?: string,
) {
  send(ws, { type: "agent", name: "planner", via: qa.turns.length ? "qa" : "gate" });
  const node = trace.spawn({ name: "planner", tier: "hybrid", role: "plan", parent: parentId });

  const planSystem = await buildSystem(
    "You are Jarvis's planner. The user wants the `" + agent + "` agent to do real work, but you must " +
      "plan and confirm FIRST — nothing is edited yet. Read the project if helpful (Read/Glob/Grep). " +
      "Be DECISIVE: this is a single concrete task, NOT a project — do not over-plan, brainstorm, or write specs. " +
      "Prefer sensible defaults over asking; ask AT MOST ONE clarifying question, and only if you genuinely cannot " +
      "proceed without it. Otherwise give a SHORT spoken plan (1–3 concrete steps) and end by asking the user to " +
      "confirm. Plain text, no markdown — it is read aloud, so keep it brief.",
    qa.goal,
    honorific,
    "planner",
  );
  // Use the real conversation buffer for history (each planning turn is recorded to it
  // below), so a fresh request still sees prior context — NOT just this planning thread.
  const history = memory.recentTurns();
  const histText = history.map((t) => `${t.role}: ${t.content}`).join("\n");
  const sysWithHistory = histText ? `${planSystem}\n\n## Recent conversation\n${histText}` : planSystem;

  qa.turns.push({ role: "user", content: userText });
  let full = "";
  try {
    for await (const ev of runHybrid(AGENTS.planner, userText, { system: sysWithHistory })) {
      if (ev.type === "text") { full += ev.delta; node.thought(ev.delta); send(ws, { type: "text", delta: ev.delta }); }
      else if (ev.type === "tool") { node.tool(ev.name, ev.detail); send(ws, { type: "tool", name: ev.name, detail: ev.detail }); }
      else if (ev.type === "fallback") send(ws, { type: "agent", name: "planner", via: "local-fallback" });
      else if (ev.type === "reset") { full = ""; send(ws, { type: "reset" }); }
      else if (ev.type === "result") full = ev.text || full;
    }
  } catch (err) {
    node.done(false);
    const msg = isClaudeUnavailable(err)
      ? "I can't reach the models to plan that right now — please try again shortly."
      : isIncomplete(err)
        ? "I couldn't finish planning that on the local model. Want me to try again, simplify it, or use the cloud?"
        : "I hit a problem planning that.";
    if (!isIncomplete(err) && !isClaudeUnavailable(err)) console.error("[jarvis] plan gate failed:", err);
    send(ws, { type: "text", delta: msg });
    send(ws, { type: "done", result: msg });
    return;
  }
  node.done(true);
  qa.turns.push({ role: "assistant", content: full.trim() });
  // Persist the planning exchange so context carries across turns AND into execution
  // (the executor reads memory.recentTurns()). Fixes the "lost context" failure.
  if (full.trim()) {
    memory.appendTurn(userText, full.trim());
    session.recordTurn(ws, userText, full.trim());
  }
  // Park the task with its planning conversation; handlePrompt routes the next utterance.
  pendingPlans.set(ws, { agent, userText: qa.goal, honorific, nowPlaying, qa });
  send(ws, { type: "done", result: full.trim() });
}

/** Sentinel the planner emits when it's ready to hand a parsed plan to the PM pipeline. */
const PLAN_MARKER = "PLAN_JSON:";

type PlannedTask = { id: string; title: string; detail: string; dependsOn?: string[] };

/** Parse the JSON task array following PLAN_JSON:. Lenient — returns [] if unparseable. */
function parsePlan(s: string): PlannedTask[] {
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((t) => t && typeof t.title === "string" && typeof t.detail === "string")
      .map((t, i) => ({
        id: typeof t.id === "string" && t.id ? t.id : `t${i + 1}`,
        title: t.title,
        detail: t.detail,
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((x: unknown) => typeof x === "string") : undefined,
      }));
  } catch {
    return [];
  }
}

/**
 * One planner turn in the PM pipeline. The planner either asks ONE clarifying question
 * (Q&A parked, awaiting the user's answer) or emits a final plan (parsed + parked awaiting
 * the user's go-ahead, which startProject then executes). The planning conversation is
 * carried in the PendingPlan.qa field across turns.
 */
async function runPlannerTurn(
  ws: WebSocket,
  trace: Trace,
  parentId: string,
  qa: { goal: string; turns: { role: "user" | "assistant"; content: string }[] },
  userText: string,
  honorific?: string,
) {
  send(ws, { type: "agent", name: "planner", via: qa.turns.length ? "qa" : "gate" });
  const node = trace.spawn({ name: "planner", tier: "hybrid", role: "plan", parent: parentId });

  const planSystem = await buildSystem(
    "You are Jarvis's project planner. The user wants to accomplish a multi-step coding goal. " +
      "Hold a brief back-and-forth: ask a SINGLE concise clarifying question ONLY when you genuinely need more " +
      "detail to plan well; otherwise produce the plan. When ready, give a one-sentence spoken intro, then on its " +
      `own line the marker ${PLAN_MARKER} followed by a JSON array of tasks: ` +
      '[{"id":"t1","title":"short title","detail":"precise instruction for a coder","dependsOn":["t0"]}]. ' +
      "Each task must be small and independently implementable by a coder; use dependsOn (task ids) only when order " +
      `matters. Do NOT output ${PLAN_MARKER} until you are ready to proceed — if you still need info, just ask the ` +
      "one question. Keep spoken text brief; it is read aloud.",
    qa.goal,
    honorific,
    "planner",
  );
  // Real conversation buffer for history (planning turns are recorded to it), so the
  // project planner sees prior context, not just this planning thread.
  const histText = memory.recentTurns().map((t) => `${t.role}: ${t.content}`).join("\n");
  const sys = histText ? `${planSystem}\n\n## Recent conversation\n${histText}` : planSystem;

  qa.turns.push({ role: "user", content: userText });
  let full = "";
  try {
    for await (const ev of runHybrid(AGENTS.planner, userText, { system: sys })) {
      // Stream deltas live (like runPlanGate) so the HUD/TTS aren't silent during planning.
      // If a PLAN_JSON block turns up, we send a {reset} below and re-send the clean intro
      // so the raw JSON is never read aloud.
      if (ev.type === "text") { full += ev.delta; node.thought(ev.delta); send(ws, { type: "text", delta: ev.delta }); }
      else if (ev.type === "tool") { node.tool(ev.name, ev.detail); send(ws, { type: "tool", name: ev.name, detail: ev.detail }); }
      else if (ev.type === "fallback") send(ws, { type: "agent", name: "planner", via: "local-fallback" });
      else if (ev.type === "reset") { full = ""; send(ws, { type: "reset" }); }
      else if (ev.type === "result") full = ev.text || full;
    }
  } catch (err) {
    node.done(false);
    const msg = isClaudeUnavailable(err)
      ? "I can't reach the models to plan that right now — please try again shortly."
      : isIncomplete(err)
        ? "I couldn't finish planning that. Want me to try again or simplify the goal?"
        : "I hit a problem planning that.";
    if (!isIncomplete(err) && !isClaudeUnavailable(err)) console.error("[jarvis] planner failed:", err);
    send(ws, { type: "text", delta: msg });
    send(ws, { type: "done", result: msg });
    return;
  }
  qa.turns.push({ role: "assistant", content: full.trim() });

  const idx = full.indexOf(PLAN_MARKER);
  if (idx === -1) {
    // Still clarifying — the question already streamed live; just finalize the turn.
    node.done(true);
    // Persist the exchange so the planning conversation carries context across turns.
    if (full.trim()) { memory.appendTurn(userText, full.trim()); session.recordTurn(ws, userText, full.trim()); }
    pendingPlans.set(ws, { agent: "planner", userText: qa.goal, honorific, qa });
    send(ws, { type: "done", result: full.trim() });
    return;
  }

  // A plan was emitted. The raw text (incl. JSON) streamed live, so reset the HUD/TTS and
  // re-send only the clean intro + confirmation prompt (the JSON is never read aloud).
  const spoken = full.slice(0, idx).trim() || "Here's the plan.";
  const tasks = parsePlan(full.slice(idx + PLAN_MARKER.length));
  node.done(tasks.length > 0);
  send(ws, { type: "reset" });
  if (tasks.length === 0) {
    const msg = "I couldn't form a clear plan for that — could you give me a bit more detail?";
    pendingPlans.set(ws, { agent: "planner", userText: qa.goal, honorific, qa });
    send(ws, { type: "text", delta: msg });
    send(ws, { type: "done", result: msg });
    return;
  }
  const summary = `${spoken} ${tasks.length} step${tasks.length > 1 ? "s" : ""}. Shall I go ahead?`;
  pendingPlans.set(ws, { agent: "planner", userText: qa.goal, honorific, project: { goal: qa.goal, tasks } });
  send(ws, { type: "text", delta: summary });
  send(ws, { type: "done", result: summary });
}

/** Build a project from an approved plan and run it through the PM pipeline. */
async function startProject(
  ws: WebSocket,
  trace: Trace,
  parentId: string,
  planned: { goal: string; tasks: PlannedTask[] },
  honorific?: string,
) {
  const project = makeProject(planned.goal, planned.tasks, config.repoDir, session.getSession(ws)?.id);
  await saveProject(project);
  session.attachProject(ws, project.id);
  send(ws, { type: "agent", name: "pm", via: "project" });

  // Register the project run for barge-in/cancel, like a normal turn.
  const ctl = new AbortController();
  activeTurns.set(ws, ctl);

  const node = trace.spawn({ name: "pm", tier: "hybrid", role: "implement", parent: parentId });
  let acc = "";
  const deps: PmDeps = {
    onText: (d) => { acc += d; node.thought(d); send(ws, { type: "text", delta: d }); },
    onAgent: (name, via) => send(ws, { type: "agent", name, via }),
    onProject: (e) => send(ws, { type: "project", ...e }),
    signal: ctl.signal,
  };

  try {
    await runProject(project, deps);
    node.done(project.state === "done");
  } catch (err) {
    node.done(false);
    console.error("[jarvis] project run failed:", err);
    if (!ctl.signal.aborted) send(ws, { type: "error", message: "the project run hit a problem" });
  } finally {
    if (activeTurns.get(ws) === ctl) activeTurns.delete(ws);
  }

  if (ctl.signal.aborted) return;   // barge-in: cancel handler already settled the HUD
  if (acc.trim()) {
    memory.appendTurn(planned.goal, acc.trim());
    session.recordTurn(ws, planned.goal, acc.trim());
    void memory.capture().then(() => memory.maybeConsolidate()).catch(() => {});
  }
  send(ws, { type: "done", result: acc.trim() || "Project finished." });
}

export function startServer() {
  vscodeBridge.ensureToken(); // create the editor secret file before the extension connects
  mobileAuth.ensureToken();   // create the mobile secret file before the phone pairs
  const wss = new WebSocketServer({ host: config.wsHost, port: config.wsPort });

  const sendAgents = (ws: WebSocket) =>
    send(ws, {
      type: "agents",
      list: Object.values(AGENTS).map((a) => ({ name: a.name, description: a.description, tier: a.tier })),
    });
  const sendModels = (ws: WebSocket) =>
    send(ws, { type: "models", list: listModels(), current: getCurrentModel() });
  const welcome = (ws: WebSocket) => {
    checkHealth().then((h) => send(ws, { type: "health", ...h }));
    sendAgents(ws);
    sendModels(ws);
    send(ws, phoneStatus());
  };

  wss.on("connection", (ws, req) => {
    if (mobileAuth.isLoopback(req.socket.remoteAddress)) {
      // Same-machine client (Mac app, VS Code extension, iOS simulator): trusted
      // exactly as before — immediate welcome burst, implicit desktop role.
      clientRole.set(ws, "desktop");
      welcome(ws);
    } else {
      // Remote socket (only reachable when JARVIS_WS_HOST widens the bind):
      // quarantined — nothing sent, nothing but a mobile hello honored, and a
      // 10s deadline to authenticate before the socket is dropped.
      const deadline = setTimeout(() => { if (!clientRole.has(ws)) ws.close(4001, "auth timeout"); }, 10_000);
      ws.once("close", () => clearTimeout(deadline));
    }
    ws.on("close", () => {
      const wasMobile = clientRole.get(ws) === "mobile";
      clientRole.delete(ws);            // forget the socket's role
      mobileDevices.delete(ws);
      pendingPlans.delete(ws);          // drop any unanswered plan gate
      activeTurns.get(ws)?.abort();     // abort any in-flight turn
      activeTurns.delete(ws);
      session.dropSession(ws);          // forget the in-memory session (its file persists)
      if (wasMobile) broadcastToDesktop(phoneStatus());  // false only when the last phone left
    });

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: "error", message: "invalid JSON" });
      }
      // Unauthenticated remote sockets may only introduce themselves.
      if (!clientRole.has(ws) && msg.type !== "hello") {
        return ws.close(4001, "unauthenticated");
      }
      switch (msg.type) {
        case "hello":
          // The VS Code extension introduces itself so we route the coder stream to
          // it. Gated by the shared secret so an arbitrary local process can't pose as
          // the editor; a bad/absent token closes the socket. Loopback-only.
          if (msg.role === "editor") {
            if (clientRole.get(ws) === "desktop" && vscodeBridge.verifyToken(msg.token)) {
              clientRole.set(ws, "editor");
              vscodeBridge.register(ws);
            } else { console.warn("[jarvis] editor hello rejected (bad token or remote)"); ws.close(); }
          } else if (msg.role === "mobile") {
            // The iOS client authenticates with the pairing token. Loopback clients
            // (simulator) may also send this — they just re-tag themselves mobile.
            if (mobileAuth.verifyToken(msg.token)) {
              clientRole.set(ws, "mobile");
              if (typeof msg.device === "string" && msg.device) mobileDevices.set(ws, msg.device);
              send(ws, { type: "hello_ok", role: "mobile" });
              welcome(ws);
              broadcastToDesktop(phoneStatus());
              console.log(`[jarvis] mobile client connected${typeof msg.device === "string" ? ` (${msg.device})` : ""}`);
            } else { console.warn("[jarvis] mobile hello rejected (bad token)"); ws.close(4001, "bad token"); }
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
          // Hot-swapping the :8080 slot stalls any in-flight local work — not a
          // decision to take from a phone in a pocket.
          if (clientRole.get(ws) === "mobile") return send(ws, { type: "error", message: "model swap is only available from the Mac app" });
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
        case "cancel": {
          // Barge-in: the user spoke over Jarvis. Abort the in-flight turn (the runner
          // aborts the SDK stream) and drive the HUD back to idle. Processed concurrently
          // with the still-running handlePrompt because ws message handlers don't serialize.
          const ctl = activeTurns.get(ws);
          if (ctl) ctl.abort();
          send(ws, { type: "cancelled" });
          send(ws, { type: "status", state: "idle" });
          break;
        }
        case "session_open": {
          // Explicit open (HUD button) — equivalent to the "Hey Jarvis" greeting branch.
          try { const s = session.openSession(ws); send(ws, { type: "session", state: "open", id: s.id }); } catch { /* enhancement */ }
          break;
        }
        case "session_close": {
          // Explicit close (HUD button) — consolidate + clear, mirroring the close intent.
          if (session.hasOpenSession(ws)) {
            void memory.maybeConsolidate(true).catch(() => {});
            const s = session.closeSession(ws);
            session.dropSession(ws);
            memory.clearShortTerm();
            send(ws, { type: "session", state: "closed", id: s?.id });
          }
          break;
        }
        case "act_result":
          // Reply from the app for a desktop/web tool call — resolve its pending Promise.
          resolveAct(msg);
          break;
        case "provider_config":
          // App pushed alternate-provider settings (e.g. Ollama Cloud key) — persist
          // for the router and update the runner's fallback chain.
          providers.applyProviderConfig(msg);
          break;
        case "shutdown":
          // Powering off the Mac stack is a desktop-only privilege.
          if (clientRole.get(ws) === "mobile") return send(ws, { type: "error", message: "shutdown is only available from the Mac app" });
          // Power-off from the HUD: tear down the Jarvis-owned services (2B :8081,
          // TTS :8082, and this orchestrator on :7777) but leave the shared hybrid
          // 9B + router up for claude-hybrid. The teardown is spawned DETACHED so it
          // keeps killing services after we exit; then we exit ourselves once the ack
          // has flushed.
          send(ws, { type: "status", state: "idle", detail: "powering off backend" });
          spawn("bash", [join(config.scriptsDir, "stop-backend.sh")], {
            detached: true,
            stdio: "ignore",
          }).unref();
          setTimeout(() => process.exit(0), 200);
          break;
        default:
          send(ws, { type: "error", message: `unknown message: ${msg.type}` });
      }
    });
  });

  // Graceful shutdown: a SIGTERM from stop-backend.sh / stop-jarvis.sh (or a daemon
  // `kill`) closes the WS server cleanly instead of dropping sockets mid-frame.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      try { wss.close(); } finally { process.exit(0); }
    });
  }

  console.log(`[jarvis] orchestrator listening on ws://${config.wsHost}:${config.wsPort}`);
  if (config.wsHost !== "127.0.0.1") {
    console.log(`[jarvis] non-loopback bind: remote clients must authenticate with the token in ${config.mobileTokenFile}`);
  }
  return wss;
}
