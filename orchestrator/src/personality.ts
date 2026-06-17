import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * Compose the personality markdown files into a system-prompt prefix used by
 * every agent. Editing personality/*.md changes Jarvis's character — no code change.
 * Cached after first read; restart to reload.
 */
let cached: string | null = null;

/**
 * Applies to every agent (especially the small local tier, which is prone to
 * confabulation). Don't invent facts; verify or admit uncertainty instead of
 * guessing. The orchestrator escalates uncertain local answers to tool-using
 * agents, but the instruction reinforces honest behavior everywhere.
 */
const HONESTY =
  "Accuracy over confidence: never invent file paths, APIs, command names, numbers, or facts. " +
  "If you are not sure, say so plainly and either look it up with your tools (web search, reading " +
  "files, running commands) or offer to — do not guess or make something up.";

export function systemBase(): string {
  if (cached !== null) return cached;
  try {
    const files = readdirSync(config.personalityDir)
      .filter((f) => f.endsWith(".md"))
      .sort(); // jarvis.md before voice.md
    cached = files
      .map((f) => readFileSync(join(config.personalityDir, f), "utf8").trim())
      .filter(Boolean)
      .join("\n\n");
  } catch {
    cached = "You are Jarvis, the user's calm, capable AI assistant. Be concise; replies are read aloud.";
  }
  cached += "\n\n" + HONESTY;
  return cached;
}
