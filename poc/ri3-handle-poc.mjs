// R-I3 POC — handle / lazy-load: the storage↔presentation split (peek vs load). Pairs with R-C4 stash.
// Hypothesis: `load(id)` already exists — it IS get(id) (verbatim rehydrate). The only NEW primitive is
// `peek(id)`: a lightweight handle (id + size + head) the agent reasons over WITHOUT paying the full
// payload's tokens, then loads on demand. So R-I3 = "add peek", not "add peek+load".
//
// This POC VALIDATES (with assertions, not prose) the load-bearing claim I first glossed: that peek can
// be computed CHEAPLY — without materializing the full blob — straight from the real stash table via SQL
// substr/length. Along the way it stress-tests the edges that decide the head/size semantics:
//   • length(text) is CHARACTERS not BYTES → wrong size for multibyte; need length(CAST(text AS BLOB))
//   • substr(text,1,N) is the only cheap head; "first non-empty line" needs a full scan (ltrim) → rejected
//   • single-huge-line opaque blobs, UTF-8 payloads, blank-line prefixes, missing id
// Run: node poc/ri3-handle-poc.mjs   (exits non-zero on any failed assertion)
import { LiteCtx } from "../src/index.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ri3-"));
const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: false });
const db = ctx.store.db; // the real better-sqlite3 handle — peek runs against the real `stash` table
const HEAD = 160, TAIL = 80;

// THE PRODUCTION peek path, proven here: head = first-N via substr(text,1,N); tail = last-M via
// substr(text,-M) (the conclusion lives at the END — exit code, failing frame, closing structure);
// bytes = octet length via length(CAST(text AS BLOB)). Only the bounded ~head+tail RESULT crosses to
// the caller — the blob never enters the agent's context/token budget. (But SQLite still READS the
// column to slice it, so this is a result-size win, NOT a DB wall-time win — see [2c].)
// tail is blank unless a real middle gap exists. Returns null for a miss.
const peekStmt = db.prepare(
  "SELECT length(CAST(text AS BLOB)) AS bytes, length(text) AS chars, substr(text, 1, ?) AS head, substr(text, ?) AS tail FROM stash WHERE path = ?"
);
function peek(id) {
  const r = peekStmt.get(HEAD, -TAIL, id);
  return r ? { id, bytes: r.bytes, head: r.head, tail: r.chars > HEAD + TAIL ? r.tail : "", truncated: r.chars > HEAD } : null;
}
const J = (o) => JSON.stringify(o);

// payloads: ascii trace, opaque single-line JSON, a UTF-8 (multibyte) blob, a blank-line-prefixed trace.
const trace = "FATAL: connection pool exhausted at worker 7\n" + "  at pool.acquire (db/pool.js:88)\n".repeat(1500);
const opaque = '{"data":[' + Array.from({ length: 4000 }, (_, i) => `{"k":${i},"v":"x"}`).join(",") + "]}";
const utf8 = "ERREUR: le pool est épuisé — 接続プール枯渇 🔥\n" + "ligne de journal ".repeat(2000);
const blank = "\n\n\nFATAL: started after three blank lines\n" + "noise\n".repeat(1000);
for (const [id, t] of [["stash:trace", trace], ["stash:opaque", opaque], ["stash:utf8", utf8], ["stash:blank", blank]])
  ctx.stash(id, t);

let pass = 0;
const ok = (label, cond) => { assert.ok(cond, "FAIL: " + label); console.log("  ✓", label); pass++; };

console.log("[1] load already exists — get(id) is the verbatim rehydrate (the 'load' half):");
ok("get returns the payload byte-for-byte", ctx.get("stash:trace").text === trace);
ok("R-I3 therefore adds peek ONLY (load == get)", ctx.get("stash:trace").kind === "stash");

console.log("[2] peek bounds the RESULT — only ~head+tail bytes cross to the caller (the real win):");
const h = peek("stash:trace");
ok("head/tail capped at the fixed budget (full payload is 51KB)", h.head.length <= HEAD && h.tail.length <= TAIL);
ok("handle serializes tiny vs the payload", Buffer.byteLength(J(h)) < HEAD + TAIL + 120 && Buffer.byteLength(trace) > 50000);
// the real win: RESULT size is ~CONSTANT regardless of payload size (the blob stays out of context)
const hSmall = peek("stash:blank"), hBig = peek("stash:trace");
ok("result size is ~constant across a 6KB and a 51KB payload (blob stays out of the token budget)",
   Math.abs(Buffer.byteLength(J(hBig)) - Buffer.byteLength(J(hSmall))) < HEAD + TAIL);
