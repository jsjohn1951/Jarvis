import type { WebSocket } from "ws";

/**
 * Request/response bridge for desktop actuation.
 *
 * The orchestrator's `desktop`/`web` agents reason here, but the *actions* run in
 * the Swift app (it holds the Automation / Screen Recording grants). So a tool call
 * sends `{type:"act", id, …}` to the app and awaits the matching
 * `{type:"act_result", id, …}` — JSON-RPC-style correlation by `id` keeps concurrent
 * tool calls from crossing wires. A timeout guarantees a disconnected app can't hang
 * the agent loop.
 */

export interface ActResult {
  ok: boolean;
  output?: string;
  image?: string;   // base64 PNG, for capture
  error?: string;
}

export interface ActRequest {
  action: "open" | "applescript" | "capture";
  app?: string;
  url?: string;
  script?: string;
}

type Pending = { resolve: (r: ActResult) => void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
let counter = 0;

/** Send an action to the app and resolve with its result (or a timeout error). */
export function runAct(ws: WebSocket, req: ActRequest, timeoutMs = 30_000): Promise<ActResult> {
  const id = `act-${Date.now()}-${counter++}`;
  return new Promise<ActResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: "actuation timed out (is the Jarvis app connected?)" });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    try {
      ws.send(JSON.stringify({ type: "act", id, ...req }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

/** Resolve a pending request from an incoming `{type:"act_result"}` message. */
export function resolveAct(msg: any): void {
  const id = typeof msg?.id === "string" ? msg.id : undefined;
  if (!id) return;
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve({ ok: !!msg.ok, output: msg.output, image: msg.image, error: msg.error });
}
