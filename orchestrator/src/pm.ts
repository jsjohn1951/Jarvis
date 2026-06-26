import { config } from "./config.js";
import { runHybrid, cloudComplete, StallError, MaxTurnsError } from "./runner.js";
import { assessCompletion, type TerminatedReason } from "./completion.js";
import { AGENTS, type AgentDef } from "./agents/index.js";
import { systemBase } from "./personality.js";
import { catalogText, getSkillsCatalog } from "./skills-catalog.js";
import { ensureCoderLoaded, restore9B } from "./models.js";
import {
  type Project, type Task, nextRunnableTasks, markRunning, applyTaskResult,
  applyReview, failTask, isComplete, projectStateFrom, saveProject,
} from "./project.js";

/**
 * The PM pipeline driver — the orchestrator-side state machine that runs an approved
 * project to completion: dispatch coder tasks (local coder model, concurrent), verify
 * each with the same completion gate the server uses, then gate on the reviewer agent.
 *
 * Division of labor matches the user's design: IMPLEMENTATION runs locally (the dedicated
 * coder model on :8080, spared the cloud session), while REVIEW and the PM summary prefer
 * the CLOUD (quality) with a local fallback. Every transition is persisted via project.ts,
 * so a cloud outage or restart mid-run is recoverable.
 */

export interface ProjectEvent {
  event: "created" | "progress" | "done" | "failed";
  id: string;
  goal?: string;
  state?: string;
  tasks?: { id: string; title: string; state: string }[];
  detail?: string;
}

/** Callbacks the server wires to its WebSocket send — keeps pm decoupled from the wire. */
export interface PmDeps {
  onText: (delta: string) => void;            // stream coder/PM text to the HUD + TTS
  onAgent: (name: string, via: string) => void;
  onProject: (e: ProjectEvent) => void;       // project lifecycle for the HUD
  signal?: AbortSignal;                        // barge-in / shutdown
}

const snapshot = (p: Project) => p.plan.map((t) => ({ id: t.id, title: t.title, state: t.state }));
// Total attempts a task gets: the initial run + projectMaxTaskContinuations retries.
const maxAttempts = () => config.projectMaxTaskContinuations + 1;

interface RunOutcome {
  full: string;
  writtenPaths: string[];
  toolRan: boolean;
  ranLocal: boolean;
  reason: TerminatedReason;
}

/** Drive one runHybrid stream to completion, collecting the evidence a verdict needs. */
async function consume(
  def: AgentDef,
  prompt: string,
  system: string,
  deps: PmDeps,
  opts: { localOnly?: boolean; localModel?: string } = {},
): Promise<RunOutcome> {
  let full = "";
  let toolRan = false;
  let ranLocal = !!opts.localOnly;
  const writtenPaths: string[] = [];
  let reason: TerminatedReason = "natural";
  try {
    for await (const ev of runHybrid(def, prompt, { system, signal: deps.signal, ...opts })) {
      if (ev.type === "text") { full += ev.delta; deps.onText(ev.delta); }
      else if (ev.type === "tool") {
        toolRan = true;
        if ((ev.name === "Write" || ev.name === "Edit") && ev.path) writtenPaths.push(ev.path);
      } else if (ev.type === "fallback") { ranLocal = true; deps.onAgent(def.name, "local-fallback"); }
      else if (ev.type === "reset") { full = ""; }
      else if (ev.type === "result") { full = ev.text || full; }
    }
  } catch (err) {
    if (err instanceof StallError) reason = "stall";
    else if (err instanceof MaxTurnsError) reason = "max_turns";
    else reason = "error";
  }
  return { full, writtenPaths, toolRan, ranLocal, reason };
}

/** A headless coder agent for project tasks: real Write/Edit/Bash (so writtenPaths flow
 *  into the completion gate), no Task subagents (it runs as one local model). */
function coderDef(cwd: string): AgentDef {
  return {
    name: "coder",
    description: "PM project coder task",
    tier: "hybrid",
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    cwd,
  };
}

async function coderSystem(project: Project, task: Task): Promise<string> {
  const skills = catalogText(await getSkillsCatalog());
  return [
    systemBase(),
    `You are a coder working on a larger project. The overall goal is: ${project.goal}`,
    `Implement THIS task only: ${task.title}. Don't do other tasks.`,
    task.reviewNotes ? `A previous attempt was rejected — address this feedback: ${task.reviewNotes}` : "",
    "Make the real file changes with Write/Edit and run commands with Bash as needed. When finished, " +
      "end with ONE short sentence summarising what you changed (plain text — it may be read aloud).",
    skills,
  ].filter(Boolean).join("\n\n");
}

/** Run one coder task locally on the dedicated coder model. */
async function runCoderTask(project: Project, task: Task, deps: PmDeps): Promise<RunOutcome> {
  deps.onAgent("coder", "pm-task");
  const system = await coderSystem(project, task);
  return consume(coderDef(project.cwd), task.detail, system, deps, {
    localOnly: true,
    localModel: config.coderModel,
  });
}

