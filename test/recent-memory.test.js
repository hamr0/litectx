// recentMemory (multis M3 fast-follow) — recall's empty-FTS-match recency sibling for written `doc`
// memory: newest-first, scope-fenced (`scope ∪ null-global`), expiry-aware, capped at `n`. Behavior,
// not implementation. The three load-bearing claims (recency order, scope fence, expiry exclusion) are
// each written to FAIL under the obvious mutation (ASC sort / neutered fence / dropped expiry).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, GLOBAL } from "../src/index.js";

/** A throwaway file-db root (shared across instances, unlike per-connection :memory:). */
function db(tag) {
  const root = mkdtempSync(join(tmpdir(), `litectx-recentmem-${tag}-`));
  return { root, dbPath: join(root, "rm.db") };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const paths = (hits) => hits.map((h) => h.path);

test("returns direct docs newest-first, capped at n; re-write bumps to front", async () => {
  const { root, dbPath } = db("order");
  const ctx = new LiteCtx({ root, dbPath });
  // distinct write clocks so created_at strictly increases (the real Date.now()-at-write mechanism)
  await ctx.remember("doc:1", "first upload about apples", { kind: "doc" });
  await sleep(3);
  await ctx.remember("doc:2", "second upload about bananas", { kind: "doc" });
  await sleep(3);
  await ctx.remember("doc:3", "third upload about cherries", { kind: "doc" });

  assert.deepEqual(paths(ctx.recentMemory()), ["doc:3", "doc:2", "doc:1"], "newest first");
  assert.deepEqual(paths(ctx.recentMemory({ n: 2 })), ["doc:3", "doc:2"], "capped at n");
  assert.ok(
    ctx.recentMemory().every((h, i, a) => i === 0 || h.createdAt <= a[i - 1].createdAt),
    "createdAt is descending"
  );

  // upsert refreshes created_at → an old doc re-written becomes the most recent
  await sleep(3);
  await ctx.remember("doc:1", "apples, revisited", { kind: "doc" });
  assert.equal(ctx.recentMemory()[0].path, "doc:1", "re-write bumps to front");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("doc axis only — never facts, episodes, or indexed files", async () => {
  const { root, dbPath } = db("axis");
  mkdirSync(join(root, "src"), { recursive: true });
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("doc:d", "a real upload", { kind: "doc" });
  await ctx.remember("fact:f", "auth uses jwt", { kind: "fact" });
  await ctx.remember("ep:e", "looked at the limiter", { kind: "episode" });

  const r = ctx.recentMemory({ n: 50 });
  assert.deepEqual(paths(r), ["doc:d"], "only the direct doc");
  assert.ok(r.every((h) => h.kind === "doc"));

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("scope fences to `scope ∪ null-global` — never another tenant's upload", async () => {
  const { root, dbPath } = db("scope");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("doc:a1", "apple chat a", { kind: "doc", scope: "chat:a" });
  await ctx.remember("doc:b1", "banana chat b", { kind: "doc", scope: "chat:b" });
  await ctx.remember("doc:g1", "shared knowledge base", { kind: "doc" }); // null scope = global

  assert.deepEqual(paths(ctx.recentMemory({ scope: "chat:a", n: 50 })).sort(), ["doc:a1", "doc:g1"], "a + global, never b");
  assert.deepEqual(paths(ctx.recentMemory({ scope: GLOBAL, n: 50 })), ["doc:g1"], "GLOBAL = shared tier only");
  // unscoped reader = single-tenant see-all (backward-compatible)
  assert.deepEqual(paths(ctx.recentMemory({ n: 50 })).sort(), ["doc:a1", "doc:b1", "doc:g1"], "unscoped sees all");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("expired rows (R5) are excluded, scope or not", async () => {
  const { root, dbPath } = db("expiry");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("doc:live", "still fresh", { kind: "doc" });
  await ctx.remember("doc:dead", "already stale", { kind: "doc", expiresAt: Date.now() - 1000 });

  assert.deepEqual(paths(ctx.recentMemory({ n: 50 })), ["doc:live"], "expired hidden");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("body:true inlines verbatim text; a blob has no text body", async () => {
  const { root, dbPath } = db("body");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("doc:body", "the verbatim body text", { kind: "doc" });
  const blob = await ctx.ingest(Buffer.from([0, 1, 2, 3, 255]), { filename: "data.bin" }); // → blob, kind doc

  const r = ctx.recentMemory({ n: 50, body: true });
  assert.equal(r.find((h) => h.path === "doc:body").body, "the verbatim body text", "doc body verbatim");
  assert.equal(r.find((h) => h.path === blob.id).body, null, "blob has no text body");
  assert.deepEqual([...ctx.get(blob.id).bytes], [0, 1, 2, 3, 255], "blob bytes still round-trip via get");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("strictScope: a bare recentMemory throws; tenant scope and GLOBAL work", async () => {
  const { root, dbPath } = db("strict");
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await ctx.remember("doc:t", "tenant upload", { kind: "doc", scope: "t1" });

  assert.throws(() => ctx.recentMemory(), /strictScope/, "missing scope throws under strictScope");
  assert.deepEqual(paths(ctx.recentMemory({ scope: "t1", n: 50 })), ["doc:t"], "explicit tenant scope works");
  assert.doesNotThrow(() => ctx.recentMemory({ scope: GLOBAL }), "GLOBAL works");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("ScopedView.recentMemory carries the bound scope", async () => {
  const { root, dbPath } = db("view");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("doc:a1", "apple chat a", { kind: "doc", scope: "chat:a" });
  await ctx.remember("doc:b1", "banana chat b", { kind: "doc", scope: "chat:b" });
  await ctx.remember("doc:g1", "shared kb", { kind: "doc" });

  const view = ctx.scoped("chat:a");
  assert.deepEqual(paths(view.recentMemory({ n: 50 })).sort(), ["doc:a1", "doc:g1"], "bound to chat:a + global");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
