// Embeddings POC (PRD §11, post-v1 tier gate) — does adding a semantic embedding signal to the
// shipped dual recall (BM25 + 1-hop import-spreading) measurably lift MRR on litectx's OWN benches?
//
// Round 1 answered the LIFT gate (tri-hybrid >> dual on aurora + gitdone). Round 2 (this) validates
// the BUILD claims before shipping to src/ (POC-first; never ship the POC):
//   (A) representation: a DISTILLED signal (filename + symbol names + signature/heading lines) ≥
//       raw HEAD-truncation? (distilled fits the 512-token cap without dropping a long file's tail.)
//   (B) weight generalization: pick a fusion weight on the TUNING repos (aurora, gitdone) and confirm
//       it holds on a HELD-OUT repo (multis) — the slice-4 overfitting-cliff guard.
//   (C) search latency: query-embed + brute-force cosine over the BM25-gated pool stays fast.
//
// Design mirrors the intended tier: BM25 gates a pool, embeddings RE-RANK within it. Local ONNX
// model (Xenova/all-MiniLM-L6-v2) via transformers.js — open-source, in-process, no vendor lock-in.
//
// Usage: node embeddings-poc.mjs            (aurora gitdone multis)  |  node embeddings-poc.mjs multis

import { existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { performance } from "node:perf_hooks";
import { pipeline } from "@xenova/transformers";
import { LiteCtx } from "../src/index.js";

const TUNING = ["aurora", "gitdone"];
const DATASETS = process.argv.slice(2).length ? process.argv.slice(2) : [...TUNING, "multis"];
const DEPTH = 400;                            // BM25-gated pool the embeddings re-rank within
const WEIGHTS = [0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0];
const MAXCHARS = 6000;
const REPS = ["head", "distilled"];

const rr = (r) => (r === Infinity ? 0 : 1 / r);
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const norm = (arr) => { const lo = Math.min(...arr), hi = Math.max(...arr); return arr.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 1)); };
const mrrOf = (ranks) => ranks.reduce((s, r) => s + rr(r), 0) / ranks.length;

console.log("loading embedding model (Xenova/all-MiniLM-L6-v2)…");
const embed = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
const vec = async (text) => Array.from((await embed((text || " ").slice(0, MAXCHARS), { pooling: "mean", normalize: true })).data);

// distilled signal for a file: filename stem + each node's symbol + its signature/heading source line.
// Uses the substrate litectx already builds (nodes) — no raw bodies, fits the token budget (aurora's
// "embed name+signature, not raw code" lesson, applied at file granularity).
function distill(store, path, raw) {
  const lines = raw.split("\n");
  const parts = [basename(path).replace(/\.[^.]+$/, "")];
  for (const n of store.nodesForPath(path)) {
    if (n.symbol) parts.push(n.symbol);
    const sig = (lines[n.start_line] || "").trim();
    if (sig) parts.push(sig);
  }
  return parts.join("\n");
}

/** @type {Record<string, Record<string, {dual:number, tri:Record<number,{mrr:number,rescued:number,hurt:number}>, semOnly:number, searchMs:number}>>} */
const results = {};

for (const name of DATASETS) {
  const ds = (await import(`./datasets/${name}.mjs`)).default;
  const root = ds.roots.find(existsSync);
  if (!root) { console.log(`\n[${name}] repo not found — skipped`); continue; }

  const ctx = new LiteCtx({ root, include: ds.include, pathspecs: ds.pathspecs, dbPath: ":memory:" });
  await ctx.index();

  // dual baseline + per-query candidate pools (the shipped recall).
  const perQ = [];
  for (const Q of ds.queries) {
    const hits = (await ctx.recall(Q.q, { kind: "code", n: DEPTH }));
    const di = hits.findIndex((h) => h.path === Q.target);
    perQ.push({ Q, hits, dualRank: di < 0 ? Infinity : di + 1 });
  }
  const dualMRR = mrrOf(perQ.map((x) => x.dualRank));

  // pooled candidate files → both representations (read each file once), while ctx is open.
  const files = new Set();
  for (const x of perQ) for (const h of x.hits) files.add(h.path);
  const text = { head: new Map(), distilled: new Map() };
  for (const f of files) {
    let raw = ""; try { raw = readFileSync(join(root, f), "utf8"); } catch { /* skip */ }
    text.head.set(f, raw.slice(0, MAXCHARS));
    text.distilled.set(f, distill(ctx.store, f, raw));
  }
  ctx.close();

  results[name] = {};
  for (const rep of REPS) {
    // embed candidate files (this rep) + each query once.
    const fvec = new Map();
    for (const f of files) fvec.set(f, await vec(text[rep].get(f)));

    // precompute, per query: normalized dual score + normalized cosine over the SAME pool.
    // also time the SEARCH-side work (query embed + cosine), which is what runs per query at runtime.
    let searchMs = 0;
    for (const x of perQ) {
      const t0 = performance.now();
      const qv = await vec(x.Q.q);
      const cs = x.hits.map((h) => cos(qv, fvec.get(h.path)));
      searchMs += performance.now() - t0;
      x.scN = norm(x.hits.map((h) => h.score));
      x.csN = norm(cs);
      x.cosRaw = cs;
    }

    // sweep fusion weights: fused = dualNorm + w·cosNorm.
    const tri = {};
    for (const w of WEIGHTS) {
      const ranks = [], dr = [];
      let rescued = 0, hurt = 0;
      for (const x of perQ) {
        const fused = x.hits.map((h, i) => ({ p: h.path, f: x.scN[i] + w * x.csN[i] })).sort((a, b) => b.f - a.f);
        const i = fused.findIndex((h) => h.p === x.Q.target);
        const tr = i < 0 ? Infinity : i + 1; ranks.push(tr);
        if (tr < x.dualRank) rescued++; if (tr > x.dualRank) hurt++;
      }
      tri[w] = { mrr: mrrOf(ranks), rescued, hurt };
    }
    // pure-semantic reference (cosine only).
    const semRanks = perQ.map((x) => {
      const fused = x.hits.map((h, i) => ({ p: h.path, f: x.cosRaw[i] })).sort((a, b) => b.f - a.f);
      const i = fused.findIndex((h) => h.p === x.Q.target); return i < 0 ? Infinity : i + 1;
    });
    results[name][rep] = { dual: dualMRR, tri, semOnly: mrrOf(semRanks), searchMs: searchMs / perQ.length };
  }
}

// ---- report ----
for (const name of Object.keys(results)) {
  const tag = TUNING.includes(name) ? "tuning" : "HELD-OUT";
  console.log(`\n[${name}] (${tag})`);
  for (const rep of REPS) {
    const r = results[name][rep];
    console.log(`  rep=${rep.padEnd(9)} dual ${r.dual.toFixed(3)} · sem-only ${r.semOnly.toFixed(3)} · search ${r.searchMs.toFixed(1)} ms/query`);
    const cells = WEIGHTS.map((w) => { const t = r.tri[w]; const d = t.mrr - r.dual; return `w${w}:${t.mrr.toFixed(3)}(${d >= 0 ? "+" : ""}${d.toFixed(3)})`; });
    console.log(`             ${cells.join("  ")}`);
  }
}
console.log("\n(distilled vs head: compare same-weight MRR. held-out cliff: watch multis lift turn negative as w rises.)");
