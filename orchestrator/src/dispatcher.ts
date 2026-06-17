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
 * Is this utterance an approval of a parked plan ("yes, go ahead")? Used by the
 * dev/coder plan-and-confirm gate. Fast regex for the obvious cases; falls back to
 * the 2B for anything ambiguous. Defaults to NO on error so we never run code the
 * user didn't approve.
 */
export async function isAffirmation(text: string): Promise<boolean> {
  const t = text.toLowerCase().trim();
  if (/^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|proceed|go for it|sounds good|please do|let'?s go|make it so|affirmative)\b/.test(t))
    return true;
  if (/^(no|nope|nah|don'?t|stop|cancel|wait|hold on|not yet)\b/.test(t))
    return false;
  const reply = await quickComplete(
    `The assistant proposed a plan and asked the user to confirm. Does this reply APPROVE proceeding? Reply ONLY "YES" or "NO".\n\nReply: ${text}`,
    'You are an approval classifier. Output exactly "YES" or "NO".',
    4,
  ).catch(() => "NO");
  return /\byes\b/i.test(reply);
}

/**
 * Can the local 2B answer this factual question confidently from its own knowledge,
 * or should we escalate to a tool-using cloud agent (web/research) rather than let
 * it guess? Cheap self-assessment; defaults to confident on error so we don't
 * needlessly burn cloud capacity when the check itself fails.
 */
export async function answersConfidently(text: string): Promise<boolean> {
  const reply = await quickComplete(
    `Could you answer the following accurately and confidently from what you already know, WITHOUT guessing or making anything up? Reply ONLY "YES" or "NO".\n\nQuestion: ${text}`,
    'You judge your own certainty honestly. Output exactly "YES" or "NO".',
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
  // Screen capture and editor/app LAUNCHING → desktop agent. It can SEE the screen
  // (capture_screen) and drive apps (open_target / AppleScript); it must never reach
  // for a web browser to take a "screenshot" or to open VS Code. Checked before coder
  // so "open visual studio code" launches the app rather than being read as "code".
  if (/\b(screenshot|screen ?shot|capture (the |my )?screen|take a (screen|picture)|what'?s on (my |the )?screen|open (vs ?code|visual studio code|the editor|code))\b/.test(t))
    return { agent: "desktop", via: "keyword" };
  // Coder (write a whole file live in the editor) must beat `web` and `dev`. It needs
  // a write verb AND an editor/file/live cue — tested independently so the cue may come
  // before OR after the verb ("write X in VS Code" OR "in VS Code, write X"). Broadened
  // so editor coding reliably lands here, not on `dev`.
  if (/\b(write|build|create|code|implement|make|generate)\b/.test(t) &&
      /\b(vs ?code|visual studio code|the editor|in (a|the) file|a (new )?file|live|watch (you|me)|type it out|so i can (see|watch))\b/.test(t))
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
