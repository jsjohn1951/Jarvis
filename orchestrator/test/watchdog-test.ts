import assert from "node:assert/strict";
import { withStallWatchdog, StallError, MaxTurnsError, isIncomplete } from "../src/runner.js";

// A fake SDK-style async iterator: yields `values` with `gapMs` between each, then
// (if `hangAfter`) goes silent forever — simulating a wedged local stream. Records
// whether the consumer closed it via return().
function fakeStream(opts: { values: any[]; gapMs: number; hangAfter: boolean }) {
  let i = 0;
  const state = { returned: false };
  const iter: AsyncIterator<any> = {
    async next() {
      if (i < opts.values.length) {
        await new Promise((r) => setTimeout(r, opts.gapMs));
        return { value: opts.values[i++], done: false };
      }
      if (opts.hangAfter) return new Promise<never>(() => {}); // never resolves
      return { value: undefined, done: true };
    },
    async return() {
      state.returned = true;
      return { value: undefined, done: true };
    },
  };
  return { iter, state };
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

// 1. A stream that emits a few values then ends passes through untouched.
{
  const { iter, state } = fakeStream({ values: [1, 2, 3], gapMs: 5, hangAfter: false });
  const got = await collect(withStallWatchdog(iter, 100, "test-model"));
  assert.deepEqual(got, [1, 2, 3], "all values should pass through");
  assert.equal(state.returned, true, "iterator should be closed on normal completion");
}

// 2. A stream that emits then HANGS trips the watchdog with StallError after stallMs,
//    and the source iterator is closed so the underlying request can be aborted.
{
  const { iter, state } = fakeStream({ values: [1], gapMs: 5, hangAfter: true });
  const start = Date.now();
  let thrown: unknown = null;
  try {
    await collect(withStallWatchdog(iter, 60, "test-model"));
  } catch (e) {
    thrown = e;
  }
  const elapsed = Date.now() - start;
  assert.ok(thrown instanceof StallError, "a hung stream should throw StallError");
  assert.equal(isIncomplete(thrown), true, "StallError counts as incomplete");
  assert.ok(elapsed >= 60 && elapsed < 250, `should trip ~stallMs after last value (was ${elapsed}ms)`);
  assert.equal(state.returned, true, "iterator must be closed on stall so the request is freed");
}

// 3. Progress RESETS the idle timer: many values spaced under the stall window never trip,
//    even though total runtime far exceeds stallMs (slowness != silence).
{
  const { iter } = fakeStream({ values: [1, 2, 3, 4, 5, 6], gapMs: 30, hangAfter: false });
  const got = await collect(withStallWatchdog(iter, 60, "test-model")); // 6×30ms=180ms > 60ms
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6], "a slow-but-progressing stream must not be killed");
}

// 4. isIncomplete distinguishes incomplete (stall/turn-limit) from genuine failures.
assert.equal(isIncomplete(new StallError("m", 1)), true);
assert.equal(isIncomplete(new MaxTurnsError("m")), true);
assert.equal(isIncomplete(new Error("boom")), false);

console.log("watchdog-test: OK");
process.exit(0);