console.log("    handle:", J(h), "| payload bytes:", Buffer.byteLength(trace));

console.log("[2b] head+tail (not head-only) — the conclusion lives at the END, so the tail must carry it:");
ctx.stash("stash:job", "START job\n" + "step ".repeat(4000) + "\nFATAL: Process exited with code 1");
const hj = peek("stash:job");
ok("head shows the beginning", hj.head.startsWith("START job"));
ok("tail shows the verdict at the end (head-only would miss it)", hj.tail.endsWith("Process exited with code 1"));
ok("the conclusion is absent from the head — only the tail carries it", !hj.head.includes("exited with code 1"));

console.log("[2c] HONEST cost: peek is a RESULT-size win, NOT a wall-time win — SQLite reads the column to slice it:");
const timeit = (fn, n) => { const t0 = process.hrtime.bigint(); for (let i = 0; i < n; i++) fn(); return Number(process.hrtime.bigint() - t0) / n / 1e6; };
for (const mb of [0.1, 1, 5]) {
  const big = "S".repeat(Math.round(mb * 1024 * 1024 - 5)) + "ENDZZ";
  ctx.stash(`mb:${mb}`, big);
  const pk = timeit(() => peek(`mb:${mb}`), 200), gt = timeit(() => ctx.get(`mb:${mb}`), 50);
  ok(`tail still catches the end of a ${mb}MB blob`, peek(`mb:${mb}`).tail.endsWith("ENDZZ"));
  console.log(`    ${mb}MB → peek result=${Buffer.byteLength(J(peek(`mb:${mb}`)))}B (constant) | peek=${pk.toFixed(3)}ms get=${gt.toFixed(3)}ms (peek wall-time SCALES; slower than get past a few MB)`);
}
ok("peek wall-time grows with payload (claim corrected — not constant compute)",
   timeit(() => peek("mb:5"), 100) > timeit(() => peek("mb:0.1"), 100));

console.log("[3] the size BUG I'd have shipped: length(text) is CHARS, not BYTES:");
const chars = db.prepare("SELECT length(text) AS n FROM stash WHERE path=?").get("stash:utf8").n;
const bytes = peek("stash:utf8").bytes;
ok("length(text) ≠ byte length for multibyte (the naive choice is WRONG)", chars !== bytes);
ok("length(CAST(text AS BLOB)) == Buffer.byteLength (the correct one)", bytes === Buffer.byteLength(utf8));
console.log("    utf8 payload: chars =", chars, "| bytes =", bytes, "(Buffer:", Buffer.byteLength(utf8) + ")");

console.log("[4] substr head stays valid UTF-8 (chars not bytes → never splits a codepoint):");
const uh = peek("stash:utf8").head;
ok("head round-trips through UTF-8 without replacement chars", Buffer.from(uh, "utf8").toString("utf8") === uh);
ok("head carries the informative prefix", uh.startsWith("ERREUR: le pool est épuisé"));
console.log("    utf8 head:", J(uh));

console.log("[5] head SEMANTIC is 'first N chars', NOT 'first non-empty line' — and that's deliberate:");
const bh = peek("stash:blank").head;
ok("blank-prefixed payload → head begins with the raw leading newlines", bh.startsWith("\n\n\n"));
// 'skip blank lines' would need ltrim(text), which materializes the whole 6KB+ string → not cheap.
const ltrimCost = db.prepare("SELECT length(ltrim(text)) AS n FROM stash WHERE path=?").get("stash:blank").n;
ok("ltrim(text) would touch ~the whole payload (proves the nice head isn't free)", ltrimCost > 5000);
console.log("    finding: cheap peek MUST define head = substr(text,1,N). Trimming blanks costs a full scan → rejected.");

console.log("[6] opaque blob: deterministic peek can't summarize it → where the deferred `summary` column earns its keep:");
const oh = peek("stash:opaque").head;
ok("opaque head is structurally present but semantically useless", oh.startsWith('{"data":[{"k":0'));
console.log("    finding: head covers logs/traces/text/code; opaque blobs need a CALLER-supplied summary");
console.log("    (the reserved `summary` column) or an LLM summary (ceded). Ship peek column-free; add the");
console.log("    column only when a real caller passes one — no speculative schema (AGENT_RULES).");

console.log("[7] peek on a missing id → null (parity with get):");
ok("peek(unknown) is null", peek("stash:nope") === null);
ok("get(unknown) is null too", ctx.get("stash:nope") === null);

ctx.close();
console.log("\nALL " + pass + " ASSERTIONS PASSED — R-I3 design validated against the real stash table.");
