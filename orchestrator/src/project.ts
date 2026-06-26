import { mkdir, writeFile, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * A PM "project" — the data + transitions behind the planner→coder→reviewer pipeline.
 *
 * This module is deliberately PURE (transitions are synchronous, IO is only the
 * save/load helpers) so the state machine is unit-testable in isolation, the same way
 * completion.ts's classify() is. The orchestration that drives it — running coder turns,
 * PM reasoning, the reviewer gate — lives in pm.ts.
 *
 * The on-disk JSON (memory/projects/<id>.json) is the source of truth: every transition
 * is persisted, so a project survives a cloud outage or an orchestrator restart and can
 * be resumed.
 */

export type TaskState = "pending" | "running" | "review" | "approved" | "failed";
export type ProjectState = "planning" | "running" | "done" | "failed";

export interface Task {
  id: string;
  title: string;
  /** The concrete instruction handed to the coder agent. */
  detail: string;
  state: TaskState;
  /** Completed runs so far (incremented by markRunning). Bounds re-attempts. */
  attempts: number;
  /** Task ids that must be approved before this one may run (omitted = independent). */
  dependsOn?: string[];
  result?: string;
  reviewNotes?: string;
  writtenPaths?: string[];
}

export interface Project {
  id: string;
  sessionId?: string;
  goal: string;
  plan: Task[];
  state: ProjectState;
  createdAt: number;
  updatedAt: number;
  /** Repo the coder operates in. */
  cwd: string;
}

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const filePath = (id: string): string => join(config.projectsDir, `${id}.json`);

/** Build a project from a parsed plan (the planner's final, approved task list). */
export function makeProject(goal: string, tasks: Omit<Task, "state" | "attempts">[], cwd: string, sessionId?: string): Project {
  const now = Date.now();
  return {
    id: newId(),
    sessionId,
    goal,
    plan: tasks.map((t) => ({ ...t, state: "pending", attempts: 0 })),
    state: "running",
    createdAt: now,
    updatedAt: now,
    cwd,
  };
}

const byId = (p: Project, id: string): Task | undefined => p.plan.find((t) => t.id === id);

/** A task is runnable when pending and all its dependencies are approved. */
function isRunnable(p: Project, t: Task): boolean {
  if (t.state !== "pending") return false;
  if (!t.dependsOn || t.dependsOn.length === 0) return true;
  return t.dependsOn.every((dep) => byId(p, dep)?.state === "approved");
}

/** Up to `parallel` runnable tasks, in plan order — the next batch to dispatch. */
export function nextRunnableTasks(p: Project, parallel: number): Task[] {
  const out: Task[] = [];
  for (const t of p.plan) {
    if (isRunnable(p, t)) out.push(t);
    if (out.length >= parallel) break;
  }
  return out;
}

export function markRunning(p: Project, id: string): void {
  const t = byId(p, id);
  if (!t) return;
  t.state = "running";
  t.attempts += 1;
  p.updatedAt = Date.now();
}

export function applyTaskResult(p: Project, id: string, r: { result: string; writtenPaths: string[] }): void {
  const t = byId(p, id);
  if (!t) return;
  t.result = r.result;
  t.writtenPaths = r.writtenPaths;
  t.state = "review";
  p.updatedAt = Date.now();
}

/**
 * Apply the reviewer's verdict. On approval the task is done; on rejection it goes back
 * to pending for another attempt — until it has used its attempt budget, after which it
 * fails. `maxAttempts` is passed in (not read from config) to keep this pure/testable.
 */
export function applyReview(p: Project, id: string, approved: boolean, maxAttempts: number, notes?: string): void {
  const t = byId(p, id);
  if (!t) return;
  if (approved) {
    t.state = "approved";
  } else {
    t.reviewNotes = notes;
    t.state = t.attempts < maxAttempts ? "pending" : "failed";
  }
  p.updatedAt = Date.now();
}

/** Mark a task failed outright (e.g. the coder gave up / errored irrecoverably). */
export function failTask(p: Project, id: string, notes?: string): void {
  const t = byId(p, id);
  if (!t) return;
  t.state = "failed";
  if (notes) t.reviewNotes = notes;
  p.updatedAt = Date.now();
}

/** Complete = no task is still pending/running/review. */
export function isComplete(p: Project): boolean {
  return p.plan.every((t) => t.state === "approved" || t.state === "failed");
}

/** Overall state derived from the task states. A project that is incomplete but has no
 *  runnable task left (everything remaining is blocked behind a failed dependency) is
 *  stuck — report that as failed so the driver doesn't treat it as still running. */
export function projectStateFrom(p: Project): ProjectState {
  if (isComplete(p)) return p.plan.every((t) => t.state === "approved") ? "done" : "failed";
  return nextRunnableTasks(p, 1).length === 0 ? "failed" : "running";
}

/** True when no runnable task remains but the project isn't complete — i.e. the rest are
 *  blocked behind a failed dependency, so the loop must stop rather than spin. */
export function isStuck(p: Project, parallel: number): boolean {
  return !isComplete(p) && nextRunnableTasks(p, parallel).length === 0;
}

// ── Persistence (atomic: tmp + rename, so a crash mid-write can't corrupt the file) ──

export async function saveProject(p: Project): Promise<void> {
  p.updatedAt = Date.now();
  await mkdir(config.projectsDir, { recursive: true });
  const tmp = filePath(p.id) + ".tmp";
  await writeFile(tmp, JSON.stringify(p, null, 2));
  await rename(tmp, filePath(p.id));
}

export async function loadProject(id: string): Promise<Project | undefined> {
  try {
    return JSON.parse(await readFile(filePath(id), "utf8")) as Project;
  } catch {
    return undefined;
  }
}

/** Projects that aren't finished — for resume after a restart. */
export async function loadActiveProjects(): Promise<Project[]> {
  try {
    const files = (await readdir(config.projectsDir)).filter((f) => f.endsWith(".json"));
    const out: Project[] = [];
    for (const f of files) {
      try {
        const p = JSON.parse(await readFile(join(config.projectsDir, f), "utf8")) as Project;
        if (p.state === "running" || p.state === "planning") out.push(p);
      } catch { /* skip unreadable */ }
    }
    return out;
  } catch {
    return [];
  }
}
