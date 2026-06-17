/**
 * Token-stream splitter for the `coder` agent.
 *
 * The coder agent emits one short spoken summary, then the file body wrapped in
 * sentinels:
 *
 *     ...one-line summary the user hears...
 *     <<<JARVIS_WRITE path="src/foo.ts">>>
 *     ...the whole file body, streamed token by token...
 *     <<<JARVIS_END>>>
 *
 * `push(delta)` is fed each raw text token from the model. Text outside the
 * sentinels is narration (→ app HUD + spoken result); text inside is code (→ the
 * VS Code editor, typed live). Because a sentinel can be split across two tokens
 * (e.g. "<<<JARVIS_W" then "RITE ..."), we buffer the tail that could still be the
 * start of a sentinel and never emit a half-marker as narration or code.
 *
 * ASCII triple-angle markers (not markdown fences, not guillemets) are used because
 * the full open token never occurs in real source, and the model emits ASCII far
 * more reliably than `«»`.
 */

const OPEN_RE = /<<<JARVIS_WRITE\s+path="([^"]*)">>>/;
const OPEN_PREFIX = "<<<JARVIS_WRITE"; // fixed, detectable start of an open marker
const CLOSE = "<<<JARVIS_END>>>";

export interface CodeStreamHandlers {
  /** Assistant text outside any write block (spoken + shown in the HUD). */
  onNarration(delta: string): void;
  /** A write block opened for `path` — open/clear the editor and start typing. */
  onCodeBegin(path: string): void;
  /** A chunk of the file body — type it into the editor. */
  onCodeDelta(delta: string): void;
  /** The write block closed — save the file. */
  onCodeEnd(): void;
}

/** Length of the longest suffix of `s` that is also a prefix of `marker`. */
function suffixPrefixLen(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length);
  for (let len = max; len > 0; len--) {
    if (s.slice(s.length - len) === marker.slice(0, len)) return len;
  }
  return 0;
}

export class CodeStreamRouter {
  private buffer = "";
  private inCode = false;
  private opened = false; // a write block was opened (so flush knows to close it)

  constructor(private readonly h: CodeStreamHandlers) {}

  /** True while inside a write block (code is going to the editor, not the HUD). */
  get streaming(): boolean {
    return this.inCode;
  }

  push(delta: string): void {
    this.buffer += delta;
    // Keep draining: one push may contain a full open marker *and* code, etc.
    for (;;) {
      if (!this.inCode) {
        const m = OPEN_RE.exec(this.buffer);
        if (m) {
          if (m.index > 0) this.h.onNarration(this.buffer.slice(0, m.index));
          this.h.onCodeBegin(m[1]);
          this.inCode = true;
          this.opened = true;
          this.buffer = this.buffer.slice(m.index + m[0].length);
          continue; // there may already be code in the remaining buffer
        }
        // No complete open marker. Hold back anything that could be a forming one.
        const hold = this.holdNarration();
        if (hold > 0) this.h.onNarration(this.buffer.slice(0, this.buffer.length - hold));
        else if (this.buffer) this.h.onNarration(this.buffer);
        this.buffer = hold > 0 ? this.buffer.slice(this.buffer.length - hold) : "";
        return;
      } else {
        const k = this.buffer.indexOf(CLOSE);
        if (k >= 0) {
          if (k > 0) this.h.onCodeDelta(this.buffer.slice(0, k));
          this.h.onCodeEnd();
          this.inCode = false;
          this.opened = false;
          this.buffer = this.buffer.slice(k + CLOSE.length);
          continue; // narration may follow the closed block
        }
        // No close yet. Emit all but a possible partial CLOSE at the tail.
        const hold = suffixPrefixLen(this.buffer, CLOSE);
        if (this.buffer.length - hold > 0) this.h.onCodeDelta(this.buffer.slice(0, this.buffer.length - hold));
        this.buffer = hold > 0 ? this.buffer.slice(this.buffer.length - hold) : "";
        return;
      }
    }
  }

  /** End of stream: emit whatever is held and close an unterminated write block. */
  flush(): void {
    if (this.inCode) {
      if (this.buffer) this.h.onCodeDelta(this.buffer);
      this.h.onCodeEnd(); // model ended without a close marker — still save what we got
      this.inCode = false;
      this.opened = false;
    } else if (this.buffer) {
      this.h.onNarration(this.buffer);
    }
    this.buffer = "";
  }

  /**
   * In narration mode, how many trailing chars to hold back because they might be
   * the start of an open marker: either the full fixed prefix has begun, or a
   * suffix of the buffer is a prefix of that fixed prefix.
   */
  private holdNarration(): number {
    const j = this.buffer.indexOf(OPEN_PREFIX);
    if (j >= 0) return this.buffer.length - j; // marker already forming — hold from there
    return suffixPrefixLen(this.buffer, OPEN_PREFIX);
  }
}

export const SENTINELS = { OPEN_RE, OPEN_PREFIX, CLOSE };
