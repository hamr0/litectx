// Concurrency + self-heal correctness for index() — the class of bug a v0.30.0 background warm-index
// surfaced. Two independent properties, each written to FAIL if its fix regresses:
//
//   #1 ATOMIC REBUILD. A force/self-heal rebuild used to clearIndexed() up front, then sit on an EMPTY
//      index through the whole (seconds-long) chunk loop before applyChanges repopulated it. A reader
//      interleaving there (a warm-index firing while the model recalls) saw nothing. The clear is now
//      folded INTO applyChanges' transaction, so a concurrent recall sees the old index or the new one,
//      never empty. Test: fire a force rebuild WITHOUT awaiting, recall while it's in flight.
//
//   #2 BACKFILL DRIFT GUARD. The embeddings backfill embeds fresh disk bytes for a vectorless file. If
//      the file drifted since this pass's diff snapshot, its stored chunk body is the OLD content —
//      pairing a vector with mismatched text. The backfill now skips a file whose disk hash != its
//      stored content_hash. Test (white-box): plant a vectorless row whose stored hash is stale but
//      whose (mtime,size) match disk (so the diff fast-skips it into the backfill), and assert it is
//      NOT embedded while its honest siblings are.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

function fixtureRepo(n) {
  const root = mkdtempSync(join(tmpdir(), "litectx-conc-"));
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < n; i++)
    writeFileSync(join(root, "src", `m${i}.js`), `/** documented unit ${i} */\nexport function feature${i}(x){ return x + ${i}; }\n`);
  return root;
}

test("#1 a recall during a concurrent force rebuild sees the full index, never the empty window", async () => {
  const root = fixtureRepo(20);
  const ctx = new LiteCtx({ root, dbPath: join(root, "idx.db") });
  try {
    await ctx.index();
    const before = (await ctx.recall("documented", { kind: "code", n: 50 })).length;
    assert.ok(before >= 20, `precondition: baseline recall hits every file (${before})`);

    // fire the rebuild WITHOUT awaiting; the recall interleaves at the rebuild's first chunk-loop await,
    // which is BEFORE applyChanges. Pre-fix (clearIndexed ran up front) this recall returned 0.
    const rebuilding = ctx.index({ force: true });
    const during = (await ctx.recall("documented", { kind: "code", n: 50 })).length;
    assert.equal(during, before, "the index stays fully queryable throughout the rebuild (atomic swap)");

    await rebuilding;
    assert.equal((await ctx.recall("documented", { kind: "code", n: 50 })).length, before, "and after");
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("#1 the rebuild still fully re-chunks (atomic clear is equivalent to the old up-front clear)", async () => {
  const root = fixtureRepo(6);
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  try {
    await ctx.index();
    const nodesBefore = ctx.store.db.prepare("SELECT COUNT(*) c FROM nodes").get().c;
    // remove a file, add a file, then force: the rebuild must reflect the current tree exactly (no stragglers)
    rmSync(join(root, "src", "m0.js"));
    writeFileSync(join(root, "src", "m9.js"), `/** documented unit 9 */\nexport function feature9(x){ return x + 9; }\n`);
    const r = await ctx.index({ force: true });
    assert.equal(r.added, 6, "force re-reads every current file");
    assert.equal(ctx.store.db.prepare("SELECT COUNT(*) c FROM file_index WHERE path='src/m0.js'").get().c, 0, "the deleted file left no straggler row");
    assert.equal(ctx.store.db.prepare("SELECT COUNT(*) c FROM file_index WHERE path='src/m9.js'").get().c, 1, "the new file is indexed");
    assert.ok(ctx.store.db.prepare("SELECT COUNT(*) c FROM nodes").get().c > 0 && nodesBefore > 0);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// A deterministic 1-D stub embedder (no model, no network). Every file gets a vector, so a MISSING
// vector after an embeddings-on pass is a real signal (the drift guard skipped it), not a stub quirk.
const stub = () => ({ async embed(/** @type {string} */ t) { return Float32Array.from([t.length % 7 || 1]); } });

test("#2 the backfill skips a file whose disk bytes drifted from its stored hash; honest siblings still embed", async () => {
  const root = fixtureRepo(3);
  const dbPath = join(root, "idx.db");
  // pass 1: embeddings OFF → files indexed, all vectorless
  const off = new LiteCtx({ root, dbPath });
  await off.index();
  assert.equal(off.store.embeddingCount(), 0, "precondition: no vectors after the off pass");
  off.close();

  // corrupt src/m1.js's stored content_hash to a stale value while keeping (mtime,size) matching disk,
  // so the incremental diff FAST-SKIPS it (never re-hashes) and it reaches the backfill as "unchanged".
  const on = new LiteCtx({ root, dbPath, embeddings: true, embedder: stub() });
  const st = statSync(join(root, "src", "m1.js"));
  on.store.db.prepare("UPDATE file_index SET content_hash='0'||content_hash, mtime=?, size=? WHERE path='src/m1.js'")
    .run(Math.floor(st.mtimeMs), st.size);
  try {
    await on.index(); // backfill runs; the drift guard must exclude the tampered file
    const has = (/** @type {string} */ p) => on.store.db.prepare("SELECT COUNT(*) c FROM file_embeddings WHERE path=?").get(p).c;
    assert.equal(has("src/m1.js"), 0, "drifted file was NOT embedded (guard skipped it — vector would mismatch its stored body)");
    assert.equal(has("src/m0.js"), 1, "an honest vectorless sibling WAS backfilled");
    assert.equal(has("src/m2.js"), 1, "…and the other one too");
  } finally {
    on.close();
    rmSync(root, { recursive: true, force: true });
  }
});
