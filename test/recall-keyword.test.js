// `Hit.keyword`: true = the hit matched a query word (FTS/BM25 pool); false = added by meaning only
// (a KNN nominee — fact/episode, embeddings on). Needed because `score` is the fused ordering value, so a
// meaning-only nominee scores > 0 and `score > 0` no longer means "matched a word".
// Deterministic synonym stub: refund/money/cash → dim 0, login → dim 1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const stub = {
  /** @param {string} text */
  async embed(text) {
    const t = text.toLowerCase();
    const v = [/refund|money|cash/g, /login/g].map((re) => (t.match(re) || []).length);
    const n = Math.hypot(...v) || 1;
    return Float32Array.from(v.map((x) => x / n));
  },
};

// Shares the query word "refund" but is mostly login text → LOW cosine to the query.
const LEXICAL = "refund login login login login login login";
// Zero shared term with the query "refund", but same meaning family → cosine 1 (KNN nominee).
const NOMINEE = "money cash back";

async function withCtx(embeddings, fn) {
  const root = mkdtempSync(join(tmpdir(), "litectx-keyword-"));
  writeFileSync(join(root, "lex.js"), `export function lex() { return "${LEXICAL}"; }\n`);
  writeFileSync(join(root, "lex.md"), `# Lex\n\n${LEXICAL}\n`);
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings, embedder: stub });
  try {
    await ctx.index();
    await ctx.remember("f:lex", LEXICAL, { kind: "fact" });
    await ctx.remember("f:nom", NOMINEE, { kind: "fact" });
    await fn(ctx);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const by = (hits, p) => hits.find((h) => h.path === p);

for (const kind of ["fact", "code", "doc"]) {
  test(`AC1: a hit sharing a query word is keyword:true even at LOW cosine (${kind}, embeddings on)`, async () => {
    await withCtx(true, async (ctx) => {
      const hits = await ctx.recall("refund", { kind });
      const lex = hits.find((h) => h.path.includes("lex"));
      assert.ok(lex, "lexical hit returned");
      assert.equal(lex.keyword, true);
      if (kind === "fact") assert.ok(lex.cosine < 0.5, `fixture has low cosine (got ${lex.cosine})`);
    });
  });
}

test("AC2: a meaning-only KNN nominee is keyword:false (and still scores > 0)", async () => {
  await withCtx(true, async (ctx) => {
    const hits = await ctx.recall("refund", { kind: "fact" });
    const nom = by(hits, "f:nom");
    assert.ok(nom, "nominee returned");
    assert.equal(nom.keyword, false);
    assert.ok(nom.score > 0, `nominee scores > 0 (got ${nom.score}) — why score>0 can't mean 'matched a word'`);
    assert.equal(by(hits, "f:lex").keyword, true);
  });
});

for (const kind of ["fact", "code", "doc"]) {
  test(`AC3: BM25-only mode — every hit is keyword:true (${kind})`, async () => {
    await withCtx(false, async (ctx) => {
      const hits = await ctx.recall("refund", { kind });
      assert.ok(hits.length >= 1);
      assert.ok(hits.every((h) => h.keyword === true));
    });
  });
}

test("grouped recall + scoped view carry keyword on every hit", async () => {
  await withCtx(true, async (ctx) => {
    const g = await ctx.recall("refund");
    const all = Object.values(g).flat();
    assert.ok(all.length >= 3);
    assert.ok(all.every((h) => typeof h.keyword === "boolean"));
    assert.equal(by(g.fact, "f:nom").keyword, false);
    const sv = await ctx.scoped("t1").recall("refund", { kind: "fact" });
    assert.ok(sv.every((h) => typeof h.keyword === "boolean"));
  });
});

test("recentMemory / enumerate / get do NOT carry keyword", async () => {
  await withCtx(false, async (ctx) => {
    for (const h of await ctx.recentMemory({ kind: "fact" })) assert.equal("keyword" in h, false);
    for (const h of (await ctx.enumerate({ kind: "fact" })).items) assert.equal("keyword" in h, false);
    assert.equal("keyword" in (await ctx.get("f:lex")), false);
  });
});
