import { mkdir, writeFile, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import type { Turn } from "./memory.js";

/**
 * A conversation Session — opened by "Hey Jarvis", closed only on an explicit
 * close intent ("goodbye" / "new conversation"). It is an ADDITIVE wrapper over the
 * existing short-term buffer: when no session is open, every turn behaves exactly as
 * before (memory.recentTurns() still reads the global buffer). A session merely gives
 * the conversation an identity, its own turn log, and a home for an active project.
 *
 * Keyed by WebSocket — the same per-connection discipline as the plan-gate's
 * pendingPlans Map — so two connected HUDs never share one context.
 */

export type SessionState = "open" | "closing" | "closed";

export interface Session {
  id: string;
  openedAt: number;
  lastActivityAt: number;
  state: SessionState;
  turns: Turn[];
  /** Set when a PM project is started within this session. */
  projectId?: string;
}

const sessions = new Map<WebSocket, Session>();

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const filePath = (id: string): string => join(config.sessionsDir, `${id}.json`);

export function getSession(ws: WebSocket): Session | undefined {
  return sessions.get(ws);
}

export function hasOpenSession(ws: WebSocket): boolean {
  return sessions.get(ws)?.state === "open";
}

/** Open a session for this connection (idempotent — returns the existing open one). */
export function openSession(ws: WebSocket): Session {
  const existing = sessions.get(ws);
  if (existing && existing.state === "open") return existing;
  const now = Date.now();
  const session: Session = { id: newId(), openedAt: now, lastActivityAt: now, state: "open", turns: [] };
  sessions.set(ws, session);
  void persist(session);
  return session;
}

/**
 * Record a completed turn into the session, opening one if none is active. The auto-open
 * makes the session robust to the WebSocket reconnecting (which orphans the ws-keyed
 * session opened by the greeting) and to conversations that never started with "Hey
 * Jarvis" — the conversation is always captured rather than silently dropped.
 */
export function recordTurn(ws: WebSocket, user: string, assistant: string): void {
  let s = sessions.get(ws);
  if (!s || s.state !== "open") s = openSession(ws);
  s.turns.push({ role: "user", content: user }, { role: "assistant", content: assistant });
  s.lastActivityAt = Date.now();
  void persist(s);
}

/** Mark the session closed and return it (for the caller to consolidate). */
export function closeSession(ws: WebSocket): Session | undefined {
  const s = sessions.get(ws);
  if (!s) return undefined;
  s.state = "closed";
  s.lastActivityAt = Date.now();
  void persist(s);
  return s;
}

/** Forget the in-memory session for a connection (e.g. on ws close). The file stays. */
export function dropSession(ws: WebSocket): void {
  sessions.delete(ws);
}

/** Attach a started project to the open session. */
export function attachProject(ws: WebSocket, projectId: string): void {
  const s = sessions.get(ws);
  if (!s) return;
  s.projectId = projectId;
  void persist(s);
}

/**
 * Does this utterance ask to end the conversation / start fresh? Regex-only (like the
 * fast path of isAffirmation) — generalizes the former "new conversation / forget that"
 * command so a session close and a context clear share one intent test.
 */
export function isCloseIntent(text: string): boolean {
  return /^(goodbye|good bye|bye|that'?s all|that is all|we'?re done|we are done|all done|new conversation|forget (that|this|it)|start over|clear (memory|context)|thanks,? that'?s (it|all))\b/i.test(
    text.trim(),
  );
}

// ── Persistence (best-effort; sessions are an enhancement, never a hard dependency) ──

export async function persist(s: Session): Promise<void> {
  try {
    await mkdir(config.sessionsDir, { recursive: true });
    const tmp = filePath(s.id) + ".tmp";
    await writeFile(tmp, JSON.stringify(s, null, 2));
    await rename(tmp, filePath(s.id)); // atomic: a crash mid-write can't corrupt the file
  } catch {
    /* non-fatal */
  }
}

/** Load sessions left in the "open" state (e.g. after an orchestrator restart). */
export async function loadOpenSessions(): Promise<Session[]> {
  try {
    const files = (await readdir(config.sessionsDir)).filter((f) => f.endsWith(".json"));
    const out: Session[] = [];
    for (const f of files) {
      try {
        const s = JSON.parse(await readFile(join(config.sessionsDir, f), "utf8")) as Session;
        if (s.state === "open") out.push(s);
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  } catch {
    return [];
  }
}
