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

// ── memory axis (multis M4 R3): kind:'fact'|'episode' → recency over fact/episode, owner-fenced ──

test("memory axis: facts newest-first by created_at; a re-stated fact bumps to front", async () => {
  const { root, dbPath } = db("mem-fact-order");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("fact:1", "age is 44", { kind: "fact" });
  await sleep(3);
  await ctx.remember("fact:2", "deadline is aug 20", { kind: "fact" });

  assert.deepEqual(paths(ctx.recentMemory({ kind: "fact", n: 50 })), ["fact:2", "fact:1"], "newest fact first");
  // a superseding re-write of the same id (W4 upsert) refreshes created_at → ranks newest
  await sleep(3);
  await ctx.remember("fact:1", "age is 45", { kind: "fact" });
  const r = ctx.recentMemory({ kind: "fact", n: 50 });
  assert.equal(r[0].path, "fact:1", "re-stated fact bumps to front");
  assert.equal(r.length, 2, "still one row per id — no pile-up");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("memory axis: episodes order by occurred_at, NOT write time (a backdated episode sorts older)", async () => {
  const { root, dbPath } = db("mem-ep-order");
  const ctx = new LiteCtx({ root, dbPath });
  const t = Date.now();
  // ep:recent has the NEWER occurred_at but is WRITTEN FIRST; ep:old is written later but backdated.
  // Ordering by occurred_at (not created_at/write order) must put ep:recent first.
  await ctx.remember("ep:recent", "User: hi\nAssistant: hello", { kind: "episode", occurredAt: t });
  await sleep(3);
  await ctx.remember("ep:old", "User: earlier\nAssistant: yes", { kind: "episode", occurredAt: t - 100_000 });

  assert.deepEqual(paths(ctx.recentMemory({ kind: "episode", n: 50 })), ["ep:recent", "ep:old"], "occurred_at drives order");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("memory axis: kind array blends fact+episode on COALESCE(occurred_at, created_at)", async () => {
  const { root, dbPath } = db("mem-blend");
  const ctx = new LiteCtx({ root, dbPath });
  const t = Date.now();
  await ctx.remember("fact:f", "a durable fact", { kind: "fact" }); // ranks on created_at ≈ t
  await ctx.remember("ep:future", "later exchange", { kind: "episode", occurredAt: t + 100_000 }); // newest
  await ctx.remember("ep:past", "older exchange", { kind: "episode", occurredAt: t - 100_000 }); // oldest

  const r = paths(ctx.recentMemory({ kind: ["fact", "episode"], n: 50 }));
  assert.equal(r[0], "ep:future", "future-dated episode is newest");
  assert.equal(r[r.length - 1], "ep:past", "past-dated episode is oldest");
  assert.ok(r.includes("fact:f"), "the fact blends in by its created_at");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("memory axis: owner-fenced to tenant ∪ shared — never another tenant's memory (the security claim)", async () => {
  const { root, dbPath } = db("mem-fence");
  const ctx = new LiteCtx({ root, dbPath }); // ownerless instance, per-call tenant scope
  await ctx.remember("fact:a", "tenant A secret", { kind: "fact", scope: "A" });
  await ctx.remember("fact:b", "tenant B secret", { kind: "fact", scope: "B" });
  await ctx.remember("fact:g", "shared truth", { kind: "fact", scope: GLOBAL });

  assert.deepEqual(paths(ctx.recentMemory({ kind: "fact", scope: "A", n: 50 })).sort(), ["fact:a", "fact:g"], "A ∪ shared, never B");
  assert.deepEqual(paths(ctx.recentMemory({ kind: "fact", scope: "B", n: 50 })).sort(), ["fact:b", "fact:g"], "B ∪ shared, never A");
  assert.deepEqual(paths(ctx.recentMemory({ kind: "fact", scope: GLOBAL, n: 50 })), ["fact:g"], "GLOBAL = shared tier only");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("memory axis: body verbatim + opaque meta.role survive (faithful history reconstruction)", async () => {
  const { root, dbPath } = db("mem-meta");
  const ctx = new LiteCtx({ root, dbPath });
  // multis carries role/turn markers in meta (NOT parsed from the body string) — R3 fork 2.
  await ctx.remember("ep:u", "what is my age?", { kind: "episode", meta: { role: "user", turn: 1 } });
  await ctx.remember("ep:a", "you are 45", { kind: "episode", meta: { role: "assistant", turn: 2 } });

  const r = ctx.recentMemory({ kind: "episode", n: 50, body: true });
  const u = r.find((h) => h.path === "ep:u");
  const a = r.find((h) => h.path === "ep:a");
  assert.equal(u.body, "what is my age?", "user body verbatim");
  assert.equal(u.meta.role, "user", "role passthrough");
  assert.equal(a.meta.role, "assistant", "role passthrough");
  assert.ok(typeof u.occurredAt === "number", "occurredAt exposed for ordering/reconstruction");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("memory axis: a recency read does NOT bump the demand signal (a recall DOES — the failable control)", async () => {
  const { root, dbPath } = db("mem-nouse");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("fact:jwt", "auth uses jwt tokens", { kind: "fact", scope: "A" });

  // recentMemory must not log a recall → reviewCandidates(1) sees use=0 → empty.
  ctx.recentMemory({ kind: "fact", scope: "A", n: 50 });
  assert.deepEqual(ctx.reviewCandidates(1, { scope: "A" }).map((c) => c.id ?? c.path), [], "recentMemory left use at 0");

  // the control: a real recall of the same row DOES bump it → now it's a review candidate.
  const hits = await ctx.recall("jwt", { kind: "fact", scope: "A" });
  assert.ok(hits.length > 0, "recall found the fact");
  assert.ok(ctx.reviewCandidates(1, { scope: "A" }).length > 0, "recall bumped use → review candidate");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("memory axis: strictScope throws on a bare memory recency read; mixing doc+mem kinds throws", async () => {
  const { root, dbPath } = db("mem-strict");
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await ctx.remember("fact:t", "tenant fact", { kind: "fact", scope: "t1" });

  assert.throws(() => ctx.recentMemory({ kind: "fact" }), /strictScope/, "missing scope throws on memory axis");
  assert.deepEqual(paths(ctx.recentMemory({ kind: "fact", scope: "t1", n: 50 })), ["fact:t"], "explicit tenant scope works");
  // the two axes resolve scope differently → a single call can't mix them
  assert.throws(() => ctx.recentMemory({ kind: ["doc", "fact"], scope: "t1" }), /separate scope axes/, "doc+mem in one call throws");
  assert.throws(() => ctx.recentMemory({ kind: "bogus", scope: "t1" }), /doc \| fact \| episode/, "unknown kind throws");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("memory axis: ScopedView binds the tenant for fact/episode recency", async () => {
  const { root, dbPath } = db("mem-view");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("fact:a", "A fact", { kind: "fact", scope: "A" });
  await ctx.remember("fact:b", "B fact", { kind: "fact", scope: "B" });
  await ctx.remember("fact:g", "shared", { kind: "fact", scope: GLOBAL });

  const view = ctx.scoped("A");
  assert.deepEqual(paths(view.recentMemory({ kind: "fact", n: 50 })).sort(), ["fact:a", "fact:g"], "bound to A + shared, never B");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
