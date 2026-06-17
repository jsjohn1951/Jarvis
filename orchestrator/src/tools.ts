import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WebSocket } from "ws";
import { runAct } from "./actuation.js";

/**
 * Build the in-process "jarvis" MCP server bound to one app WebSocket. Each tool
 * forwards to the app (which actually performs the action) and returns the result.
 * Rebuilt per request so the handlers close over the requesting connection.
 *
 * Exposed tool ids (use these in an agent's `allowedTools`):
 *   mcp__jarvis__open_target, mcp__jarvis__run_applescript, mcp__jarvis__capture_screen
 */
export function buildJarvisTools(ws: WebSocket): McpServerConfig {
  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

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
          const r = await runAct(ws, { action: "open", app, url });
          return text(r.ok ? (r.output ?? "opened") : `error: ${r.error ?? "open failed"}`);
        },
      ),
      tool(
        "run_applescript",
        "Run AppleScript on the user's Mac to control on-screen apps — System Events keystrokes, menu clicks, window focus. Use for UI actions you cannot accomplish by editing a file. Returns script output or an error.",
        { script: z.string().describe("AppleScript source to execute.") },
        async ({ script }) => {
          const r = await runAct(ws, { action: "applescript", script });
          return text(r.ok ? (r.output ?? "ok") : `error: ${r.error ?? "applescript failed"}`);
        },
      ),
      tool(
        "capture_screen",
        "Capture the current screen as an image so you can see the foreground app before or after acting.",
        {},
        async () => {
          const r = await runAct(ws, { action: "capture" });
          if (r.ok && r.image) {
            return { content: [{ type: "image" as const, data: r.image, mimeType: "image/png" }] };
          }
          return text(`error: ${r.error ?? "capture failed"}`);
        },
      ),
    ],
  });
}
