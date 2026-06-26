// Verifies the PM project state machine (pure transitions in project.ts): runnable-task
// selection honors concurrency + dependencies, the review/retry budget, and completion
// state. No IO. Run: npx tsx test/project-test.ts
import {
  makeProject, nextRunnableTasks, markRunning, applyTaskResult, applyReview,
  failTask, isComplete, projectStateFrom, isStuck, type Project,
} from "../src/project.js";

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}  ${detail}`);
  if (!cond) failures++;
}

const tasks = [
  { id: "t1", title: "one", detail: "do one" },
  { id: "t2", title: "two", detail: "do two" },
  { id: "t3", title: "three", detail: "do three", dependsOn: ["t1"] },
];
const mk = (): Project => makeProject("goal", tasks, "/repo", "sess1");

// ── initial state ─────────────────────────────────────────────────────────────
let p = mk();
check("all tasks pending", p.plan.every((t) => t.state === "pending"));
check("attempts start at 0", p.plan.every((t) => t.attempts === 0));
check("project state running", p.state === "running");

// ── nextRunnableTasks: concurrency cap + dependency gating ─────────────────────
check("parallel=2 returns 2 runnable (t3 gated by t1)", nextRunnableTasks(p, 2).map((t) => t.id).join(",") === "t1,t2");
check("parallel=1 returns just t1", nextRunnableTasks(p, 1).map((t) => t.id).join(",") === "t1");
check("t3 not runnable while t1 unapproved", !nextRunnableTasks(p, 9).some((t) => t.id === "t3"));

// ── markRunning increments attempts and changes state ─────────────────────────
markRunning(p, "t1");
check("markRunning → running, attempts 1", p.plan[0].state === "running" && p.plan[0].attempts === 1);

// ── completion → review → approval unlocks the dependent task ─────────────────
applyTaskResult(p, "t1", { result: "done one", writtenPaths: ["/repo/a.ts"] });
check("applyTaskResult → review", p.plan[0].state === "review");
applyReview(p, "t1", true, 3);
check("approved", p.plan[0].state === "approved");
check("t3 now runnable after t1 approved", nextRunnableTasks(p, 9).some((t) => t.id === "t3"));

// ── review rejection: re-queue within budget, fail past it ────────────────────
p = mk();
markRunning(p, "t2");                                  // attempts 1
applyTaskResult(p, "t2", { result: "x", writtenPaths: [] });
applyReview(p, "t2", false, 3, "fix the edge case");   // attempts(1) < 3 → pending
check("rejected within budget → pending", p.plan[1].state === "pending");
check("review notes carried", p.plan[1].reviewNotes === "fix the edge case");
markRunning(p, "t2");                                   // attempts 2
applyTaskResult(p, "t2", { result: "x", writtenPaths: [] });
applyReview(p, "t2", false, 3);                         // attempts(2) < 3 → pending
markRunning(p, "t2");                                   // attempts 3
applyTaskResult(p, "t2", { result: "x", writtenPaths: [] });
applyReview(p, "t2", false, 3);                         // attempts(3) !< 3 → failed
check("rejected past budget → failed", p.plan[1].state === "failed");

// ── isComplete / projectStateFrom / isStuck ───────────────────────────────────
p = mk();
check("not complete initially", !isComplete(p));
for (const t of p.plan) { markRunning(p, t.id); applyTaskResult(p, t.id, { result: "ok", writtenPaths: [] }); applyReview(p, t.id, true, 3); }
check("complete when all approved", isComplete(p));
check("projectStateFrom → done", projectStateFrom(p) === "done");

// A failed dependency strands its dependents → isStuck (no runnable tasks, not complete).
p = mk();
failTask(p, "t1", "blocked");
markRunning(p, "t2"); applyTaskResult(p, "t2", { result: "ok", writtenPaths: [] }); applyReview(p, "t2", true, 3);
check("stuck: t3 stranded behind failed t1", isStuck(p, 2));
check("projectStateFrom → failed", projectStateFrom(p) === "failed");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
