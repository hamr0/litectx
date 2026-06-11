// Slice 11 integration tests — the KNN union: for written kinds, cosine NOMINATES candidates into
// the recall pool instead of only re-ranking what the lexical gate found. Exercised with an
// INJECTED stub embedder (hermetic, no model) mapping synonym families to shared vector
// dimensions, so a query can be semantically close to a fact while sharing ZERO lexical terms —
// the exact case the gate alone can never return. The real model's lift is the bench's job
// (poc/memory-bench.mjs --embeddings); these pin the mechanism and its boundaries: union is
// tier-only, written-kinds-only, deduped, capped, lexical-first, and safe on vectorless rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

// Synonym families on separate dimensions: "refund"-words and "money"-words land on dim 0,
// "login"-words on dim 1 — so "cash returned" ≈ a refunds fact with no shared token or stem.
function synonymStub() {
  const DIMS = [/refund|money|cash|reimburse/g, /login|signin|authenticate/g, /deploy|release|ship/g];
  return {
    /** @param {string} text */
    async embed(text) {
      const v = DIMS.map((re) => (text.toLowerCase().match(re) || []).length);
      const n = Math.hypot(...v) || 1;
      return Float32Array.from(v.map((x) => x / n));
    },
  };
}

/** @param {object} opts @param {(ctx: LiteCtx, root: string) => Promise<void>} fn */
async function withCtx(opts, fn) {
  const root = mkdtempSync(join(tmpdir(), "litectx-knn-"));
  const ctx = new LiteCtx({ root, dbPath: join(root, "db.sqlite"), embedder: synonymStub(), ...opts });
  try {
    await fn(ctx, root);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("a zero-shared-term paraphrase reaches a fact — cosine nominates, the gate no longer decides alone", async () => {
  await withCtx({ embeddings: true }, async (ctx) => {
    await ctx.remember("fact:returns", "Refunds are honored within thirty days of purchase.", { kind: "fact" });
    await ctx.remember("fact:auth", "Login uses signin tokens.", { kind: "fact" });
    // "cash reimbursed" shares no token and no stem with either fact — pure semantics
    const hits = await ctx.recall("cash reimbursed", { kind: "fact" });
    assert.equal(hits[0]?.path, "fact:returns", "nominated on cosine alone");
    assert.ok(!hits.some((h) => h.path === "fact:auth"), "an unrelated fact is not dragged in: cosine 0 still ranks it, so the cap and order matter — auth scores 0 on dim 0");
  });
});

test("the union is tier-only: the same paraphrase with embeddings off returns nothing", async () => {
  await withCtx({ embeddings: true }, async (ctx, root) => {
    await ctx.remember("fact:returns", "Refunds are honored within thirty days of purchase.", { kind: "fact" });
    const off = new LiteCtx({ root, dbPath: join(root, "db.sqlite"), embedder: synonymStub() }); // embeddings: false
    assert.deepEqual(await off.recall("cash reimbursed", { kind: "fact", log: false }), [], "gate-only without the tier");
    off.close();
  });
});

test("lexical hits keep their head start — a near-synonym nominee ranks behind the lexical match", async () => {
  await withCtx({ embeddings: true }, async (ctx) => {
    await ctx.remember("fact:lexical", "Money refunds take thirty days.", { kind: "fact" }); // shares "money" with the query
    // no shared term; the trailing "login" tilts its vector slightly off the query's dimension
    await ctx.remember("fact:nominee", "Cash is reimbursed on request after login.", { kind: "fact" });
    const hits = await ctx.recall("money returned", { kind: "fact" });
    assert.deepEqual(
      hits.map((h) => h.path),
      ["fact:lexical", "fact:nominee"],
      "both reachable; the lexically-matched fact stays first"
    );
  });
});

test("dedup: an item that is both a lexical hit and the nearest vector appears exactly once", async () => {
  await withCtx({ embeddings: true }, async (ctx) => {
    await ctx.remember("fact:returns", "Refunds for money-back requests take thirty days.", { kind: "fact" });
    const hits = await ctx.recall("money refund", { kind: "fact" });
    assert.equal(hits.filter((h) => h.path === "fact:returns").length, 1);
  });
});

test("written kinds only: code recall stays strictly gated even with the tier on", async () => {
  await withCtx({ embeddings: true }, async (ctx, root) => {
    writeFileSync(join(root, "pay.js"), "export function reimburse(x) { return x; } // cash refund money\n");
    await ctx.index();
    // semantically adjacent (dim 0) but zero shared tokens with the file body
    assert.deepEqual(await ctx.recall("dollars sent back", { kind: "code" }), [], "no nomination for code — gate-then-rerank unchanged");
  });
});

test("rows written while the tier was off have no vector and never nominate (mixed store is safe)", async () => {
  await withCtx({ embeddings: true }, async (ctx, root) => {
    const off = new LiteCtx({ root, dbPath: join(root, "db.sqlite"), embedder: synonymStub() });
    await off.remember("fact:unembedded", "Reimburse cash quickly.", { kind: "fact" }); // tier off → no vector
    off.close();
    await ctx.remember("fact:embedded", "Refunds are honored within thirty days.", { kind: "fact" });
    const hits = await ctx.recall("money returned", { kind: "fact" });
    assert.deepEqual(hits.map((h) => h.path), ["fact:embedded"], "only the embedded row nominates; no crash on the vectorless one");
  });
});

test("episodes nominate too, scoped to their own kind", async () => {
  await withCtx({ embeddings: true }, async (ctx) => {
    await ctx.remember("ep:rollout", "Shipped the new build to production.", { kind: "episode", occurredAt: 1000 });
    await ctx.remember("fact:returns", "Refunds take thirty days.", { kind: "fact" });
    const eps = await ctx.recall("release went out", { kind: "episode" }); // "release" ≈ "shipped" (dim 2), no shared term
    assert.equal(eps[0]?.path, "ep:rollout");
    assert.ok(!eps.some((h) => h.path === "fact:returns"), "fact never crosses into the episode ranking");
  });
});

test("nominees are capped at KNN_K (8) — a pure-semantic query can't flood the result", async () => {
  await withCtx({ embeddings: true }, async (ctx) => {
    for (let i = 0; i < 12; i++) await ctx.remember(`fact:m${i}`, `Money cash refund variant ${i}.`, { kind: "fact" });
    const hits = await ctx.recall("reimburse", { kind: "fact", n: 20 }); // no shared term → all 12 are nominee-eligible
    assert.ok(hits.length > 0 && hits.length <= 8, `pool empty → at most KNN_K nominees (got ${hits.length})`);
  });
});
