import * as vscode from "vscode";
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Jarvis Live Coder — connects to the Jarvis orchestrator and types code into the
 * active editor as the model produces it.
 *
 * The orchestrator pushes a token stream as `editor_stream_*` messages; we queue the
 * deltas and drain them on a short flush loop into a single `editor.edit()` per tick,
 * which gives a smooth ChatGPT-style typing effect without stuttering behind a fast
 * model. All inserts share one undo step so Ctrl+Z (or an `abort`) removes the whole
 * generated file at once.
 */

let ws: WebSocket | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel;

// ── Active typing stream ─────────────────────────────────────────────────────
interface Stream {
  id: string;
  editor: vscode.TextEditor;
  pos: vscode.Position; // where the next chunk is inserted
  start: vscode.Position; // where this stream began typing (for abort)
  queue: string;
  timer: NodeJS.Timeout;
  busy: boolean;
  done: boolean; // end requested; save once the queue drains
}
let stream: Stream | undefined;

/** New position after inserting `text` starting at `pos`. */
function advance(pos: vscode.Position, text: string): vscode.Position {
  const nl = text.lastIndexOf("\n");
  if (nl < 0) return pos.translate(0, text.length);
  const lines = text.split("\n").length - 1;
  return new vscode.Position(pos.line + lines, text.length - nl - 1);
}

async function openFile(path: string): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.file(path);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await vscode.workspace.fs.writeFile(uri, new Uint8Array()); // create empty
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(doc, { preview: false });
}

async function beginStream(id: string, path: string): Promise<void> {
  await endActiveStreamImmediately(); // safety: never two at once
  const editor = await openFile(path);
  // Whole-file rewrite: clear any existing contents first.
  const doc = editor.document;
  if (doc.getText().length > 0) {
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    await editor.edit((b) => b.delete(full), { undoStopBefore: true, undoStopAfter: false });
  }
  const origin = new vscode.Position(0, 0);
  const s: Stream = {
    id,
    editor,
    pos: origin,
    start: origin,
    queue: "",
    busy: false,
    done: false,
    timer: setInterval(() => void tick(), typeIntervalMs()),
  };
  stream = s;
}

async function tick(): Promise<void> {
  const s = stream;
  if (!s || s.busy) return;
  if (s.queue.length === 0) {
    if (s.done) await finish(s, /*save*/ true);
    return;
  }
  s.busy = true;
  const chunk = s.queue;
  s.queue = "";
  try {
    await s.editor.edit((b) => b.insert(s.pos, chunk), { undoStopBefore: false, undoStopAfter: false });
    s.pos = advance(s.pos, chunk);
    s.editor.revealRange(new vscode.Range(s.pos, s.pos), vscode.TextEditorRevealType.Default);
  } catch (e) {
    output.appendLine(`insert failed: ${e}`);
  } finally {
    s.busy = false;
  }
}

async function finish(s: Stream, save: boolean): Promise<void> {
  clearInterval(s.timer);
  if (stream === s) stream = undefined;
  if (save) await s.editor.document.save();
}

async function abortStream(id: string): Promise<void> {
  const s = stream;
  if (!s || s.id !== id) return;
  clearInterval(s.timer);
  stream = undefined;
  // Remove everything this stream typed (the partial, abandoned file body).
  const range = new vscode.Range(s.start, s.pos);
  try {
    await s.editor.edit((b) => b.delete(range), { undoStopBefore: false, undoStopAfter: false });
  } catch (e) {
    output.appendLine(`abort delete failed: ${e}`);
  }
}

/** Drop any in-flight stream without saving (used when a new one begins). */
async function endActiveStreamImmediately(): Promise<void> {
  if (stream) {
    clearInterval(stream.timer);
    stream = undefined;
  }
}

function typeIntervalMs(): number {
  return vscode.workspace.getConfiguration("jarvis").get<number>("typeIntervalMs", 24);
}

// Only a small, safe set of editor commands may be driven remotely. Passing an
// arbitrary command id to executeCommand is an RCE sink (e.g. workbench.action.
// terminal.sendSequence, extension installs), so everything else is dropped.
const ALLOWED_COMMANDS = new Set<string>([
  "workbench.action.files.save",
  "editor.action.formatDocument",
  "revealLine",
  "workbench.action.navigateToLastEditLocation",
]);

// ── Message handling ─────────────────────────────────────────────────────────
async function handle(msg: any): Promise<void> {
  switch (msg.type) {
    case "editor_open":
      await openFile(msg.path);
      break;
    case "editor_stream_begin":
      await beginStream(msg.id, msg.path);
      break;
    case "editor_stream_delta":
      if (stream && stream.id === msg.id) stream.queue += msg.delta;
      break;
    case "editor_stream_end":
      // Mark done; the flush loop saves once the queue has fully drained.
      if (stream && stream.id === msg.id) stream.done = true;
      break;
    case "editor_stream_abort":
      await abortStream(msg.id);
      break;
    case "editor_command":
      if (typeof msg.command !== "string" || !ALLOWED_COMMANDS.has(msg.command)) {
        output.appendLine(`refused editor_command: ${msg.command}`);
        break;
      }
      await vscode.commands.executeCommand(msg.command, ...(Array.isArray(msg.args) ? msg.args : []));
      break;
  }
}

// ── Connection ───────────────────────────────────────────────────────────────
function url(): string {
  return vscode.workspace.getConfiguration("jarvis").get<string>("orchestratorUrl", "ws://127.0.0.1:7777");
}

/**
 * The shared secret that authorises the editor role. Prefer an explicit
 * `jarvis.sharedSecret` setting; otherwise read the token the orchestrator persists
 * 0600 at ~/.jarvis/editor-token (override the path with `jarvis.tokenFile`).
 */
function token(): string {
  const cfg = vscode.workspace.getConfiguration("jarvis");
  const explicit = cfg.get<string>("sharedSecret", "");
  if (explicit) return explicit;
  const file = cfg.get<string>("tokenFile", "") || join(homedir(), ".jarvis", "editor-token");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    output.appendLine(`no editor token at ${file} — start the orchestrator first, then run "Jarvis: Reconnect"`);
    return "";
  }
}

function connect(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  const sock = new WebSocket(url());
  ws = sock;
  sock.on("open", () => {
    output.appendLine(`connected to ${url()}`);
    sock.send(JSON.stringify({ type: "hello", role: "editor", token: token() }));
  });
  sock.on("message", (data) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    void handle(msg).catch((e) => output.appendLine(`handle error: ${e}`));
  });
  sock.on("close", () => scheduleReconnect());
  sock.on("error", (e) => {
    output.appendLine(`socket error: ${e.message}`);
    sock.close();
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, 3000);
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Jarvis");
  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.commands.registerCommand("jarvis.reconnect", () => {
      ws?.close();
      connect();
    }),
  );
  connect();
}

export function deactivate(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (stream) clearInterval(stream.timer);
  ws?.close();
}
