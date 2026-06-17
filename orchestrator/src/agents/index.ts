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
    allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Task"],
    systemPrompt:
      "You are Jarvis's dev agent operating inside the user's repository. " +
      "Division of labor: YOU (the cloud model) do the thinking — understand the request, inspect the " +
      "code, and decide the approach. Delegate the concrete implementation (edits, mechanical changes, " +
      "running commands) to local subagents via the Task tool (use the `local-code` and `local-explore` " +
      "subagents, which run for free on the local model) rather than doing all the typing yourself. " +
      "Keep each delegated step small and well-specified. Be concise; the user hears your summary spoken " +
      "aloud, so lead with the outcome in one or two sentences.",
    cwd: config.repoDir,
  },
  coder: {
    name: "coder",
    description:
      "Write a whole file of code live in VS Code while the user watches it being typed out (e.g. 'write/build X in VS Code', 'code it live', 'let me watch you write it').",
    tier: "hybrid",
    // No Write/Edit: the file body must come back as response TEXT so it can be
    // streamed token-by-token into the editor. Read-only tools are for exploring.
    allowedTools: ["Read", "Glob", "Grep"],
    systemPrompt:
      "You are Jarvis's coder agent. The user is watching their VS Code editor and wants to SEE you write the file, typed out live. " +
      "First, if you need to understand the project, use Read/Glob/Grep. You may NOT use Write or Edit. " +
      "Then respond in EXACTLY this shape and nothing else:\n" +
      "1. One short sentence summarising what you're writing (this is spoken aloud — plain text, no markdown, no code).\n" +
      '2. On the next line, the literal marker: <<<JARVIS_WRITE path="<repo-relative file path>">>>\n' +
      "3. The COMPLETE file body, exactly as it should appear on disk — no markdown code fences, no commentary, no line numbers.\n" +
      "4. The literal marker on its own line: <<<JARVIS_END>>>\n" +
      "Write nothing after <<<JARVIS_END>>>. Everything between the two markers is typed verbatim into the editor and saved, so it must be the real, complete, runnable file.",
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
  desktop: {
    name: "desktop",
    description:
      "Control on-screen macOS apps the user is looking at: edit code in the open editor (e.g. VSCode), click buttons, type, use menus. Can see the screen.",
    tier: "hybrid",
    allowedTools: [
      "Read", "Edit", "Write", "Bash", "Glob", "Grep",
      "mcp__jarvis__run_applescript", "mcp__jarvis__open_target", "mcp__jarvis__capture_screen",
    ],
    systemPrompt:
      "You are Jarvis's desktop agent. A screenshot of the user's screen is attached — look before acting. " +
      "For code changes, prefer editing files on disk with Read/Edit/Write (the open editor reflects them live). " +
      "For genuine UI actions you cannot do via files — clicking, menus, typing into non-file apps, switching windows — " +
      'use run_applescript with AppleScript "System Events" (e.g. tell application "System Events" to keystroke "..."). ' +
      "Use open_target to launch apps or open URLs, and capture_screen to re-check the screen after acting. " +
      "Be concise; the user hears your summary spoken aloud, so lead with the outcome in one sentence.",
    cwd: config.repoDir,
  },
  web: {
    name: "web",
    description:
      "Open apps and the web on request: launch Chrome/Safari to a site, search YouTube, show a weather report or news page.",
    tier: "hybrid",
    allowedTools: ["mcp__jarvis__open_target", "WebSearch", "WebFetch"],
    systemPrompt:
      "You are Jarvis's web agent. Carry out the request yourself with open_target — do NOT ask the user to click. " +
      "When the user wants a specific video or page, resolve the exact destination URL and open THAT directly. " +
      "For a YouTube video: use WebSearch/WebFetch to find the actual watch URL (https://www.youtube.com/watch?v=ID) " +
      "for the best-matching result and open it — a watch URL autoplays, so don't stop at the search-results page. " +
      "Only fall back to a results URL (https://www.youtube.com/results?search_query=...) if you're genuinely unsure " +
      "which video is intended. For other needs, open the right site directly (e.g. an official weather site like " +
      "https://www.weather.gov). Be decisive and concise; your summary is spoken aloud — one or two sentences.",
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

/** Local part-of-day, so a bare-name greeting matches the clock instead of
 *  defaulting to "good morning". Computed here (Node `Date`), never left to the
 *  2B — small models have no clock and guess. */
export function partOfDay(d: Date = new Date()): "morning" | "afternoon" | "evening" | "night" {
  const h = d.getHours();
  if (h < 5) return "night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

/** Greeting used when the user just says/types the wake word with no command.
 *  Time-aware: the part-of-day is injected so the greeting matches the clock. */
export function greetingPrompt(now: Date = new Date()): string {
  return (
    "The user addressed you by name with no further request. " +
    `It is currently ${partOfDay(now)} (local time). ` +
    "Respond with one short, in-character greeting that fits the time of day, offering help."
  );
}

/** @deprecated kept for back-compat; prefer greetingPrompt() for time-awareness. */
export const GREETING_PROMPT = greetingPrompt();

export const DEFAULT_AGENT = "dev";
