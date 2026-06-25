// multis M4 — per-tenant isolation on the MEMORY axis (fact/episode) from ONE shared instance.
// Before M4 the memory axis fenced ONLY by the instance owner/session set at construction, so a single
// `LiteCtx` could not fence per-tenant facts/episodes (the per-call `scope` arg drove only the doc axis).
// M4 threads `scope` → `mem_scope.owner` per call: `ctx.scoped('cust:X')` (or an explicit `scope`) fences
// recall AND the ladder (promotionCandidates/reviewCandidates) to that tenant ∪ the global tier, the same
// way the doc axis fences via `scope`. Behavior, not implementation. A SHARED FILE db (not :memory:, which
// is per-connection) — but the whole point is that ONE instance now suffices, so almost every test below
// uses a single `LiteCtx`. The two-instance shape (which already worked) is the explicit control.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, GLOBAL } from "../src/index.js";

/** A throwaway shared-db root; returns { root, dbPath }. */
function sharedDb() {
  const root = mkdtempSync(join(tmpdir(), "litectx-memscope-"));
  mkdirSync(join(root, "src"), { recursive: true });
  return { root, dbPath: join(root, "memscope.db") };
}

const paths = (hits) => hits.map((h) => h.path).sort();

/** Deterministic 2-D marker embedder (alpha/beta) — same shape the real model returns. */
function markerStub() {
  return {
    async embed(text) {
      const a = (text.match(/alpha/g) || []).length;
      const b = (text.match(/beta/g) || []).length;
      const n = Math.hypot(a, b) || 1;
      return Float32Array.from([a / n, b / n]);
    },
  };
}

// === Q2 closed: one instance fences fact recall per tenant ======================================

