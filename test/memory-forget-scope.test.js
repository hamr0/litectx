// multis M4 — tenant-scoped memory FORGET on the public API (`forget({ scope })`).
// The delete-side mirror of the memory-scope READ fence (see memory-scope.test.js): one shared LiteCtx
// must delete ALL of one tenant's fact+episode rows and NONE of any other tenant's. Tenants A='user:1'
// and B='user:12' are chosen so A is a textual PREFIX of B — the worst case for any id-based shortcut,
// proving the fence is owner-based (mem_scope.owner), not a LIKE on the id. Behavior, not implementation.
// Shared FILE db (not :memory:, which is per-connection) so one instance is the whole multi-tenant store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, GLOBAL } from "../src/index.js";

function sharedDb() {
  const root = mkdtempSync(join(tmpdir(), "litectx-forgetscope-"));
  mkdirSync(join(root, "src"), { recursive: true });
  return { root, dbPath: join(root, "forgetscope.db") };
}

const paths = (hits) => hits.map((h) => h.path).sort();
const A = "user:1";
const B = "user:12"; // A is a textual prefix of B — proves the fence is owner-based, not id-LIKE

/** Seed A and B (and optionally GLOBAL) each with a fact + episode that all match the same query. */
async function seedTwoTenants(ctx, { global = false } = {}) {
  await ctx.scoped(A).remember("fact:a", "the auth service uses JWT bearer tokens", { kind: "fact" });
  await ctx.scoped(A).remember("ep:a", "Investigated the auth service rate limiter.", { kind: "episode" });
  await ctx.scoped(B).remember("fact:b", "the auth service uses JWT bearer tokens", { kind: "fact" });
  await ctx.scoped(B).remember("ep:b", "Investigated the auth service rate limiter.", { kind: "episode" });
  if (global) {
    await ctx.remember("fact:g", "the auth service uses JWT bearer tokens", { kind: "fact", scope: GLOBAL });
    await ctx.remember("ep:g", "Investigated the auth service rate limiter.", { kind: "episode", scope: GLOBAL });
  }
}

// === 1. Isolation — the security control ========================================================

