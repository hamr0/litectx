// Slice 5a integration tests — recentActivity(), "what was I working on" (§14 #4 view #3). Two
// layers: (1) store-level over hand-stamped `chunk_edits` rows, so windowing / recency order /
// grouping / limit are deterministic without depending on wall-clock spacing between index passes;
// (2) end-to-end through LiteCtx for the edit-DETECTION contract — cold builds record nothing, an
// incremental pass records new/modified chunks at symbol grain, force never spams, and the read is
// isolated from the recall demand log. Behavior, not implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, Store } from "../src/index.js";

// monotonic mtime (same approach as incremental.test.js) so change detection never rides the
// filesystem's timestamp resolution — every write forces a re-read.
let clock = 1_700_000_000;
/** @param {string} root @param {string} rel @param {string} body */
function write(root, rel, body) {
  const full = join(root, rel);
  writeFileSync(full, body);
  clock += 10;
  utimesSync(full, clock, clock);
}

/** A repo with two real function chunks per file (so chunk-grain detection has symbols to bind). */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-recent-"));
  mkdirSync(join(root, "src"), { recursive: true });
  write(root, "src/auth.js", "export function alpha(x){ return x + 1; }\n\nexport function beta(y){ return y * 2; }\n");
  write(root, "src/mailer.js", "export function gamma(z){ return z - 3; }\n");
  return root;
}

// ---- store layer: deterministic windowing / order / grouping / limit ----

test("recentActivity windows, groups per chunk, orders by recency, and caps to limit", () => {
  const s = new Store(":memory:");
  const ins = s.db.prepare("INSERT INTO chunk_edits(path, symbol, kind, ts) VALUES (?, ?, 'code', ?)");
  ins.run("a.js", "alpha", 100); // alpha edited twice → grouped, edits = 2, lastEditedAt = 300
  ins.run("a.js", "alpha", 300);
  ins.run("a.js", "beta", 200);
  ins.run("b.js", "delta", 50); // outside a [100, ∞) window

  const all = s.recentActivity({ since: 0, limit: 10 });
  assert.deepEqual(
    all.map((r) => ({ id: r.id, symbol: r.symbol, edits: r.edits, last: r.lastEditedAt })),
    [
      { id: "a.js", symbol: "alpha", edits: 2, last: 300 }, // newest first
      { id: "a.js", symbol: "beta", edits: 1, last: 200 },
      { id: "b.js", symbol: "delta", edits: 1, last: 50 },
    ]
  );

  // window floor excludes the old edit; limit caps the rows
  assert.deepEqual(s.recentActivity({ since: 100, limit: 10 }).map((r) => r.symbol), ["alpha", "beta"]);
  assert.deepEqual(s.recentActivity({ since: 0, limit: 1 }).map((r) => r.symbol), ["alpha"]);
  s.close();
});

test("anonymous chunks collapse to one per-file row; edits counts passes, not chunks", () => {
  const s = new Store(":memory:");
  const ins = s.db.prepare("INSERT INTO chunk_edits(path, symbol, kind, ts) VALUES (?, NULL, 'code', ?)");
  // three nameless chunks changed in ONE pass (same ts), then one more in a second pass
  ins.run("t.js", 100);
  ins.run("t.js", 100);
  ins.run("t.js", 100);
  ins.run("t.js", 200);
  const rows = s.recentActivity({ since: 0, limit: 10 });
  assert.equal(rows.length, 1, "all null-symbol chunks of a file collapse to one row");
  assert.equal(rows[0].symbol, null);
  assert.equal(rows[0].edits, 2, "two distinct passes, not four chunk rows");
  assert.equal(rows[0].lastEditedAt, 200);
  s.close();
});

// ---- end-to-end through LiteCtx: the edit-detection contract ----

test("a cold first index records no activity (loading is not editing)", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  assert.deepEqual(ctx.recentActivity({ since: 0 }), []);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("an incremental edit is recorded at chunk grain — only the changed function, not its neighbour", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  // change ONLY beta's body; alpha's text is byte-identical across the pass
  write(root, "src/auth.js", "export function alpha(x){ return x + 1; }\n\nexport function beta(y){ return y * 99; }\n");
  await ctx.index();

  const rows = ctx.recentActivity({ since: 0 });
  assert.deepEqual(rows.map((r) => r.symbol), ["beta"], "alpha was untouched → not recorded");
  assert.equal(rows[0].id, "src/auth.js");
  assert.equal(rows[0].kind, "code");
  assert.equal(rows[0].edits, 1);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a newly added chunk is recorded; pre-existing untouched chunks are not", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  // append a third function; alpha + beta bodies are unchanged
  write(root, "src/auth.js", "export function alpha(x){ return x + 1; }\n\nexport function beta(y){ return y * 2; }\n\nexport function omega(){ return 0; }\n");
  await ctx.index();

  const symbols = ctx.recentActivity({ since: 0 }).map((r) => r.symbol);
  assert.deepEqual(symbols, ["omega"], "only the new chunk is an edit");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a force rebuild records nothing new — even after real edits exist", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  write(root, "src/mailer.js", "export function gamma(z){ return z - 999; }\n");
  await ctx.index(); // one real edit recorded
  const before = /** @type {{ n: number }} */ (ctx.store.db.prepare("SELECT count(*) AS n FROM chunk_edits").get()).n;
  assert.equal(before, 1);

  await ctx.index({ force: true }); // mass re-insert must not spam the edit log
  const after = /** @type {{ n: number }} */ (ctx.store.db.prepare("SELECT count(*) AS n FROM chunk_edits").get()).n;
  assert.equal(after, before, "force is loading, not editing");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("recentActivity is isolated from the recall demand log — it neither reads nor writes it", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  write(root, "src/auth.js", "export function alpha(x){ return x + 7; }\n\nexport function beta(y){ return y * 2; }\n");
  await ctx.index();

  ctx.recentActivity({ since: 0 }); // a pure read over chunk_edits
  const demand = /** @type {{ n: number }} */ (ctx.store.db.prepare("SELECT count(*) AS n FROM recall_log").get()).n;
  assert.equal(demand, 0, "the witnessed-edit view must not be a demand signal (no recall_log writes)");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("the default window is 7 days — older edits fall out, recent ones stay", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  write(root, "src/mailer.js", "export function gamma(z){ return z - 1; }\n");
  await ctx.index();
  // backdate the recorded edit to 8 days ago: it leaves the default window but a wider one still sees it
  const eightDaysAgo = Date.now() - 8 * 86_400_000;
  ctx.store.db.prepare("UPDATE chunk_edits SET ts = ?").run(eightDaysAgo);
  assert.deepEqual(ctx.recentActivity(), [], "default 7-day window excludes the 8-day-old edit");
  assert.equal(ctx.recentActivity({ days: 30 }).length, 1, "a 30-day window still includes it");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
