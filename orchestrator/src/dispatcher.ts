import { AGENTS, DEFAULT_AGENT } from "./agents/index.js";
import { quickComplete } from "./quick.js";

/**
 * Addressee check: the wake word is just "Jarvis" now, which also occurs in normal
 * speech ("I'll ask Jarvis later"). Given a transcript that mentions the name, the
 * local 2B decides whether the speaker is actually talking TO the assistant vs.
 * merely mentioning it. Free + fast. Defaults to YES on error so we never go deaf.
 */
export async function isAddressed(text: string): Promise<boolean> {
  const reply = await quickComplete(
    `A speech transcript mentions an AI assistant named Jarvis. Decide if the speaker is talking TO Jarvis — i.e. giving it a command or asking it a question — versus merely mentioning the name while talking to or about another person. Reply with ONLY "YES" or "NO".\n\nTranscript: ${text}`,
    'You are an addressee classifier. Output exactly "YES" or "NO".',
    4,
  ).catch(() => "YES");
  return /\byes\b/i.test(reply);
}

/**
 * Decide which agent should handle a command.
 *
 * Policy (this is the main judgement call in Jarvis — tune it to taste):
 *   1. Fast keyword path for the common, unambiguous cases (zero latency, zero cost).
 *   2. Otherwise ask the local 2B to classify against the agent descriptions
 *      (still free, ~instant). It only has to pick a label, not reason deeply.
 *   3. Anything uncertain falls back to `dev` — the most capable agent.
 *
 * Returning the chosen agent keeps the policy in one place; the server just acts
 * on it. If you want different behaviour (e.g. always confirm before editing,
 * or route by repo state), this function is the seam to change.
 */
export async function dispatch(text: string): Promise<{ agent: string; via: string }> {
  const t = text.toLowerCase().trim();

  // 1. Keyword fast path — order matters (imperatives before questions). Widened
  //    so most utterances skip the classifier round-trip (lower latency).
  if (/\b(review|audit|check .* for (bugs|issues|security)|look for bugs)\b/.test(t))
    return { agent: "reviewer", via: "keyword" };
  if (/\b(plan|break (this|it) down|steps to|roadmap|outline (a|the)|design (a|the))\b/.test(t))
    return { agent: "planner", via: "keyword" };
  // Coder (write a file live in the editor) must beat both `desktop` ("in vscode")
  // and `dev` ("write/build/create") — it needs the verb AND an editor/live cue.
  if (/\b(write|build|create|code|implement|make)\b.*\b(in vs ?code|in the editor|live|so i can watch|while i watch|watch you (code|write|type))\b/.test(t))
    return { agent: "coder", via: "keyword" };
  // Web (open a browser/app and navigate) and desktop (control an on-screen app)
  // come BEFORE dev so their phrasing wins over dev's broad imperative match.
  if (/\b(open (youtube|chrome|google|safari|firefox|a video|the weather|a website|a tab)|search (for |youtube|the web)|on youtube|play .* on youtube|weather (in|for|report|forecast|today)|look (it|this) up online)\b/.test(t))
    return { agent: "web", via: "keyword" };
  if (/\b(in vs ?code|in chrome|in safari|in the (editor|browser|app|window)|click|double-click|scroll (up|down)|switch to|focus (the )?(window|app)|keystroke|the menu|menu bar|select all)\b/.test(t))
    return { agent: "desktop", via: "keyword" };
  if (/\b(edit|fix|refactor|implement|add|write|create|rename|delete|remove|run|build|commit|install|update|change|move|generate|make (a|the)|open the)\b/.test(t))
    return { agent: "dev", via: "keyword" };
  // Factual / conceptual questions → instant local answer.
  if (/^(what|who|when|where|why|which|how|is|are|can|could|does|do|should|tell me|give me|define|convert|calculate|spell|translate)\b/.test(t))
    return { agent: "quick", via: "keyword" };

  // 2. Local-model classification.
  const menu = Object.values(AGENTS)
    .map((a) => `- ${a.name}: ${a.description}`)
    .join("\n");
  const reply = await quickComplete(
    `Pick the single best agent for this request. Reply with ONLY the agent name.\n\nAgents:\n${menu}\n\nRequest: ${text}`,
    "You are a routing classifier. Output exactly one agent name and nothing else.",
    16,
  ).catch(() => "");

  const picked = Object.keys(AGENTS).find((name) => reply.toLowerCase().includes(name));
  return picked ? { agent: picked, via: "classifier" } : { agent: DEFAULT_AGENT, via: "fallback" };
}
