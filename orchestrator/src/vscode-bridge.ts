import type { WebSocket } from "ws";
import { config } from "./config.js";
import { makeTokenStore } from "./tokens.js";

/**
 * Bridge from the orchestrator to the Jarvis VS Code extension.
 *
 * The extension connects to the same :7777 server as the app, but announces itself
 * with `{type:"hello", role:"editor"}` so the server registers it here instead of
 * treating it as the app. The `coder` agent's token stream is then forwarded to the
 * editor as `editor_*` messages, which the extension types into the active editor.
 *
 * Unlike the desktop actuation bridge ([actuation.ts]), this is a persistent,
 * fire-and-forget stream: token order is preserved by TCP, so we don't ack each
 * delta (that would add a round-trip per token and stutter the typing).
 */

type EditorOutbound =
  | { type: "editor_open"; path: string }
  | { type: "editor_stream_begin"; id: string; path: string }
  | { type: "editor_stream_delta"; id: string; delta: string }
  | { type: "editor_stream_end"; id: string; save: boolean }
  | { type: "editor_stream_abort"; id: string }
  | { type: "editor_command"; id: string; command: string; args?: unknown[] };

// Usually one VS Code window; a Set tolerates several (we send to all of them).
const editors = new Set<WebSocket>();

// ── Editor auth ──────────────────────────────────────────────────────────────
// The :7777 socket is open to any local process, so the privileged "editor" role is
// gated by a shared secret persisted 0600 (the extension reads the same file).
const store = makeTokenStore(config.editorTokenFile);
export const ensureToken = store.ensure;
export const verifyToken = store.verify;

/** Register a socket that introduced itself as `role:"editor"`. */
export function register(ws: WebSocket): void {
  editors.add(ws);
  ws.once("close", () => editors.delete(ws));
  console.log(`[jarvis] VS Code editor connected (${editors.size} now)`);
}

export function unregister(ws: WebSocket): void {
  editors.delete(ws);
}

/** True when at least one VS Code window with the extension is connected. */
export function isConnected(): boolean {
  return editors.size > 0;
}

function broadcast(msg: EditorOutbound): void {
  const data = JSON.stringify(msg);
  for (const ws of editors) if (ws.readyState === ws.OPEN) ws.send(data);
}

export const open = (path: string) => broadcast({ type: "editor_open", path });
export const beginStream = (id: string, path: string) => broadcast({ type: "editor_stream_begin", id, path });
export const delta = (id: string, text: string) => broadcast({ type: "editor_stream_delta", id, delta: text });
export const endStream = (id: string, save = true) => broadcast({ type: "editor_stream_end", id, save });
export const abortStream = (id: string) => broadcast({ type: "editor_stream_abort", id });
export const runCommand = (id: string, command: string, args?: unknown[]) =>
  broadcast({ type: "editor_command", id, command, args });
