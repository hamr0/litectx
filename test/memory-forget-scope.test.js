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
  // W4: B's rows are owner-keyed, so verify via a SCOPED get (a bare get can't reach a tenant row).
  assert.equal(ctx.get("fact:b", { scope: B }), null, "B's fact removed by the owner-blind bulk delete (legacy behavior)");
  // episodes survive the fact-kinded bulk delete
  assert.ok(ctx.get("ep:b", { scope: B }) != null, "episodes untouched by { kind:'fact' }");
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

// === 9. The combination guard — scope + { by } must NOT silently widen to a tenant wipe ==========
// (Feature B, 0.27.0: scope + { id }/{ idPrefix } NO LONGER throw — they fence a delete-by-key; see §10.)

test("M4 forget: { scope } + { by } still THROWS — an owner-blind provenance filter can't ride a tenant fence", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await seedTwoTenants(ctx);

  assert.throws(() => ctx.forget({ scope: A, by: "human" }), /does not combine with \{ by \}/, "base method rejects scope + by (would silently drop the by-filter and wipe all of A)");
  // the footgun this closes: a scoped view injects the scope, so a stray { by } would otherwise wipe ALL of A
  assert.throws(() => ctx.scoped(A).forget({ by: "human" }), /does not combine with \{ by \}/, "scoped view rejects by too (else a by-filter silently widens to a full tenant wipe)");
  // nothing was deleted by the throwing calls
  assert.deepEqual(paths(await ctx.scoped(A).recall("auth JWT tokens", { kind: "fact" })), ["fact:a"], "A's fact intact — the throw prevented an over-wide wipe");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === 10. Feature B (0.27.0) — tenant-fenced delete-by-key (AC 1–4) ===============================

test("Feature B AC1: scoped(A).forget({ id }) removes A's own row — 1 removed, A no longer has it", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await seedTwoTenants(ctx);
  assert.equal(ctx.scoped(A).forget({ id: "fact:a" }), 1, "A's own id → 1 removed");
  assert.equal(ctx.scoped(A).get("fact:a"), null, "A's row is gone");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("Feature B AC2: the FENCE, not id-matching, decides — B deleting A's id removes 0, A survives", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await seedTwoTenants(ctx);
  // B and A are distinct owners (A='user:1' is a textual PREFIX of B='user:12') — a naive id/LIKE fence
  // would leak; the physical-key fence must not. Also cross-check the SAME public id under both tenants.
  await ctx.scoped(B).remember("fact:a", "B's own note that happens to reuse A's id", { kind: "fact" });
  assert.equal(ctx.scoped(B).forget({ id: "fact:a" }), 1, "B deletes B's OWN fact:a → 1");
  assert.equal(ctx.scoped(A).forget({ id: "fact:b" }), 0, "A deleting B's id fact:b → 0 (fence, not id, decides)");
  assert.deepEqual(paths(await ctx.scoped(A).recall("auth JWT tokens", { kind: "fact" })), ["fact:a"], "A's fact:a SURVIVES — never reached by B's or by the cross-id delete");
  assert.deepEqual(paths(await ctx.scoped(B).recall("auth JWT tokens", { kind: "fact" })), ["fact:b"], "B keeps fact:b; B's reused fact:a is gone");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("Feature B AC3: { id, kind } narrows; a missing scope still THROWS under strictScope", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await seedTwoTenants(ctx);
  // id present but WRONG kind → 0 (fact:a is a fact, not an episode); right kind → 1
  assert.equal(ctx.scoped(A).forget({ id: "fact:a", kind: "episode" }), 0, "{ id, kind:'episode' } does not match the fact");
  assert.equal(ctx.scoped(A).forget({ id: "fact:a", kind: "fact" }), 1, "{ id, kind:'fact' } narrows and removes");
  // fail-closed: a base by-key delete with NO scope under strictScope is exempt (precise target), but a
  // scoped view always carries its scope, so this proves the fence path itself doesn't loosen strict.
  assert.throws(() => ctx.forget({ scope: undefined, kind: "fact" }), /requires an explicit scope/, "scope-less bulk delete still throws under strict");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("Feature B AC4: symmetry — the same (scope, id) that upserts (W4) also deletes; idPrefix drops segments", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  // W4 upsert under a scope, then delete by the SAME (scope, id) → round-trip to empty.
  await ctx.scoped(A).remember("fact:w4", "first value", { kind: "fact" });
  await ctx.scoped(A).remember("fact:w4", "superseded value", { kind: "fact" }); // W4 upsert-in-place
  assert.equal(ctx.scoped(A).forget({ id: "fact:w4" }), 1, "the (scope, id) that upserts also deletes → exactly 1 row");
  assert.equal(ctx.scoped(A).get("fact:w4"), null, "round-tripped to empty");
  // idPrefix drops a base id and its #segment siblings, tenant-fenced (chunked doc-in-memory shape).
  await ctx.scoped(A).remember("note:big", "root", { kind: "fact" });
  await ctx.scoped(A).remember("note:big#0", "seg 0", { kind: "fact" });
  await ctx.scoped(A).remember("note:big#1", "seg 1", { kind: "fact" });
  await ctx.scoped(B).remember("note:big", "B's own note:big — must survive", { kind: "fact" });
  assert.equal(ctx.scoped(A).forget({ idPrefix: "note:big" }), 3, "A's base + 2 segments dropped");
  assert.equal(ctx.scoped(B).get("note:big").text, "B's own note:big — must survive", "B's same-id row untouched by A's idPrefix delete");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
