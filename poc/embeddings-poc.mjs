// Embeddings POC (PRD §11, post-v1 tier gate) — does adding a semantic embedding signal to the
// shipped dual recall (BM25 + 1-hop import-spreading) measurably lift MRR on litectx's OWN benches?
// The "~85% → ~95%" figure is AURORA's; this validates the lift here BEFORE building the tier.
//
// Design mirrors the intended tier: BM25 gates a candidate pool, embeddings RE-RANK within it (the
// PRD's "lexical match gated, then re-weighted"). Local ONNX model via transformers.js (open-source,
// in-process, no vendor lock-in — doctrine). File-granularity to match recall's gate. Throwaway POC.
//
// Usage: node embeddings-poc.mjs            (aurora + gitdone)
//        node embeddings-poc.mjs gitdone

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "@xenova/transformers";
import { LiteCtx } from "../src/index.js";

const DATASETS = process.argv.slice(2).length ? process.argv.slice(2) : ["aurora", "gitdone"];
const DEPTH = 400;                       // BM25-gated pool the embeddings re-rank within
const WEIGHTS = [0.3, 0.5, 0.7, 1.0, 1.5];
const MAXCHARS = 6000;                    // head-truncate file text (model caps at 512 tokens anyway)

const rr = (r) => (r === Infinity ? 0 : 1 / r);
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (arr) => { const lo = Math.min(...arr), hi = Math.max(...arr); return arr.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 1)); };

console.log("loading embedding model (Xenova/all-MiniLM-L6-v2)…");
const embed = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const vec = async (text) => Array.from((await embed((text || " ").slice(0, MAXCHARS), { pooling: "mean", normalize: true })).data);

for (const name of DATASETS) {
  const ds = (await import(`./datasets/${name}.mjs`)).default;
  const root = ds.roots.find(existsSync);
  if (!root) { console.log(`\n[${name}] repo not found — skipped`); continue; }

  const ctx = new LiteCtx({ root, include: ds.include, pathspecs: ds.pathspecs, dbPath: ":memory:" });
  const t0 = Date.now();
  await ctx.index();

  // dual baseline: the shipped recall (BM25 + spreading), and the candidate pool per query.
  const perQ = [];
  for (const Q of ds.queries) {
    const hits = ctx.recall(Q.q, { kind: "code", n: DEPTH });
    const di = hits.findIndex((h) => h.path === Q.target);
    perQ.push({ Q, hits, dualRank: di < 0 ? Infinity : di + 1 });
  }
  ctx.close();
  const dualMRR = perQ.reduce((s, x) => s + rr(x.dualRank), 0) / perQ.length;

  // embed the union of all pooled candidate files once (cache), + each query once.
  const files = new Set();
  for (const x of perQ) for (const h of x.hits) files.add(h.path);
  const fvec = new Map();
  for (const f of files) { let body = ""; try { body = readFileSync(join(root, f), "utf8"); } catch { /* skip */ } fvec.set(f, await vec(body)); }
  const embedMs = Date.now() - t0;

  // precompute, per query, the normalized dual score + normalized cosine over the SAME pool.
  for (const x of perQ) {
    const qv = await vec(x.Q.q);
    x.scNorm = norm(x.hits.map((h) => h.score));
    x.csNorm = norm(x.hits.map((h) => cos(qv, fvec.get(h.path))));
  }

  // sweep fusion weight: fused = dualScoreNorm + w·cosineNorm, re-rank, MRR.
  const tri = {};
  for (const w of WEIGHTS) {
    let sum = 0, rescued = 0, hurt = 0;
    for (const x of perQ) {
      const fused = x.hits.map((h, i) => ({ path: h.path, f: x.scNorm[i] + w * x.csNorm[i] }))
        .sort((a, b) => b.f - a.f);
      const i = fused.findIndex((h) => h.path === x.Q.target);
      const triRank = i < 0 ? Infinity : i + 1;
      sum += rr(triRank);
      if (triRank < x.dualRank) rescued++;
      if (triRank > x.dualRank) hurt++;
    }
    tri[w] = { mrr: sum / perQ.length, rescued, hurt };
  }

  console.log(`\n[${name}] ${files.size} files · embed ${embedMs} ms · ${perQ.length} queries`);
  console.log(`  dual (BM25+spread)  MRR ${dualMRR.toFixed(3)}`);
  for (const w of WEIGHTS) {
    const t = tri[w], d = t.mrr - dualMRR;
    console.log(`  tri  w=${w.toFixed(1)}          MRR ${t.mrr.toFixed(3)}  (${d >= 0 ? "+" : ""}${d.toFixed(3)})  rescued ${t.rescued} · hurt ${t.hurt}`);
  }
}
console.log();
