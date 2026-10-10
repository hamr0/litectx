// Regression: a recall hit's `score` is the value its list is ordered by. With embeddings on, the
// order is the fused `minmax(bm25+spread) + embedWeight·minmax(cosine)`; `score` used to stay the
// pre-fusion BM25 value, so the printed numbers could increase down the list (0.54 above 1.00).
// Corpus is built so BM25 order and fused order DISAGREE (asserted below, so the test can't pass
// vacuously): "alpha" is the BM25 winner (many query terms, short), "beta" the semantic winner.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

// Deterministic fake: anything mentioning "sprocket" (and the bare query "widget") is the [1,0] family.
const stub = {
  /** @param {string} text */
  async embed(text) {
    return Float32Array.from(/sprocket/.test(text) || text.trim() === "widget" ? [1, 0] : [0, 1]);
  },
};

const FILLER = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor";
const ALPHA = "widget widget widget widget widget";
const BETA = `widget sprocket ${FILLER} ${FILLER}`;

async function withCtx(embeddings, fn) {
  const root = mkdtempSync(join(tmpdir(), "litectx-scoreorder-"));
  writeFileSync(join(root, "alpha.js"), `export function alpha() { return "${ALPHA}"; }\n`);
  writeFileSync(join(root, "beta.js"), `export function beta() { return "${BETA}"; }\n`);
  writeFileSync(join(root, "alpha.md"), `# Alpha\n\n${ALPHA}\n`);
  writeFileSync(join(root, "beta.md"), `# Beta\n\n${BETA}\n`);
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings, embedder: stub, embedWeight: 2 });
  try {
    await ctx.index();
    await ctx.remember("f:alpha", ALPHA, { kind: "fact" });
    await ctx.remember("f:beta", BETA, { kind: "fact" });
    await fn(ctx);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const nonIncreasing = (hits) => hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score);

for (const kind of ["code", "doc", "fact"]) {
  test(`recall score is the ordering value, ${kind} kind, embeddings on`, async () => {
    let bm25Order;
    await withCtx(false, async (ctx) => {
      bm25Order = (await ctx.recall("widget", { kind })).map((h) => h.path);
    });
    await withCtx(true, async (ctx) => {
      const hits = await ctx.recall("widget", { kind });
      const order = hits.map((h) => h.path);
      assert.ok(order.length >= 2, "both candidates returned");
      assert.notDeepEqual(order, bm25Order, "fixture exercises a BM25-vs-fused disagreement");
      assert.ok(order[0].includes("beta") || order[0] === "f:beta", `fused order puts the semantic winner first (got ${order})`);
      assert.ok(nonIncreasing(hits), `score non-increasing down the list: ${hits.map((h) => h.score)}`);
      assert.ok(hits[0].score > hits[1].score, "the fused winner scores strictly higher");
    });
  });
}

// Embeddings OFF: `score` follows the same definition for every kind — BM25 scaled per query to
// [0,1] (top lexical hit = 1), plus import spreading for code. Raw -bm25 used to leak through for
// fact/episode and for any single-hit list (a lone top hit printed 0.00). The fixture has no import
// edges, so the code top hit is exactly 1 (spread adds 0).
const SPREAD_MAX = 0.3; // SPREAD_WEIGHT in src/index.js

async function withEpisodes(fn) {
  const root = mkdtempSync(join(tmpdir(), "litectx-scoreorder-"));
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  try {
    await ctx.remember("e:alpha", ALPHA, { kind: "episode" });
    await ctx.remember("e:beta", BETA, { kind: "episode" });
    await fn(ctx);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const checkScaled = (hits, label) => {
  assert.ok(hits.length >= 2, `${label}: multi-hit list`);
  assert.equal(hits[0].score, 1, `${label}: top lexical hit scores exactly 1 (got ${hits.map((h) => h.score)})`);
  assert.ok(nonIncreasing(hits), `${label}: non-increasing ${hits.map((h) => h.score)}`);
  for (const h of hits) assert.ok(h.score >= 0 && h.score <= 1 + SPREAD_MAX, `${label}: ${h.score} within [0, 1+spread]`);
};

for (const kind of ["code", "doc", "fact"]) {
  test(`recall score is BM25 scaled to [0,1], ${kind} kind, embeddings off`, async () => {
    await withCtx(false, async (ctx) => {
      checkScaled(await ctx.recall("widget", { kind }), kind);
    });
  });
}

test("recall score is BM25 scaled to [0,1], episode kind, embeddings off", async () => {
  await withEpisodes(async (ctx) => checkScaled(await ctx.recall("widget", { kind: "episode" }), "episode"));
});

for (const kind of ["code", "doc", "fact", "episode"]) {
  test(`a single-hit list scores exactly 1, ${kind} kind, embeddings off`, async () => {
    const run = async (ctx) => {
      const hits = await ctx.recall("sprocket", { kind }); // only beta carries "sprocket"
      assert.equal(hits.length, 1, "exactly one hit");
      assert.equal(hits[0].score, 1, "lone top hit scores 1, not raw BM25 (~0)");
    };
    if (kind === "episode") await withEpisodes(run);
    else await withCtx(false, run);
  });
}

// Embeddings ON, ONE candidate: minmax of a single element is 1 for both the lexical and the cosine
// term, so the fused score is exactly 1 + embedWeight (2 in withCtx → 3). A `cand.length < 2`
// early return used to hand back the raw pre-fusion score here.
const EMBED_WEIGHT = 2; // embedWeight in withCtx

for (const kind of ["code", "doc", "fact"]) {
  test(`a single lexical hit scores exactly 1 + embedWeight, ${kind} kind, embeddings on`, async () => {
    await withCtx(true, async (ctx) => {
      const hits = await ctx.recall("sprocket", { kind }); // only beta carries "sprocket"; alpha's cosine is 0 so no KNN nominee
      assert.equal(hits.length, 1, "exactly one candidate");
      assert.equal(hits[0].score, 1 + EMBED_WEIGHT);
    });
  });
}

test("a lone KNN nominee (no lexical match) scores exactly 1 + embedWeight, fact kind, embeddings on", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-scoreorder-"));
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: true, embedder: stub, embedWeight: EMBED_WEIGHT });
  try {
    await ctx.remember("f:only", "lorem ipsum", { kind: "fact" }); // embeds [0,1]
    const hits = await ctx.recall("gizmo", { kind: "fact" }); // no shared term; [0,1] query → cosine 1 → nominated
    assert.equal(hits.length, 1, "the nominee is the only candidate");
    assert.equal(hits[0].path, "f:only");
    // empty pool → floor 0, sN = minmax([0]) = [1]; cN = minmax([1]) = [1] → 1 + embedWeight
    assert.equal(hits[0].score, 1 + EMBED_WEIGHT);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
});
