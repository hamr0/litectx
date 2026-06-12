// POC — validate the evict() stash-cleanup SQL before wiring it into the API. Throwaway.
//
// RISKIEST BITS (what this proves, not the trivial DELETE):
//   1. by-age uses created_at correctly (deletes older, keeps newer).
//   2. by-maxCount keeps the NEWEST n, deletes the rest (the OFFSET subquery is right).
//   3. THE INVARIANT: evict touches ONLY the stash table — a written `fact` is never harmed
//      (this is the whole reason evict is split from forget).
//   4. recall_log rows for an evicted stash id are cleaned (parity with forget's old cascade).
//
// Exercises the EXACT SQL evictStash() will ship, run directly against a real store.
// Usage: node poc/evict-poc.mjs

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import assert from "node:assert/strict";

const root = mkdtempSync(join(tmpdir(), "litectx-evictpoc-"));
const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: false });
const db = ctx.store.db;
const HOUR = 3_600_000;
const now = Date.now();

const stashIds = () => db.prepare("SELECT path FROM stash ORDER BY created_at").all().map((r) => r.path);
const factCount = () => db.prepare("SELECT COUNT(*) c FROM mem WHERE kind='fact'").get().c;
const logCount = (p) => db.prepare("SELECT COUNT(*) c FROM recall_log WHERE path=?").get(p).c;

function seed() {
  db.prepare("DELETE FROM stash").run();
  ctx.store.writeStash({ id: "stash:a", text: "AAA", createdAt: now - 5 * HOUR }); // oldest
  ctx.store.writeStash({ id: "stash:b", text: "BBB", createdAt: now - 3 * HOUR });
  ctx.store.writeStash({ id: "stash:c", text: "CCC", createdAt: now - 1 * HOUR });
  ctx.store.writeStash({ id: "stash:d", text: "DDD", createdAt: now });         // newest
}

// candidate SQL (verbatim what evictStash will run)
const SQL = {
  id: "WHERE path = ?",
  olderThan: "WHERE created_at < ?",
  maxCount: "WHERE path IN (SELECT path FROM stash ORDER BY created_at DESC LIMIT -1 OFFSET ?)",
};
function evict(where, ...params) {
  const tx = db.transaction(() => {
    const paths = db.prepare(`SELECT path FROM stash ${where}`).all(...params).map((r) => r.path);
    const removed = db.prepare(`DELETE FROM stash ${where}`).run(...params).changes;
    const delLog = db.prepare("DELETE FROM recall_log WHERE path = ?");
    for (const p of paths) delLog.run(p);
    return removed;
  });
  return tx();
}

try {
  // a durable fact + a fetch-log row on a stash id, to prove evict spares memory and cleans logs
  await ctx.remember("fact:keep", "auth uses jwt", { kind: "fact" });
  assert.equal(factCount(), 1);

  // ---- 1. by id ----
  seed();
  db.prepare("INSERT INTO recall_log(path, kind, action, ts) VALUES('stash:a','stash','fetch',?)").run(now); // simulate a get(id) fetch
  assert.equal(logCount("stash:a"), 1, "precondition: a fetch log exists");
  let n = evict(SQL.id, "stash:a");
  assert.equal(n, 1, "by-id removes exactly 1");
  assert.deepEqual(stashIds(), ["stash:b", "stash:c", "stash:d"], "by-id keeps the rest");
  assert.equal(logCount("stash:a"), 0, "by-id cleans the evicted id's recall_log rows");

  // ---- 2. by age: olderThan = 2h ago → deletes a(5h) + b(3h), keeps c(1h) + d(now) ----
  seed();
  n = evict(SQL.olderThan, now - 2 * HOUR);
  assert.equal(n, 2, "by-age removes the 2 older");
  assert.deepEqual(stashIds(), ["stash:c", "stash:d"], "by-age keeps the newer two");

  // ---- 3. by maxCount=2: keep newest 2 (c,d), delete oldest 2 (a,b) ----
  seed();
  n = evict(SQL.maxCount, 2);
  assert.equal(n, 2, "by-count removes all but newest 2");
  assert.deepEqual(stashIds(), ["stash:c", "stash:d"], "by-count keeps the NEWEST two");

  // maxCount=0 → delete all; maxCount ≥ size → delete none
  seed();
  assert.equal(evict(SQL.maxCount, 0), 4, "maxCount=0 evicts all");
  assert.deepEqual(stashIds(), []);
  seed();
  assert.equal(evict(SQL.maxCount, 10), 0, "maxCount ≥ size evicts none");
  assert.deepEqual(stashIds(), ["stash:a", "stash:b", "stash:c", "stash:d"]);

  // ---- 4. THE INVARIANT: through all of that, the fact is untouched ----
  assert.equal(factCount(), 1, "evict NEVER touches written memory");
  assert.ok(db.prepare("SELECT 1 FROM mem WHERE path='fact:keep'").get(), "fact:keep survives every evict");

  console.log("✓ evict POC — all assertions passed");
  console.log("  by-id (+log cleanup) · by-age (created_at<) · by-maxCount (keep newest n) · memory untouched");
} finally {
  ctx.close();
  rmSync(root, { recursive: true, force: true });
}
