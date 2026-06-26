/**
 * Agent-trace emitter for the node-graph visualization.
 *
 * The orchestrator drives a small set of phases per turn (interpret → ack → plan →
 * implement). This assigns each a stable node id and emits `agent_spawn` /
 * `agent_thought` / `agent_tool` / `agent_done` so the app can draw the graph as
 * the work happens. It models the phases Jarvis itself orchestrates — not the Agent
 * SDK's internal subagents — which is exactly the cloud-plans/local-implements
 * structure the user wants to watch.
 */
export type Role = "interpret" | "ack" | "plan" | "implement" | "answer" | "fallback";

export interface TraceEmit {
  (msg:
    | { type: "agent_spawn"; id: string; name: string; parent?: string; tier: string; role: string }
    | { type: "agent_thought"; id: string; text: string }
    | { type: "agent_tool"; id: string; name: string; detail?: string }
    | { type: "agent_done"; id: string; ok: boolean }): void;
}

export interface TraceNode {
  id: string;
  /** Stream a chunk of the node's current "thinking" to the graph (throttled). */
  thought(text: string): void;
  /** Record a tool the node invoked, with an optional argument summary
   *  (skill name, file path, bash command, subagent type…). */
  tool(name: string, detail?: string): void;
  /** Mark the node finished. */
  done(ok?: boolean): void;
}

export function makeTrace(emit: TraceEmit) {
  let seq = 0;
  const turnId = Date.now().toString(36);

  function spawn(opts: { name: string; tier: "hybrid" | "local"; role: Role; parent?: string }): TraceNode {
    const id = `${turnId}-${seq++}`;
    emit({ type: "agent_spawn", id, name: opts.name, parent: opts.parent, tier: opts.tier, role: opts.role });

    // Throttle thought deltas: coalesce into ~80ms windows so we don't flood the ws
    // with one message per token while still feeling live.
    let buf = "";
    let timer: NodeJS.Timeout | null = null;
    const flush = () => {
      if (buf) { emit({ type: "agent_thought", id, text: buf }); buf = ""; }
      timer = null;
    };
    return {
      id,
      thought(text: string) {
        buf += text;
        if (!timer) timer = setTimeout(flush, 80);
      },
      tool(name: string, detail?: string) { emit({ type: "agent_tool", id, name, detail }); },
      done(ok = true) { flush(); emit({ type: "agent_done", id, ok }); },
    };
  }

  return { spawn };
}

export type Trace = ReturnType<typeof makeTrace>;
