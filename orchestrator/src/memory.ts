import { readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { quickComplete } from "./quick.js";
import { cloudComplete } from "./runner.js";
import * as fallback from "./fallback.js";

export type Turn = { role: "user" | "assistant"; content: string };

// ── Short-term buffer (the context-retention fix) ─────────────────────────────
const buffer: Turn[] = [];
let turnsSinceConsolidate = 0;

const hubPath = () => join(config.memoryDir, "MEMORY.md");
const spokesDir = () => join(config.memoryDir, "long-term");
const sessionPath = () => join(config.memoryDir, "short-term", "session.md");
const candidatesPath = () => join(config.memoryDir, "short-term", "candidates.md");

const read = (p: string): string => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const spokeCategories = (): string[] => {
  try { return readdirSync(spokesDir()).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")); }
  catch { return []; }
};

export function recentTurns(n = config.shortTermTurns): Turn[] {
  return buffer.slice(-n);
}

export function appendTurn(user: string, assistant: string): void {
  buffer.push({ role: "user", content: user }, { role: "assistant", content: assistant });
  const md = "# Short-term session buffer\n\n" +
    recentTurns().map((t) => `**${t.role}:** ${t.content}`).join("\n\n") + "\n";
  try { writeFileSync(sessionPath(), md); } catch { /* non-fatal */ }
}

export function clearShortTerm(): void {
  buffer.length = 0;
  try { writeFileSync(sessionPath(), "# Short-term session buffer\n"); } catch { /* non-fatal */ }
}

// ── Long-term retrieval (hub → relevant spokes) ───────────────────────────────
export async function retrieve(query: string): Promise<string> {
  const cats = spokeCategories();
  if (cats.length === 0 || !read(hubPath())) return "";
  const reply = await quickComplete(
    `Categories: ${cats.join(", ")}.\nThe user said: "${query}"\nWhich categories are relevant to answer well or stay consistent? Reply with only the relevant category names (comma-separated), or "none".`,
    'You select relevant memory categories. Output only category names or "none".',
    24,
  ).catch(() => "");
  const picked = cats.filter((c) => reply.toLowerCase().includes(c));
  if (picked.length === 0) return "";
  let out = "";
  for (const c of picked) {
    const body = read(join(spokesDir(), `${c}.md`)).trim();
    if (body) out += `\n\n## Known about the user — ${c}\n${body}`;
    if (out.length > config.maxMemoryChars) break;
  }
  return out.slice(0, config.maxMemoryChars).trim();
}

// ── Curation: 2B capture (continuous, free) ───────────────────────────────────
export async function capture(): Promise<void> {
  const recent = recentTurns(4);
  if (recent.length === 0) return;
  const convo = recent.map((t) => `${t.role}: ${t.content}`).join("\n");
  const facts = await quickComplete(
    `From this exchange, extract any DURABLE facts worth remembering long-term about the user (preferences, projects, people, identity, setup). Ignore transient chit-chat and task details. One terse fact per line, or "none".\n\n${convo}`,
    'You extract durable memory facts. Be conservative. Output one fact per line or "none".',
    120,
  ).catch(() => "none");
  if (/^\s*none\s*$/i.test(facts)) return;
  const lines = facts.split("\n").map((l) => l.replace(/^[-*\d.\s]+/, "").trim()).filter(Boolean);
  if (lines.length) {
    try { appendFileSync(candidatesPath(), lines.map((l) => `- ${l}`).join("\n") + "\n"); } catch { /* non-fatal */ }
  }
}

// ── Curation: cloud consolidation (periodic, quality) ─────────────────────────
export async function maybeConsolidate(force = false): Promise<void> {
  // Cloud consolidation needs Sonnet. If the breaker is open, defer WITHOUT
  // touching the turn counter or the candidate file, so captured facts survive
  // the outage and get consolidated once the cloud is back.
  if (fallback.isOpen()) return;
  turnsSinceConsolidate++;
  const candidates = read(candidatesPath()).split("\n").filter((l) => l.trim().startsWith("-"));
  if (candidates.length === 0) return;
  if (!force && turnsSinceConsolidate < config.consolidateEvery) return;
  turnsSinceConsolidate = 0;

  const cats = spokeCategories();
  const current = cats.map((c) => `### ${c}\n${read(join(spokesDir(), `${c}.md`))}`).join("\n\n");
  const prompt =
`You are Jarvis's long-term memory curator. Existing category files: ${cats.join(", ")}.

EXISTING MEMORY:
${current}

NEW CANDIDATE FACTS:
${candidates.join("\n")}

Keep only durable facts genuinely worth remembering. Drop duplicates and anything already covered above. Assign each kept fact to the single best category (use an existing category unless a fact clearly needs a new lowercase one). Keep facts terse.
Output STRICT JSON only: {"<category>": ["fact", ...], ...}  — or {} if nothing is worth keeping.`;

  const out = await cloudComplete(prompt, "You are a careful memory curator. Output only JSON.").catch(() => "");
  let parsed: Record<string, string[]> = {};
  try {
    const m = out.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch { return; }

  let hubChanged = false;
  for (const [cat, facts] of Object.entries(parsed)) {
    if (!Array.isArray(facts) || facts.length === 0) continue;
    const file = join(spokesDir(), `${cat}.md`);
    const existing = read(file);
    const have = new Set(existing.split("\n").map((l) => l.replace(/^[-\s]+/, "").trim().toLowerCase()));
    const add = facts.filter((f) => typeof f === "string" && f.trim() && !have.has(f.trim().toLowerCase()));
    if (add.length === 0) continue;
    const header = existing.trim() ? "" : `# ${cat.charAt(0).toUpperCase() + cat.slice(1)}\n\n`;
    try { appendFileSync(file, header + add.map((f) => `- ${f}`).join("\n") + "\n"); } catch { /* non-fatal */ }
    if (!cats.includes(cat)) hubChanged = true;
  }
  try { writeFileSync(candidatesPath(), "# Candidate facts (awaiting consolidation)\n"); } catch { /* non-fatal */ }
  if (hubChanged) updateHub();
}

export async function rememberNow(text: string): Promise<void> {
  try { appendFileSync(candidatesPath(), `- ${text}\n`); } catch { /* non-fatal */ }
  await maybeConsolidate(true);
}

function updateHub(): void {
  const cats = spokeCategories();
  const lines = cats.map((c) => `- [${c}](long-term/${c}.md)`).join("\n");
  const md = `# Jarvis Long-Term Memory — Hub\n\nIndex of long-term memory categories. Retrieval reads this, picks relevant categories, and loads only those spokes.\n\n${lines}\n`;
  try { writeFileSync(hubPath(), md); } catch { /* non-fatal */ }
}
