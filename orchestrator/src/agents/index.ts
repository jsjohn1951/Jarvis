import { config } from "../config.js";

export type Tier = "hybrid" | "local";

export interface AgentDef {
  /** Stable id used by the dispatcher and the app. */
  name: string;
  /** One line — the dispatcher reads this to route commands. Keep it crisp. */
  description: string;
  /** "hybrid" → Claude Code via the router; "local" → 2B quick tier only. */
  tier: Tier;
  /** Tools the agent may use (hybrid only). */
  allowedTools?: string[];
  /** System prompt prepended to the task (hybrid only). */
  systemPrompt?: string;
  /** Working directory (hybrid only). Defaults to config.repoDir. */
  cwd?: string;
}

export const AGENTS: Record<string, AgentDef> = {
  dev: {
    name: "dev",
    description:
      "Real software work in the current repo: write/edit code, run commands, debug, refactor, explain the codebase.",
    tier: "hybrid",
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    systemPrompt:
      "You are Jarvis's dev agent operating inside the user's repository. Be concise; the user hears your summary spoken aloud, so lead with the outcome in one or two sentences.",
    cwd: config.repoDir,
  },
  researcher: {
    name: "researcher",
    description:
      "Read-only exploration and explanation: understand how something works, trace code, summarize files. No edits.",
    tier: "hybrid",
    allowedTools: ["Read", "Glob", "Grep"],
    systemPrompt:
      "You are Jarvis's researcher agent. Read-only. Answer with a spoken-summary-first structure: conclusion, then the few supporting details that matter.",
    cwd: config.repoDir,
  },
  planner: {
    name: "planner",
    description:
      "Break a goal into an ordered, concrete plan of steps. No edits, no execution.",
    tier: "hybrid",
    allowedTools: ["Read", "Glob", "Grep"],
    systemPrompt:
      "You are Jarvis's planner agent. Produce a short, ordered plan. No prose preamble.",
    cwd: config.repoDir,
  },
  reviewer: {
    name: "reviewer",
    description:
      "Review code or a diff for bugs, security issues, and quality. Reports findings; does not edit.",
    tier: "hybrid",
    allowedTools: ["Read", "Glob", "Grep", "Bash"],
    systemPrompt:
      "You are Jarvis's reviewer agent. Report every concrete issue with file:line, confidence, and severity. Lead the spoken summary with the count and the single most important finding.",
    cwd: config.repoDir,
  },
  quick: {
    name: "quick",
    description:
      "Instant factual or conceptual answers, definitions, quick system questions. No file access. Fast and free.",
    tier: "local",
    systemPrompt:
      "You are Jarvis, the user's calm, capable AI assistant (in the spirit of Iron Man's J.A.R.V.I.S). " +
      "Always answer in character and directly — never say you aren't Jarvis. " +
      "Your replies are read aloud, so keep them to 1–3 spoken sentences, plain text, and NEVER use emoji or markdown.",
  },
};

/** Greeting used when the user just says/types the wake word with no command. */
export const GREETING_PROMPT =
  "The user addressed you by name with no further request. Respond with one short, in-character greeting offering help.";

export const DEFAULT_AGENT = "dev";
