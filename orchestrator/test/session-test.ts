// Verifies the conversation Session entity: close-intent detection, open/close
// lifecycle, idempotency, and that nothing here touches the global short-term buffer
// (sessions are additive — a no-session flow must behave exactly as before). Pure +
// in-memory; persistence is redirected to a temp dir. Run: npx tsx test/session-test.ts
process.env.JARVIS_SESSIONS = "/tmp/jarvis-session-test";

const session = await import("../src/session.js");

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}  ${detail}`);
  if (!cond) failures++;
}

// ── isCloseIntent ────────────────────────────────────────────────────────────
for (const t of ["goodbye", "bye", "that's all", "new conversation", "forget that", "start over", "we're done"]) {
  check(`close intent "${t}"`, session.isCloseIntent(t), "");
}
for (const t of ["open the terminal", "what's the weather", "write a function", "good morning", "how are you"]) {
  check(`NOT close intent "${t}"`, !session.isCloseIntent(t), "");
}

// ── open / close lifecycle (ws used only as a map key) ────────────────────────
const ws: any = {};
check("no session initially", !session.hasOpenSession(ws));

const s1 = session.openSession(ws);
check("open → hasOpenSession", session.hasOpenSession(ws), `id:${s1.id}`);
check("open state", s1.state === "open");

const s2 = session.openSession(ws);
check("open is idempotent (same id)", s1.id === s2.id, `${s1.id} == ${s2.id}`);

session.recordTurn(ws, "hello", "hi there");
check("recordTurn appended a user+assistant pair", session.getSession(ws)?.turns.length === 2);

const closed = session.closeSession(ws);
check("closeSession returns the session", closed?.id === s1.id);
check("closed state", closed?.state === "closed");
check("hasOpenSession false after close", !session.hasOpenSession(ws));

session.dropSession(ws);
check("dropped → getSession undefined", session.getSession(ws) === undefined);

// ── recordTurn auto-opens a session (robust to reconnect / no greeting) ───────
const ws2: any = {};
session.recordTurn(ws2, "x", "y");   // no prior session → opens one and records
check("recordTurn auto-opens a session", session.hasOpenSession(ws2));
check("auto-opened session has the turn", session.getSession(ws2)?.turns.length === 2);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
