import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WebSocket } from "ws";
import { runAct, type ActRequest, type ActResult } from "./actuation.js";

/**
 * Build the in-process "jarvis" MCP server. Each tool forwards to the desktop app
 * (which actually performs the action — it holds the Automation / Screen Recording
 * grants) and returns the result. Rebuilt per request.
 *
 * `getActuator` is resolved PER TOOL CALL, not at build time: a prompt from the
 * phone must actuate on the connected Mac app, and a desktop app that reconnects
 * mid-turn should be picked up by the next call. No desktop app connected → a
 * graceful tool error the agent can narrate (never a mobile socket, which cannot
 * run AppleScript/Terminal/screen capture).
 *
 * Exposed tool ids (use these in an agent's `allowedTools`):
 *   mcp__jarvis__open_target, mcp__jarvis__run_applescript, mcp__jarvis__capture_screen,
 *   mcp__jarvis__run_terminal
 */
/** Per-call actuator resolution: no desktop app → graceful error instead of a
 *  30s timeout (or, worse, an act request sent to a phone). Exported for tests. */
export function makeAct(getActuator: () => WebSocket | undefined) {
  return (req: ActRequest, timeoutMs?: number): Promise<ActResult> => {
    const ws = getActuator();
    if (!ws) return Promise.resolve({ ok: false, error: "no desktop Jarvis app connected to perform this action" });
    return runAct(ws, req, timeoutMs);
  };
}

export function buildJarvisTools(getActuator: () => WebSocket | undefined): McpServerConfig {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
  const act = makeAct(getActuator);

  return createSdkMcpServer({
    name: "jarvis",
    version: "1.0.0",
    tools: [
      tool(
        "open_target",
        "Open a macOS app and/or a URL (e.g. open Google Chrome at a YouTube search URL). Provide app, url, or both.",
        {
          app: z.string().optional().describe('Application name, e.g. "Google Chrome", "Safari".'),
          url: z.string().optional().describe("URL to open, e.g. https://www.youtube.com/results?search_query=tornado"),
        },
        async ({ app, url }) => {
          const r = await act({ action: "open", app, url });
          return text(r.ok ? (r.output ?? "opened") : `error: ${r.error ?? "open failed"}`);
        },
      ),
      tool(
        "run_applescript",
        "Run AppleScript on the user's Mac to control on-screen apps — System Events keystrokes, menu clicks, window focus. Use for UI actions you cannot accomplish by editing a file. Returns script output or an error.",
        { script: z.string().describe("AppleScript source to execute.") },
        async ({ script }) => {
          const r = await act({ action: "applescript", script });
          return text(r.ok ? (r.output ?? "ok") : `error: ${r.error ?? "applescript failed"}`);
        },
      ),
      tool(
        "run_terminal",
        "Run a shell command in the user's REAL Terminal.app — it appears and runs in a visible Terminal window, and the captured output (stdout+stderr) is returned. Use this for ALL shell commands the user asks you to run, instead of the headless Bash tool, so they can see it happen. Provide the command (and optionally a working directory).",
        {
          command: z.string().describe("The shell command to run, e.g. 'npm test' or 'ls -la'."),
          cwd: z.string().optional().describe("Working directory to cd into first (absolute path)."),
        },
        async ({ command, cwd }) => {
          // Longer timeout than UI actions: a command may take a while. The app reports
          // back partial output + 'still running' if it exceeds its own window.
          const r = await act({ action: "terminal", command, cwd }, 180_000);
          if (r.ok) return text(r.output && r.output.length ? r.output : "(command finished with no output)");
          return text(`error: ${r.error ?? "terminal command failed"}${r.output ? "\n" + r.output : ""}`);
        },
      ),
      tool(
        "capture_screen",
        "Capture the current screen as an image so you can see the foreground app before or after acting.",
        {},
        async () => {
          const r = await act({ action: "capture" });
          if (r.ok && r.image) {
            return { content: [{ type: "image" as const, data: r.image, mimeType: "image/png" }] };
          }
          return text(`error: ${r.error ?? "capture failed"}`);
        },
      ),
    ],
  });
}