/** Reviewer gate (cloud-first via the normal hybrid chain). Parses an explicit verdict. */
async function reviewTask(project: Project, task: Task, deps: PmDeps): Promise<{ approved: boolean; notes?: string }> {
  deps.onAgent("reviewer", "pm-review");
  const files = (task.writtenPaths ?? []).join(", ") || "(inspect the repo)";
  const system = [
    systemBase(),
    "You are Jarvis's reviewer. Verify whether the task was implemented correctly and completely. " +
      "Inspect the changed files with Read/Glob/Grep and run quick checks with Bash if useful. " +
      "End your reply with EXACTLY one final line: 'VERDICT: APPROVED' or " +
      "'VERDICT: CHANGES - <one-line reason>'.",
  ].join("\n\n");
  const prompt =
    `Task: ${task.title}\nInstruction: ${task.detail}\nFiles changed: ${files}\n` +
    `The coder reported: ${task.result ?? "(no summary)"}\n\nReview the work and give your verdict.`;
  const out = await consume(AGENTS.reviewer, prompt, system, deps);
  const approved = /VERDICT:\s*APPROVED/i.test(out.full);
  const m = out.full.match(/VERDICT:\s*CHANGES\s*[-—:]*\s*(.+)/i);
  const notes = m?.[1]?.trim() ?? (approved ? undefined : "Reviewer requested changes.");
  return { approved, notes };
}

/** One- or two-sentence wrap-up (cloud PM, local fallback). */
async function pmSummary(project: Project): Promise<string> {
  const outcomes = project.plan.map((t) => `- ${t.title}: ${t.state}`).join("\n");
  const prompt =
    `You are the project manager. Goal: "${project.goal}". Task outcomes:\n${outcomes}\n` +
    "Summarise the result for the user in one or two spoken sentences. Plain text.";
  const sys = "You are a concise project manager. Plain text, 1-2 sentences.";
  const cloud = await cloudComplete(prompt, sys).catch(() => "");
  if (cloud) return cloud.trim();
  // Cloud unavailable → summarise on the local coder model.
  let out = "";
  try {
    for await (const ev of runHybrid(coderDef(project.cwd), prompt, { system: sys, localOnly: true, localModel: config.coderModel })) {
      if (ev.type === "text") out += ev.delta;
      else if (ev.type === "result") out = ev.text || out;
    }
  } catch { /* best-effort */ }
  return out.trim();
}

/** Run an approved project to done/failed. Idempotent transitions are persisted throughout. */
export async function runProject(project: Project, deps: PmDeps): Promise<void> {
  deps.onProject({ event: "created", id: project.id, goal: project.goal, tasks: snapshot(project) });
  const usingCoder = await ensureCoderLoaded().catch(() => false);
  try {
    while (!isComplete(project)) {
      if (deps.signal?.aborted) break;
      const batch = nextRunnableTasks(project, config.coderParallel);
      if (batch.length === 0) break;   // remaining tasks are blocked behind a failed dependency

      for (const t of batch) markRunning(project, t.id);
      await saveProject(project);
      deps.onProject({ event: "progress", id: project.id, tasks: snapshot(project) });

      // Coder tasks run concurrently against the -np 2 coder server (continuous batching).
      const outcomes = await Promise.all(
        batch.map(async (t) => ({ task: t, outcome: await runCoderTask(project, t, deps) })),
      );

      // Barge-in mid-batch: don't process the (aborted) outcomes — leave the running tasks
      // as-is so the project persists cleanly resumable. The abort guard below handles it.
      if (deps.signal?.aborted) break;

      for (const { task, outcome } of outcomes) {
        // Did the coder actually finish? Same completion gate the server uses per turn.
        const verdict = await assessCompletion({
          task: task.detail,
          reason: outcome.reason,
          toolRan: outcome.toolRan,
          result: outcome.full,
          writtenPaths: outcome.writtenPaths,
          continuationsUsed: task.attempts - 1,
          isLocal: outcome.ranLocal,
        });
        if (verdict.kind !== "done") {
          // Incomplete — re-queue for another attempt while budget remains, else fail.
          if (task.attempts < maxAttempts()) {
            task.state = "pending";
            task.reviewNotes = verdict.kind === "continue" ? verdict.remaining : "The previous attempt didn't complete.";
          } else {
            failTask(project, task.id, "Couldn't complete after several attempts.");
          }
          await saveProject(project);
          deps.onProject({ event: "progress", id: project.id, tasks: snapshot(project) });
          continue;
        }

        applyTaskResult(project, task.id, { result: outcome.full, writtenPaths: outcome.writtenPaths });
        await saveProject(project);

        const review = await reviewTask(project, task, deps);
        applyReview(project, task.id, review.approved, maxAttempts(), review.notes);
        // If review sent it back to pending, carry the feedback into the next attempt.
        const t2 = project.plan.find((x) => x.id === task.id);
        if (t2?.state === "pending" && review.notes) t2.reviewNotes = review.notes;
        await saveProject(project);
        deps.onProject({ event: "progress", id: project.id, tasks: snapshot(project) });
      }
    }
  } finally {
    if (usingCoder) await restore9B().catch(() => {});   // hand :8080 back to the 9B
  }

  // Barge-in / shutdown: reset any in-flight tasks to pending so the persisted project is
  // cleanly resumable, then let the cancel handler settle the HUD — don't announce a result.
  if (deps.signal?.aborted) {
    for (const t of project.plan) if (t.state === "running") t.state = "pending";
    project.state = "running";
    await saveProject(project);
    return;
  }

  // Stuck (incomplete with nothing runnable) → mark the stranded tasks failed for a clear board.
  if (!isComplete(project)) {
    for (const t of project.plan) if (t.state !== "approved" && t.state !== "failed") failTask(project, t.id, "blocked by a failed dependency");
  }
  project.state = projectStateFrom(project);
  await saveProject(project);
  const done = project.state === "done";
  const summary = await pmSummary(project).catch(() => "");
  const line =
    summary ||
    (done
      ? `All ${project.plan.length} tasks are complete and reviewed.`
      : "I finished what I could, but some tasks didn't pass review.");
  deps.onText(line);
  deps.onProject({ event: done ? "done" : "failed", id: project.id, state: project.state, tasks: snapshot(project), detail: line });
}