test("M4 forget: scoped(A).forget() removes ALL of A's fact+episode and NONE of B's", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await seedTwoTenants(ctx);

  const removed = ctx.scoped(A).forget();
  assert.equal(removed, 2, "exactly A's two rows (fact + episode) deleted");

  // A's memory is gone
  assert.deepEqual(paths(await ctx.scoped(A).recall("auth JWT tokens", { kind: "fact" })), [], "A's fact gone");
  assert.deepEqual(paths(await ctx.scoped(A).recall("rate limiter", { kind: "episode" })), [], "A's episode gone");
  // negative control: B's rows still recall (the fence deleted A only)
  assert.deepEqual(paths(await ctx.scoped(B).recall("auth JWT tokens", { kind: "fact" })), ["fact:b"], "B's fact survives");
  assert.deepEqual(paths(await ctx.scoped(B).recall("rate limiter", { kind: "episode" })), ["ep:b"], "B's episode survives");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === 2. Kind narrow ==============================================================================

test("M4 forget: { scope, kind: 'episode' } removes A's episodes only — A's facts survive", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await seedTwoTenants(ctx);

  const removed = ctx.scoped(A).forget({ kind: "episode" });
  assert.equal(removed, 1, "only A's one episode deleted");
  assert.deepEqual(paths(await ctx.scoped(A).recall("rate limiter", { kind: "episode" })), [], "A's episode gone");
  assert.deepEqual(paths(await ctx.scoped(A).recall("auth JWT tokens", { kind: "fact" })), ["fact:a"], "A's fact survives the kind narrow");
  assert.deepEqual(paths(await ctx.scoped(B).recall("rate limiter", { kind: "episode" })), ["ep:b"], "B's episode untouched");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === 3. Global tier ==============================================================================

test("M4 forget: a tenant forget leaves GLOBAL intact; forget({ scope: GLOBAL }) clears only the shared tier", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await seedTwoTenants(ctx, { global: true });

  // a tenant forget must NOT delete the shared tier (the stricter `owner = @owner`, never `owner IS NULL`)
  ctx.scoped(A).forget();
  assert.ok(paths(await ctx.scoped(B).recall("auth JWT tokens", { kind: "fact" })).includes("fact:g"), "GLOBAL fact survives a tenant forget");

  // forget({ scope: GLOBAL }) deletes ONLY the shared tier — no tenant's rows
  const removed = ctx.forget({ scope: GLOBAL });
  assert.equal(removed, 2, "exactly the two GLOBAL rows (fact + episode) deleted");
  assert.deepEqual(paths(await ctx.scoped(GLOBAL).recall("auth JWT tokens", { kind: "fact" })), [], "shared fact gone");
  assert.deepEqual(paths(await ctx.scoped(B).recall("auth JWT tokens", { kind: "fact" })), ["fact:b"], "B's fact still present after GLOBAL forget");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === 4. Doc axis untouched =======================================================================

test("M4 forget: scoped(A).forget() does NOT touch A's ingested doc rows (separate doc_scope axis)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await ctx.scoped(A).remember("fact:a", "the auth service uses JWT bearer tokens", { kind: "fact" });
  await ctx.scoped(A).ingest(new TextEncoder().encode("# Runbook\n\nThe auth service uses JWT bearer tokens for all requests."), {
    filename: "runbook.md",
    id: "doc:a",
  });

  ctx.scoped(A).forget();
  assert.deepEqual(paths(await ctx.scoped(A).recall("auth JWT tokens", { kind: "fact" })), [], "A's fact gone");
  assert.ok((await ctx.scoped(A).recall("auth JWT bearer", { kind: "doc" })).length > 0, "A's ingested doc still recalls — forget is mem-axis only");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === 5. Fail-closed ==============================================================================

test("M4 forget: under strictScope a scope-less memory forget THROWS — never a silent see-everything wipe", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await seedTwoTenants(ctx);

  assert.throws(() => ctx.forget({}), /strictScope/, "empty-selector forget throws under strict");
  assert.throws(() => ctx.forget({ kind: "fact" }), /strictScope/, "owner-blind { kind } forget throws under strict (no tenant-blind wipe by omission)");
  // and nothing was deleted by the throwing calls
  assert.deepEqual(paths(await ctx.scoped(A).recall("auth JWT tokens", { kind: "fact" })), ["fact:a"], "A's fact intact after the throws");
  assert.deepEqual(paths(await ctx.scoped(B).recall("auth JWT tokens", { kind: "fact" })), ["fact:b"], "B's fact intact after the throws");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === 6. Back-compat (non-strict) =================================================================

test("M4 forget: legacy forget('id') and owner-blind forget({ kind, by }) behave exactly as 0.21.0", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath }); // strict OFF — the 0.21.0 default
  await seedTwoTenants(ctx);
  await ctx.remember("fact:human", "the deploy pipeline runs on fridays", { kind: "fact", by: "human" });

  // exact-id forget — unchanged
  assert.equal(ctx.forget("fact:a"), 1, "forget('id') removes the one row");
  assert.equal(ctx.get("fact:a"), null, "the id is gone");

  // owner-blind { kind, by } — still reaches every tenant (legacy bulk invalidation, unchanged)
  const removedFacts = ctx.forget({ kind: "fact" }); // fact:a already gone above → fact:b + fact:human remain
  assert.equal(removedFacts, 2, "owner-blind { kind:'fact' } deletes facts across ALL tenants (fact:b + fact:human)");
  assert.equal(ctx.get("fact:b"), null, "B's fact removed by the owner-blind bulk delete (legacy behavior)");
  // episodes survive the fact-kinded bulk delete
  assert.ok(ctx.get("ep:b") != null, "episodes untouched by { kind:'fact' }");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === 7. Bind-once ================================================================================

test("M4 forget: scoped(A).forget() needs no scope argument and fences to A (bind-once)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await seedTwoTenants(ctx);

  const a = ctx.scoped(A); // bound once — there is no per-call scope to omit
  a.forget();
  assert.deepEqual(paths(await ctx.scoped(A).recall("auth JWT tokens", { kind: "fact" })), [], "A fenced by the bound view, no scope arg passed");
  assert.deepEqual(paths(await ctx.scoped(B).recall("auth JWT tokens", { kind: "fact" })), ["fact:b"], "B untouched");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === 8. Precise by-key selectors on the object form: { id } and { idPrefix } =====================

test("M4 forget: { idPrefix } drops a base id + all its #-segments, leaving a sibling prefix intact (owner-blind)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath }); // strict OFF — precise by-key delete, single-tenant
  await ctx.remember("kb:guide", "the deploy guide root", { kind: "doc" });
  await ctx.remember("kb:guide#0", "deploy guide section one", { kind: "doc" });
  await ctx.remember("kb:guide#1", "deploy guide section two", { kind: "doc" });
  await ctx.remember("kb:guidebook", "an unrelated sibling whose id shares the prefix", { kind: "doc" });

  const removed = ctx.forget({ idPrefix: "kb:guide" });
  assert.equal(removed, 3, "base + #0 + #1 removed (the #-anchored prefix), sibling spared");
  assert.equal(ctx.get("kb:guide"), null, "base gone");
  assert.equal(ctx.get("kb:guide#1"), null, "segment gone");
  assert.ok(ctx.get("kb:guidebook") != null, "sibling 'kb:guidebook' survives — prefix is #-anchored, not a bare LIKE");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("M4 forget: { id } object form equals the string form; both are precise by-key deletes", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("fact:x", "a precise fact", { kind: "fact" });
  assert.equal(ctx.forget({ id: "fact:x" }), 1, "{ id } removes the one row");
  assert.equal(ctx.get("fact:x"), null, "gone");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("M4 forget: a precise { idPrefix } is allowed even under strictScope (it names an exact target, not a blind wipe)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await ctx.scoped(A).remember("kb:guide", "guide root", { kind: "doc" });
  await ctx.scoped(A).remember("kb:guide#0", "guide section", { kind: "doc" });
  // precise by-key delete does NOT require a scope (unlike { kind } / { } which throw under strict)
  assert.equal(ctx.forget({ idPrefix: "kb:guide" }), 2, "{ idPrefix } runs under strictScope (precise, not omission-blind)");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === 9. The combination guard — scope + (id/idPrefix/by) must NOT silently widen to a tenant wipe ===

test("M4 forget: { scope } + a narrower (id/idPrefix/by) THROWS — never silently widens into a tenant-wide wipe", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await seedTwoTenants(ctx);

  assert.throws(() => ctx.forget({ scope: A, idPrefix: "fact" }), /does not combine/, "base method rejects scope + idPrefix");
  assert.throws(() => ctx.forget({ scope: A, id: "fact:a" }), /does not combine/, "base method rejects scope + id");
  assert.throws(() => ctx.forget({ scope: A, by: "human" }), /does not combine/, "base method rejects scope + by (would silently drop the by-filter and wipe all of A)");
  // the footgun this closes: a scoped view injects the scope, so a stray narrower would otherwise wipe ALL of A
  assert.throws(() => ctx.scoped(A).forget({ idPrefix: "fact:a" }), /does not combine/, "scoped view rejects idPrefix too (scope is injected)");
  assert.throws(() => ctx.scoped(A).forget({ by: "human" }), /does not combine/, "scoped view rejects by too (else a by-filter silently widens to a full tenant wipe)");
  // nothing was deleted by the throwing calls
  assert.deepEqual(paths(await ctx.scoped(A).recall("auth JWT tokens", { kind: "fact" })), ["fact:a"], "A's fact intact — the throw prevented an over-wide wipe");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
