// Feature A (0.27.0) — surface the raw semantic cosine on recall hits (fact/episode, embeddings mode).
// Uses an INJECTED synonym-stub embedder (hermetic, no model download): a query can be semantically
// identical to a fact while sharing ZERO lexical terms, so `hit.score` (BM25/blended) is ~0 while
// `hit.cosine` is high — proving the surfaced value IS the semantic similarity, not a re-normalized
// blend. The value is UNBLESSED (raw [-1,1], no threshold implied); these pin the mechanism, the
// aggregate separation, its match to an independent cosine, and its ABSENCE in BM25-only mode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import { cosine } from "../src/embedder.js";

// refund/money words → dim 0, login words → dim 1, deploy words → dim 2 (normalized). A query and a
// fact drawn from the same family are cosine-1 while sharing no token; from different families, cosine-0.
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

/** @param {object} opts @param {(ctx: LiteCtx) => Promise<void>} fn */
async function withCtx(opts, fn) {
  const root = mkdtempSync(join(tmpdir(), "litectx-cosine-"));
  const ctx = new LiteCtx({ root, dbPath: join(root, "db.sqlite"), embedder: synonymStub(), ...opts });
  try {
    await fn(ctx);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("Feature A AC1: a zero-lexical-overlap semantic match surfaces a HIGH cosine where score is ~0", async () => {
  await withCtx({ embeddings: true }, async (ctx) => {
    await ctx.remember("fact:refund", "issue a reimburse to the customer", { kind: "fact" });
    // query shares NO token with the fact but the same "refund" semantic family → KNN-nominated
    const hits = await ctx.recall("money cash returned", { kind: "fact", n: 5 });
    assert.equal(hits.length, 1, "the fact is reachable by meaning alone (lexical gate would return nothing)");
    const h = hits[0];
    assert.ok(h.cosine > 0.9, `cosine is the semantic value, HIGH on a synonym match (got ${h.cosine})`);
    assert.ok(!(h.score > 0.001), `score is BM25-blind on zero shared tokens — cosine, not score, carries the signal (score ${h.score})`);
  });
});

test("Feature A AC2: aggregate separation — a related hit's cosine sits well above an unrelated hit's", async () => {
  await withCtx({ embeddings: true }, async (ctx) => {
    // both facts share the lexical filler "customer" (so both enter the BM25 pool), but only one is in
    // the query's semantic family — the cosine, not the score, tells them apart.
    await ctx.remember("fact:refund", "customer reimburse the money", { kind: "fact" });
    await ctx.remember("fact:login", "customer login and authenticate", { kind: "fact" });
    const hits = await ctx.recall("customer money cash refund", { kind: "fact", n: 5 });
    const byId = Object.fromEntries(hits.map((h) => [h.path, h.cosine]));
    assert.ok(byId["fact:refund"] > 0.9, `related hit cosine high (got ${byId["fact:refund"]})`);
    assert.ok(byId["fact:login"] < 0.35, `unrelated hit cosine low (got ${byId["fact:login"]})`);
    assert.ok(byId["fact:refund"] - byId["fact:login"] > 0.5, "the two classes separate on cosine");
  });
});

test("Feature A AC4: the surfaced cosine equals an independent cosine(embed(query), embed(body)) to float tolerance", async () => {
  await withCtx({ embeddings: true }, async (ctx) => {
    const body = "issue a reimburse to the customer";
    await ctx.remember("fact:refund", body, { kind: "fact" });
    const query = "money cash returned";
    const hits = await ctx.recall(query, { kind: "fact", n: 5 });
    const stub = synonymStub();
    const independent = cosine(await stub.embed(query), await stub.embed(body));
    assert.ok(Math.abs(hits[0].cosine - independent) < 1e-6, `surfaced ${hits[0].cosine} ≈ independent ${independent} — it IS the query↔hit cosine`);
  });
});

test("Feature A: memory-axis only — code recall (embeddings on) surfaces NO cosine, even though cosine re-ranks it internally", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-cosine-code-"));
  writeFileSync(join(root, "auth.js"), "export function reimburseMoney(customer) { return refund(customer); }\n");
  const ctx = new LiteCtx({ root, dbPath: join(root, "db.sqlite"), embedder: synonymStub(), embeddings: true, include: [".js"] });
  try {
    await ctx.index();
    const hits = await ctx.recall("reimburseMoney", { kind: "code", n: 5 });
    assert.ok(hits.length >= 1, "code hit found");
    assert.equal("cosine" in hits[0], false, "code hits carry no surfaced cosine (doctrine: gated re-rank signal, not a score)");
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Feature A AC3: BM25-only mode (tier off) surfaces NO cosine field — absent, not a surprise value", async () => {
  await withCtx({ embeddings: false }, async (ctx) => {
    await ctx.remember("fact:refund", "issue a reimburse to the customer", { kind: "fact" });
    const hits = await ctx.recall("reimburse customer", { kind: "fact", n: 5 });
    assert.ok(hits.length >= 1, "found lexically");
    assert.equal("cosine" in hits[0], false, "no cosine key when the embeddings tier is off");
    assert.equal(hits[0].cosine, undefined, "cosine is absent, not 0 or NaN");
  });
});
