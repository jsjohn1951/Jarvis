import { quickComplete } from "./quick.js";

/**
 * Careful full-local fallback (used only when the cloud is unavailable).
 *
 * The local model has a small context window and limited reasoning, so handing it a
 * big task whole tends to fail. Instead we first ask it to DECOMPOSE the request into
 * a few small, independently-solvable steps, then the runner executes them
 * sequentially — each as its own short turn — so no single step has to hold the whole
 * problem in context. This is the "break big problems into small chunks solvable
 * sequentially" behavior for the cloud-down path.
 */
export async function decomposeLocal(prompt: string): Promise<string[]> {
  const reply = await quickComplete(
    "Break the user's request into the SMALLEST sensible sequence of concrete steps a coding " +
      "assistant should do one at a time. Output ONE step per line, no numbering, no commentary. " +
      "Use as few steps as possible (1 if it's already small; never more than 6).\n\n" +
      `Request: ${prompt}`,
    "You are a task decomposer. Output only the step lines.",
    256,
  ).catch(() => "");

  const steps = reply
    .split("\n")
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter((l) => l.length > 0)
    .slice(0, 6);

  // Degrade safely: if decomposition produced nothing usable, run the prompt whole.
  return steps.length ? steps : [prompt];
}

/** Frame a single decomposed step as a self-contained instruction for one local turn. */
export function stepPrompt(original: string, step: string, index: number, total: number): string {
  if (total === 1) return original;
  return (
    `Overall goal: ${original}\n\n` +
    `You are doing step ${index + 1} of ${total}: ${step}\n` +
    "Do ONLY this step now. Be concise."
  );
}
