import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Skills awareness — the fix for "Jarvis doesn't realise it can use a skill."
 *
 * The Agent SDK already DISCOVERS skills from ~/.claude (so they're loadable), but the
 * model isn't reliably told WHICH skills exist or WHEN to reach for one. This module
 * builds a compact catalog (name + a one-line "use when") from the user's curated
 * skills dir and injects it into the planner/dev/coder/PM system prompts as explicit
 * steering. We deliberately read only ~/.claude/skills (the user's own ~dozens) and not
 * the hundreds of plugin skills, to keep the nudge high-signal and cheap on tokens —
 * `skills: 'all'` on the SDK side still makes every discovered skill loadable.
 */

export interface SkillEntry {
  name: string;
  useWhen: string;
}

const SKILLS_DIR = process.env.JARVIS_SKILLS_DIR ?? join(homedir(), ".claude", "skills");
const MAX_SKILLS = 40;      // cap the catalog so the prompt stays lean
const MAX_HINT = 140;       // truncate each description

// Skills that must NOT be offered to Jarvis's autonomous agents. These derailed a real
// session: a "create an Excel file" request pulled in superpowers:brainstorming and turned
// into a spec-writing workflow. We only ever read ~/.claude/skills (so plugin PROCESS skills
// like superpowers:* / plugin-dev:* are already excluded), and additionally drop:
//   - output-style PERSONA skills (caveman, noir, …) — detected by their "Use when user
//     types /x" trigger, which is the persona convention; they change tone, not do tasks.
//   - a few META skills by name (skill discovery / workflow routing) that aren't user tasks.
const DENY_NAMES = new Set(["find-skills", "using-superpowers", "hybrid-routing"]);
const isPersonaOrMeta = (e: SkillEntry): boolean =>
  DENY_NAMES.has(e.name) || /\btypes?\s+\/|activate\s+\w+\s+mode|\bmode["']?\b.*\bwhen\b/i.test(e.useWhen);

/** Parse `name:` and `description:` from a SKILL.md YAML frontmatter block. */
function parseFrontmatter(md: string, dirName: string): SkillEntry | null {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fm = m[1];
  const name = (fm.match(/^name:\s*(.+)$/m)?.[1] ?? dirName).trim().replace(/^["']|["']$/g, "");
  const descRaw = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  if (!descRaw) return null;
  // Keep the FULL description here — the persona filter (isPersonaOrMeta) needs to see the
  // whole thing (the "/trigger" often appears well past MAX_HINT); truncation is at render.
  return { name, useWhen: descRaw };
}

/** Enumerate the user's curated, task-appropriate skills. Best-effort — [] on any error. */
export async function loadSkills(): Promise<SkillEntry[]> {
  try {
    const dirs = await readdir(SKILLS_DIR, { withFileTypes: true });
    const entries: SkillEntry[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      try {
        const md = await readFile(join(SKILLS_DIR, d.name, "SKILL.md"), "utf8");
        const e = parseFrontmatter(md, d.name);
        if (e && !isPersonaOrMeta(e)) entries.push(e);   // drop personas / meta skills
      } catch { /* skip skills without a readable SKILL.md */ }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_SKILLS);
  } catch {
    return [];
  }
}

/** Render the catalog as a compact prompt block (empty string if no skills). */
export function catalogText(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";
  const lines = skills
    .map((s) => `- ${s.name}: ${s.useWhen.length > MAX_HINT ? s.useWhen.slice(0, MAX_HINT - 1).trimEnd() + "…" : s.useWhen}`)
    .join("\n");
  return (
    "## Skills you can use\n" +
    "You have these skills available via the Skill tool. When a task clearly matches one, USE it " +
    "rather than doing the work from scratch. Do NOT use a skill for simple, concrete tasks you can " +
    "just carry out directly.\n" +
    lines
  );
}

// Memoize: enumerate once per process (skills rarely change mid-session).
let cached: Promise<SkillEntry[]> | null = null;
export function getSkillsCatalog(): Promise<SkillEntry[]> {
  if (!cached) cached = loadSkills();
  return cached;
}

/** The curated skill names to enable on the SDK (a context filter — unlisted skills,
 *  including all plugin process skills like superpowers:*, are hidden from the model). */
export async function getSkillNames(): Promise<string[]> {
  return (await getSkillsCatalog()).map((s) => s.name);
}