test("M4: one instance — a tenant's fact recall returns ITS facts ∪ global only, never another tenant's", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath }); // ONE instance, ownerless
  // identical-matching content so the ONLY differentiator is the per-call tenant scope (not relevance)
  await ctx.scoped("cust:A").remember("fact:a", "the auth service uses JWT bearer tokens", { kind: "fact" });
  await ctx.scoped("cust:B").remember("fact:b", "the auth service uses JWT bearer tokens", { kind: "fact" });
  await ctx.remember("fact:g", "the auth service uses JWT bearer tokens", { kind: "fact", scope: GLOBAL });

  const q = "auth JWT tokens";
  assert.deepEqual(paths(await ctx.scoped("cust:A").recall(q, { kind: "fact" })), ["fact:a", "fact:g"], "A sees A ∪ global, never B");
  assert.deepEqual(paths(await ctx.scoped("cust:B").recall(q, { kind: "fact" })), ["fact:b", "fact:g"], "B sees B ∪ global, never A");
  // the explicit per-call scope on the base method fences identically (the view is sugar over it)
  assert.deepEqual(paths(await ctx.recall(q, { kind: "fact", scope: "cust:A" })), ["fact:a", "fact:g"], "explicit scope arg fences the base method too");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("M4: one instance — episode recall is tenant-fenced the same way", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.scoped("cust:A").remember("ep:a", "Investigated the rate limiter in the auth service.", { kind: "episode" });
  await ctx.scoped("cust:B").remember("ep:b", "Investigated the rate limiter in the auth service.", { kind: "episode" });

  const q = "rate limiter auth service";
  assert.deepEqual(paths(await ctx.scoped("cust:A").recall(q, { kind: "episode" })), ["ep:a"], "A sees only its own episode");
  assert.deepEqual(paths(await ctx.scoped("cust:B").recall(q, { kind: "episode" })), ["ep:b"], "B sees only its own episode");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === global tier stays visible to every tenant; GLOBAL view sees only the shared tier ============

test("M4: GLOBAL memory is visible to every tenant; a GLOBAL view sees ONLY the shared tier", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.scoped("cust:A").remember("fact:a", "deploys run on the kubernetes cluster", { kind: "fact" });
  await ctx.remember("fact:g", "deploys run on the kubernetes cluster", { kind: "fact", scope: GLOBAL });

  const q = "kubernetes deploys cluster";
  // every tenant sees the shared fact (the ∪ global half of the fence)
  assert.ok(paths(await ctx.scoped("cust:A").recall(q, { kind: "fact" })).includes("fact:g"), "A sees the global fact");
  assert.ok(paths(await ctx.scoped("cust:Z").recall(q, { kind: "fact" })).includes("fact:g"), "an unrelated tenant also sees the global fact");
  // a GLOBAL-bound view reads ONLY the shared tier — never a tenant's row
  assert.deepEqual(paths(await ctx.scoped(GLOBAL).recall(q, { kind: "fact" })), ["fact:g"], "GLOBAL view excludes tenant rows");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === Q1 + the fence: the promotion ladder respects the tenant fence =============================

test("M4: reviewCandidates is tenant-fenced — a tenant's agent-fact crosses threshold without surfacing another's", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.scoped("cust:A").remember("fact:a", "the auth service uses JWT bearer tokens", { kind: "fact" });
  await ctx.scoped("cust:B").remember("fact:b", "the auth service uses JWT bearer tokens", { kind: "fact" });

  // build recall demand on A's fact (within A's scope) past threshold; B's fact is never recalled
  const a = ctx.scoped("cust:A");
  for (let i = 0; i < 3; i++) await a.recall("auth JWT tokens", { kind: "fact" });

  // A's review queue surfaces ONLY A's fact; B's queue is empty (its fact has no demand, and A's is fenced out)
  assert.deepEqual(ctx.scoped("cust:A").reviewCandidates(2).map((c) => c.path), ["fact:a"], "A's review queue = A's fact only");
  assert.deepEqual(ctx.scoped("cust:B").reviewCandidates(2).map((c) => c.path), [], "B's review queue never shows A's fact");
  // negative control: an unscoped (admin) read on an ownerless instance still sees everything that qualifies
  assert.deepEqual(ctx.reviewCandidates(2).map((c) => c.path), ["fact:a"], "admin view sees the qualifying fact regardless of tenant");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("M4: promotionCandidates is tenant-fenced — another tenant's hot episode never leaks into the queue", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.scoped("cust:A").remember("ep:a", "Investigated the rate limiter in the auth service.", { kind: "episode" });
  await ctx.scoped("cust:B").remember("ep:b", "Investigated the rate limiter in the auth service.", { kind: "episode" });

  // make BOTH episodes hot, each within its own tenant scope
  const a = ctx.scoped("cust:A");
  const b = ctx.scoped("cust:B");
  for (let i = 0; i < 3; i++) (await a.recall("rate limiter", { kind: "episode" }), await b.recall("rate limiter", { kind: "episode" }));

  assert.deepEqual(ctx.scoped("cust:A").promotionCandidates(2).map((c) => c.path), ["ep:a"], "A's promotion queue = A's episode only");
  assert.deepEqual(ctx.scoped("cust:B").promotionCandidates(2).map((c) => c.path), ["ep:b"], "B's promotion queue = B's episode only");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === get(id) is fenced too — fencing recall without get is only half the boundary ===============

test("M4: get(id) for a fact/episode is tenant-fenced — a guessed id can't cross tenants (the security boundary)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true }); // ONE instance, fail-closed
  await ctx.scoped("cust:B").remember("fact:b", "B's private API key rotation", { kind: "fact" });
  await ctx.scoped("cust:A").remember("fact:a", "A's own note", { kind: "fact" });
  await ctx.remember("fact:g", "the shared refund policy", { kind: "fact", scope: GLOBAL });

  // the leak this closes: A declares ITS scope and fetches a GUESSED id belonging to B → must be null
  assert.equal(ctx.get("fact:b", { scope: "cust:A" }), null, "A cannot fetch B's fact even by exact id");
  // A's own + the global tier still resolve (∪ global)
  assert.equal(ctx.get("fact:a", { scope: "cust:A" })?.text, "A's own note", "A fetches its own fact");
  assert.equal(ctx.get("fact:g", { scope: "cust:A" })?.text, "the shared refund policy", "A fetches the global fact");
  // a GLOBAL fetch sees only the shared tier — a tenant fact reads as absent
  assert.equal(ctx.get("fact:a", { scope: GLOBAL }), null, "GLOBAL must NOT fetch a tenant-owned fact");
  assert.equal(ctx.get("fact:g", { scope: GLOBAL })?.text, "the shared refund policy", "GLOBAL fetches the shared fact");
  // bare get on a strict instance still throws (can't fence a guessable id without a scope)
  assert.throws(() => ctx.get("fact:b"), /strictScope/, "bare strict get(id) throws");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("M4 control: with strictScope OFF, a bare get(id) for a fact is unfenced (legacy by-id model intact)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath }); // strict OFF
  await ctx.scoped("cust:B").remember("fact:b", "B's note", { kind: "fact" });
  // legacy: a bare get by id returns the row regardless of owner (unchanged — the by-id model is opt-in to fence)
  assert.equal(ctx.get("fact:b")?.text, "B's note", "bare non-strict get is unfenced (legacy)");
  // but a SCOPED get still fences even with strict off — a different tenant's row reads as absent
  assert.equal(ctx.get("fact:b", { scope: "cust:A" }), null, "a scoped get fences by owner even with strict off");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === the fence threads through the semantic (KNN) path, not just BM25 ============================

test("M4: the owner fence reaches the embeddings/KNN path — cosine can't float another tenant's memory past the gate", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, embeddings: true, embedder: markerStub() }); // ONE instance
  // identical embeddings for both tenants — the ONLY differentiator is the per-call owner
  await ctx.scoped("cust:A").remember("ep:a", "alpha alpha beta deployment", { kind: "episode" });
  await ctx.scoped("cust:B").remember("ep:b", "alpha alpha beta deployment", { kind: "episode" });

  // hit knnCandidates DIRECTLY (isolate the semantic path from BM25) with each tenant's owner fence
  const qvec = await markerStub().embed("alpha beta");
  const nomA = ctx.store.knnCandidates("episode", qvec, 10, new Set(), { memOwner: "cust:A", memSeeAll: false });
  assert.deepEqual(nomA.map((h) => h.path).sort(), ["ep:a"], "KNN nominates only A's episode under A's fence");
  const nomB = ctx.store.knnCandidates("episode", qvec, 10, new Set(), { memOwner: "cust:B", memSeeAll: false });
  assert.deepEqual(nomB.map((h) => h.path).sort(), ["ep:b"], "KNN nominates only B's episode under B's fence");
  // control: seeAll (admin) nominates both — proves the fence above is what excluded, not a miss
  const nomAll = ctx.store.knnCandidates("episode", qvec, 10, new Set(), { memSeeAll: true });
  assert.deepEqual(nomAll.map((h) => h.path).sort(), ["ep:a", "ep:b"], "seeAll nominates both — the fence is what isolates");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === backward compatibility: the legacy instance-owner model is unchanged =======================

test("M4 control: an ownerless instance with no per-call scope sees everything (legacy single-tenant)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath }); // strictScope OFF, no owner
  await ctx.scoped("cust:A").remember("fact:a", "the auth service uses JWT bearer tokens", { kind: "fact" });
  await ctx.remember("fact:g", "the auth service uses JWT bearer tokens", { kind: "fact" }); // no scope → instance owner (null = global)

  // a bare, unscoped recall on an ownerless instance is the admin/legacy view: sees all tenants
  assert.deepEqual(paths(await ctx.recall("auth JWT tokens", { kind: "fact" })), ["fact:a", "fact:g"], "unscoped recall sees every owner");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("M4 control: an instance constructed with owner still fences by that owner when no per-call scope is passed", async () => {
  const { root, dbPath } = sharedDb();
  // write two tenants' facts via per-call scope on a shared writer
  const w = new LiteCtx({ root, dbPath });
  await w.scoped("cust:A").remember("fact:a", "the auth service uses JWT bearer tokens", { kind: "fact" });
  await w.scoped("cust:B").remember("fact:b", "the auth service uses JWT bearer tokens", { kind: "fact" });
  w.close();

  // a reader CONSTRUCTED as owner cust:A (the pre-M4 mechanism) still fences to A ∪ global with no per-call scope
  const a = new LiteCtx({ root, dbPath, owner: "cust:A" });
  assert.deepEqual(paths(await a.recall("auth JWT tokens", { kind: "fact" })), ["fact:a"], "instance owner fences with no per-call scope (legacy intact)");
  a.close();
  rmSync(root, { recursive: true, force: true });
});
