// POC (slice 11 gate): does a vector-KNN UNION into the BM25-gated pool lift PARA recall on the
// memory-facts bench WITHOUT hurting EXACT/MORPH? Prototype inline (not in src/), real model,
// sweep K (nominee count) × T (min-cosine admission threshold). Throwaway — never ship the POC.
//
//   node poc/knn-union-poc.mjs
//
// Union design under test (mirrors src/index.js _rankKind fusion):
//   pool = FTS-gated dual-score candidates (today's behavior)
//   knn  = top-K stored vectors by cosine(query), kind-scoped, cosine ≥ T, not already in pool
//   fuse = minmax(dual over pool∪knn, knn dual = pool floor) + 1.0 · minmax(cosine over pool∪knn)
import ds from "./datasets/memory-facts.mjs";
import { LiteCtx } from "../src/index.js";
import { ftsMatch } from "../src/tokenize.js";
import { cosine } from "../src/embedder.js";

const ctx = new LiteCtx({ root: process.cwd(), dbPath: ":memory:", embeddings: true });
for (const f of ds.facts) await ctx.remember(f.id, f.text, { kind: "fact" });
for (const e of ds.episodes ?? []) await ctx.remember(e.id, e.text, { kind: "episode" });

/** all stored vectors for one written kind: [{path, vec}] */
function kindVectors(kind) {
  const rows = ctx.store.db
    .prepare("SELECT m.path FROM mem m JOIN file_embeddings e ON e.path = m.path WHERE m.kind = ?")
    .all(kind)
    .map((r) => r.path);
  const vecs = ctx.store.getEmbeddings(rows);
  return rows.map((path) => ({ path, vec: vecs.get(path) }));
}

const minmax = (a) => {
  const lo = Math.min(...a), hi = Math.max(...a);
  return a.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 1));
};

/** today's tier-on recall + prototype union; returns ranked paths */
async function unionRecall(q, kind, n, K, T) {
  const match = ftsMatch(q);
  const qvec = await ctx._embedQuery(q);
  const pool = match ? ctx.store.search(match, kind, Math.max(n, 400), 0.3) : [];
  const seen = new Set(pool.map((h) => h.path));
  const knn = kindVectors(kind)
    .filter((r) => !seen.has(r.path))
    .map((r) => ({ path: r.path, cos: cosine(qvec, r.vec) }))
    .filter((r) => r.cos >= T)
    .sort((a, b) => b.cos - a.cos)
    .slice(0, K);
  if (pool.length + knn.length === 0) return [];
  const floor = pool.length ? Math.min(...pool.map((h) => h.score)) : 0;
  const cand = [
    ...pool.map((h) => ({ path: h.path, dual: h.score, cos: null })),
    ...knn.map((r) => ({ path: r.path, dual: floor, cos: r.cos })),
  ];
  const vecs = ctx.store.getEmbeddings(cand.map((c) => c.path));
  const sN = minmax(cand.map((c) => c.dual));
  const cN = minmax(cand.map((c) => c.cos ?? cosine(qvec, vecs.get(c.path))));
  return cand
    .map((c, i) => ({ path: c.path, f: sN[i] + 1.0 * cN[i] }))
    .sort((a, b) => b.f - a.f)
    .slice(0, n)
    .map((c) => c.path);
}

async function score(K, T) {
  const mrr = { exact: [], morph: [], para: [] };
  for (const Q of ds.queries) {
    const kind = Q.target.startsWith("ep:") ? "episode" : "fact";
    const ranked = await unionRecall(Q.q, kind, 10, K, T);
    const rank = ranked.indexOf(Q.target) + 1;
    mrr[Q.cat].push(rank ? 1 / rank : 0);
  }
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  return { exact: avg(mrr.exact), morph: avg(mrr.morph), para: avg(mrr.para) };
}

console.log("memory-facts · union sweep (baseline tier-on: exact 1.000 / morph 0.722 / para 0.000)");
for (const K of [4, 8]) {
  for (const T of [0, 0.25, 0.35]) {
    const r = await score(K, T);
    console.log(
      `  K=${K} T=${T.toFixed(2)}  exact ${r.exact.toFixed(3)}  morph ${r.morph.toFixed(3)}  para ${r.para.toFixed(3)}`
    );
  }
}
ctx.close();
