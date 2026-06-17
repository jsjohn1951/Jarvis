# Live coding in VS Code

Jarvis can write a file **live in your VS Code editor** — you watch the `coder` agent
type it out token-by-token, the way text appears in a ChatGPT/Gemini chat — instead of
the file silently appearing on disk (the `dev` agent's behaviour).

Two pieces make this work:

1. The **`coder` agent** ([orchestrator/src/agents/index.ts](../orchestrator/src/agents/index.ts)) —
   a hybrid agent with **no `Write`/`Edit` tool**. It explores read-only, then emits the
   file body as response *text* so the model's actual tokens can be streamed.
2. The **Jarvis Live Coder extension** ([editor-extension/](../editor-extension/)) — connects
   to the orchestrator and types the streamed tokens into the active editor.

## Flow

```
 model tokens         orchestrator                          VS Code
 ───────────►  runHybrid(partial:true)                      ┌────────────────┐
               │  yields {type:"text",delta} per token      │ Jarvis extension│
               ▼                                            │  ws client      │
        code-stream.ts (splitter)                           │ editor.edit(    │
          ├─ narration ──► app HUD (:7777) + TTS            │   insert(delta))│
          └─ code ───────► editor client (:7777) ──ws──────►│ + save()        │
                                                            └────────────────┘
```

- `runHybrid(..., { partial: true })` sets `includePartialMessages`, so text arrives as
  per-token `stream_event` deltas ([runner.ts](../orchestrator/src/runner.ts)).
- [code-stream.ts](../orchestrator/src/code-stream.ts) is the splitter: text outside the
  sentinels is **narration** (spoken + shown in the HUD); text inside is **code** (typed
  into the editor). It buffers across token boundaries so a marker split between two
  tokens is never leaked.
- [vscode-bridge.ts](../orchestrator/src/vscode-bridge.ts) forwards `editor_*` messages to
  the registered editor socket. The extension does the typing.

## The coder agent's output contract

```
One short sentence summarising what's being written (this is spoken aloud).
<<<JARVIS_WRITE path="src/foo.ts">>>
...the complete file body, no markdown fences, typed verbatim into the editor...
<<<JARVIS_END>>>
```

ASCII triple-angle markers are used (not markdown fences, not `«»`): the full open token
never occurs in real source, and the model emits ASCII reliably.

## Editor protocol (orchestrator → extension)

The extension connects to `ws://127.0.0.1:7777` and sends
`{type:"hello", role:"editor", token}`. The orchestrator gates the editor role on a
shared secret (see **Security** below) — a bad/absent token closes the socket. Once
registered, the orchestrator sends it:

| Message | Effect |
|---------|--------|
| `editor_open {path}` | Open (create if needed) and focus the file. |
| `editor_stream_begin {id, path}` | Open the file, clear it, start the typing loop. |
| `editor_stream_delta {id, delta}` | Queue tokens; a ~24 ms flush loop types them in. |
| `editor_stream_end {id, save}` | Drain the queue, then save the document. |
| `editor_stream_abort {id}` | Delete the typed range (provider fell back mid-stream). |
| `editor_command {id, command, args}` | Runs an **allow-listed** `vscode.commands.executeCommand(...)`; other command ids are dropped. |

All inserts share one undo step, so a single Ctrl/Cmd+Z removes the generated file.

## Security

The `:7777` socket is reachable by any local process, so the trust boundary matters:

- **Editor role is authenticated.** The orchestrator generates a random secret on first
  run and persists it `0600` at `~/.jarvis/editor-token` (`config.editorTokenFile`); the
  extension reads it (or a `jarvis.sharedSecret` setting) and sends it in `hello`. A
  mismatched/absent token closes the connection, so a random local process can't register
  as the editor and siphon the code stream.
- **Coder file paths are validated.** The model chooses the write path, so it's untrusted:
  [paths.ts](../orchestrator/src/paths.ts) `safeResolveInBase` refuses anything resolving
  outside the agent's repo (`..`, absolute paths, NUL). A refused path is surfaced to the
  user and the block is dropped.
- **`editor_command` is allow-listed.** `executeCommand` with an arbitrary id is an RCE
  sink (e.g. terminal send-sequence); only a small safe set (save, format, reveal) is
  honoured.

## Triggering it

Say/type something with a write verb **and** an editor/live cue — e.g. *"Jarvis, write a
FizzBuzz in TypeScript in VS Code"*, *"build the parser live"*, *"let me watch you write
it"*. The dispatcher's coder keyword rule ([dispatcher.ts](../orchestrator/src/dispatcher.ts))
beats both the `desktop` ("in vscode") and `dev` ("write") rules. Plain coding requests
without that cue still go to the silent `dev` agent.

## Graceful degradation

If no editor is connected (VS Code closed or extension not installed), the coder route
shows the code in the Jarvis HUD transcript and writes the file to disk on completion,
then speaks a note that VS Code wasn't reachable.

## Scope (v1)

Whole-file create/rewrite only (open → clear → stream → save). Surgical in-place edits of
existing files stay on the `dev` agent; ranged streamed edits are a later addition.

## Build / install the extension

See [editor-extension/README.md](../editor-extension/README.md). In short:
`cd editor-extension && npm install && npm run package`, then
`code --install-extension jarvis-editor-0.1.0.vsix` and reload.
