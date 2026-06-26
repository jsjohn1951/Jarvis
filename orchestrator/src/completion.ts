import { access } from "node:fs/promises";
import { config } from "./config.js";
import { quickComplete } from "./quick.js";

/**
 * Completion verification — the "did the job actually get done?" gate.
 *
 * The Agent SDK loop ending does NOT mean the task succeeded: a small local model can
 * stall mid-turn, burn its turn budget, or "finish" without doing the work. After every
 * turn we gather cheap, local evidence and return a Verdict that the server acts on:
 * speak success, auto-continue the remaining work, ask the user how to proceed, or report
 * it can't be completed. Auto-continuation is bounded (config.maxContinuations) so a
 * confused model can't loop forever.
 */

/** How the agent's turn ended (see runner.ts: StallError / MaxTurnsError / clean exit). */
export type TerminatedReason = "natural" | "stall" | "max_turns" | "error";

export type Verdict =
  | { kind: "done" }
  | { kind: "continue"; remaining: string }              // auto re-dispatch the remaining work
  | { kind: "ask"; summary: string; options: string[] }  // park + let the user steer next
  | { kind: "giveup"; reason: string; options: string[] };

export interface TurnEvidence {
  /** The user's original request for this turn. */
  task: string;
  reason: TerminatedReason;
  /** A side-effecting tool ran (so partial work may exist on disk). */
  toolRan: boolean;
  /** The agent's final spoken/summary text. */
  result: string;
  /** Absolute Write/Edit targets seen this turn. */
  writtenPaths: string[];
  /** Whether every writtenPath exists on disk (resolved by assessCompletion). */
  filesPresent: boolean;
  /** Auto-continuations already spent on this task. */
  continuationsUsed: number;
  /** The local tier ran this turn (affects the give-up options we offer). */
  isLocal: boolean;
}

/** Spoken next-step suggestions, tailored to whether the cloud is an option. */
const askOptions = ["keep going with the current approach", "adjust the approach", "stop here"];
const giveupOptions = (isLocal: boolean) =>
  isLocal
    ? ["try again", "let me use the cloud model", "simplify the task", "switch the local model"]
    : ["try again", "simplify the task"];

function continuationHint(e: TurnEvidence): string {
  const files = e.writtenPaths.length ? ` Files touched so far: ${e.writtenPaths.join(", ")}.` : "";
  return (
    `Continue the task: "${e.task}". It did not finish last time` +
    `${e.reason === "stall" ? " (the previous attempt stalled)" : e.reason === "max_turns" ? " (ran out of steps)" : ""}.` +
    `${files} Pick up where it left off and complete the remaining work. Do not redo finished steps.`
  );
}

/**
 * Pure classifier — no IO, so the decision tree is unit-testable in isolation.
 * `maxContinuations` is passed in (not read from config) for the same reason.
 */
export function classify(e: TurnEvidence, maxContinuations: number): Verdict {
  const haveResult = e.result.trim().length > 0;
  const expectedFile = e.writtenPaths.length > 0;
  const budgetLeft = e.continuationsUsed < maxContinuations;

  if (e.reason === "natural") {
    // The agent ended its own loop. Done — unless a promised file never landed, or it
    // produced neither an answer nor any side effect.
    if (expectedFile && !e.filesPresent) {
      return budgetLeft
        ? { kind: "continue", remaining: `The file(s) ${e.writtenPaths.join(", ")} are missing — write them and finish "${e.task}".` }
        : { kind: "ask", summary: "I finished, but the file I was supposed to write isn't there.", options: askOptions };
    }
    if (!haveResult && !e.toolRan) {
      return { kind: "ask", summary: "I'm not sure I actually did anything for that.", options: askOptions };
    }
    return { kind: "done" };
  }

  if (e.reason === "stall" || e.reason === "max_turns") {
    // Self-evidently incomplete. Auto-continue while we have budget; otherwise hand the
    // decision to the user if there's progress to build on, else report we can't finish.
    if (budgetLeft) return { kind: "continue", remaining: continuationHint(e) };
    return e.toolRan || haveResult
      ? {
          kind: "ask",
          summary:
            e.reason === "stall"
              ? "That keeps stalling on the local model and I've made partial progress."
              : "That's taking more steps than I'm allowed in one go, and it's partly done.",
          options: askOptions,
        }
      : { kind: "giveup", reason: "I couldn't make progress on that.", options: giveupOptions(e.isLocal) };
  }

  // reason === "error"
  return { kind: "giveup", reason: "I hit an error trying to do that.", options: giveupOptions(e.isLocal) };
}

/** Result of the optional local self-check on a natural completion. */
export interface SelfCheck {
  done: boolean;
  missing: string;
  recoverable: boolean;
}

async function defaultFileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

/**
 * Ask the free 2B 'quick' tier whether the task looks complete given what the agent did.
 * Cheap (separate :8081 server, so it works even while the 9B is busy) and best-effort —
 * any failure or unparseable reply yields null and the heuristic decides alone.
 */
async function localSelfCheck(e: TurnEvidence): Promise<SelfCheck | null> {
  const reply = await quickComplete(
    `Task the assistant was asked to do: "${e.task}".\n` +
      `Files it wrote: ${e.writtenPaths.join(", ") || "none"}.\n` +
      `Its final message: "${e.result.slice(0, 800)}".\n\n` +
      `Did it COMPLETE the task? Reply with ONLY one JSON object: ` +
      `{"done": true|false, "missing": "<what's left, empty if done>", "recoverable": true|false}.`,
    "You verify whether a coding task was completed. Output only the JSON object, nothing else.",
    160,
  ).catch(() => "");

  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const j = JSON.parse(match[0]);
    return { done: !!j.done, missing: typeof j.missing === "string" ? j.missing : "", recoverable: j.recoverable !== false };
  } catch {
    return null;
  }
}

/**
 * Resolve file evidence + (for natural completions) a self-check, then classify.
 * `deps` are injectable so the server's real IO is swapped for fakes in tests.
 */
export async function assessCompletion(
  e: Omit<TurnEvidence, "filesPresent">,
  deps: { fileExists?: (p: string) => Promise<boolean>; selfCheck?: (e: TurnEvidence) => Promise<SelfCheck | null> } = {},
): Promise<Verdict> {
  const fileExists = deps.fileExists ?? defaultFileExists;
  const filesPresent =
    e.writtenPaths.length === 0 ? true : (await Promise.all(e.writtenPaths.map(fileExists))).every(Boolean);
  const ev: TurnEvidence = { ...e, filesPresent };

  // Abnormal terminations are already known-incomplete — no need to ask the model.
  if (ev.reason !== "natural") return classify(ev, config.maxContinuations);

  // Natural completion: confirm the work really happened, catching a model that
  // "finished" without doing it.
  const check = await (deps.selfCheck ?? localSelfCheck)(ev).catch(() => null);
  if (check && !check.done) {
    const budgetLeft = ev.continuationsUsed < config.maxContinuations;
    if (check.recoverable && budgetLeft) return { kind: "continue", remaining: check.missing || continuationHint(ev) };
    return { kind: "ask", summary: check.missing || "It looks like that isn't finished.", options: askOptions };
  }
  return classify(ev, config.maxContinuations);
}

/** Render an "ask"/"giveup" verdict as a short spoken line (options read as a list). */
export function speakVerdict(v: Extract<Verdict, { kind: "ask" | "giveup" }>): string {
  const lead = v.kind === "ask" ? v.summary : v.reason;
  return `${lead} Would you like me to ${v.options.join(", or ")}?`;
}
