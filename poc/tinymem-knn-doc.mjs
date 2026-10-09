// tinymem KNN-doc probe: should embeddings NOMINATE doc sections (KNN union) as they do for fact/episode?
// Read-only vs the 1x docs-only lroots. No src/ change: BASE = ctx.recall(q,{kind:"doc",n,log:false}) embeddings on (as step2-m1).
// KNN-K = the SAME recall, with store.knnCandidates overridden for kind "doc" only to return the K doc sections nearest the query by cosine
//   (doc_sections.vec; cos>0, not already in the BM25 pool, excluded by section rid), shaped like store.knnCandidates' output (score 0).
//   Fusion is then litectx's own _rankKind (src/index.js:906-946): minmax(bm25; nominees at pool floor) + embedWeight*minmax(cosine).
//   Fact/episode KNN code: src/store.js:2452-2472 (full scan of vectors, cos>0, top-K); index.js:913 unions it into the pool.
// No-overlap set: each step3 question with every word removed whose splitIdent tokens appear in the gold source lines.
// usage: node poc/tinymem-knn-doc.mjs
import { LiteCtx, splitIdent } from "../src/index.js";
import { cosine } from "../src/embedder.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const O = join(homedir(), ".cache/tinymem-probe/out"), OUT = join(O, "knn-doc");
mkdirSync(OUT, { recursive: true });
const REPOS = ["bareloop", "bareagent"], NS = [8, 20], KS = [20, 50];
const rootOf = (r) => join(O, "step2/root", r, "lroot");
const keyOf = (h) => `${h.path}:${h.a}-${h.b}`;
const parseSrc = (s) => { const m = /^(.+):(\d+)-(\d+)$/.exec(s); return { path: m[1], a: +m[2], b: +m[3] }; };
const ov = (a1, b1, a2, b2) => a1 <= b2 && a2 <= b1;
const toHits = (res) => res.map((h) => (h.chunk ? { path: h.path, a: h.chunk.startLine + 1, b: h.chunk.endLine + 1 } : { path: h.path, a: 1, b: Infinity }));
const blob = (buf) => { const u = Uint8Array.from(buf); return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4); };

const loadQ = (dir) => REPOS.flatMap((repo) => JSON.parse(readFileSync(join(O, dir, repo + ".json"), "utf8")).map((q) => ({ id: q.id, repo, question: q.question, srcs: q.sources.map(parseSrc) })));
const step2 = loadQ("step2/questions"), step3 = loadQ("step3/questions");

// ---- no-overlap queries (mechanical) ----
const noov = step3.map((q) => {
  const gold = new Set();
  for (const s of q.srcs) {
    const lines = readFileSync(join(rootOf(q.repo), s.path), "utf8").split("\n").slice(s.a - 1, s.b).join("\n");
    for (const t of splitIdent(lines)) gold.add(t);
  }
  const words = q.question.split(/\s+/), kept = [], removed = [];
  for (const w of words) (splitIdent(w).some((t) => gold.has(t)) ? removed : kept).push(w);
  return { ...q, question: kept.join(" "), orig: q.question, removed, nKept: kept.length };
});
writeFileSync(join(OUT, "noverlap-queries.json"), JSON.stringify(noov.map((q) => ({ id: q.id, query: q.question, removed: q.removed, orig: q.orig })), null, 1));
const SETS = { plain: step2, reworded: step3, "no-overlap": noov };

const stats = {}, perQ = [], noiseEx = [], timing = {};
for (const repo of REPOS) {
  const ctx = new LiteCtx({ root: rootOf(repo), embeddings: true });
  const store = ctx.store, db = store.db;
  const nSec = db.prepare("SELECT count(*) c, sum(vec IS NULL) nv FROM doc_sections").get();
  stats[repo] = { sections: nSec.c, noVec: nSec.nv };
  const secStmt = db.prepare("SELECT sec.doc_rowid rid, sec.path path, sec.vec vec, n.symbol symbol, n.node_type node_type, n.start_line sl, n.end_line el FROM doc_sections sec JOIN nodes n ON n.id = sec.node_id WHERE sec.vec IS NOT NULL");
  let mode = { K: 0, cap: 0 }, lastPoolRids = new Set(), nomRids = new Set(), nomKeys = new Set();
  const origSearch = store.search.bind(store), origKnn = store.knnCandidates.bind(store);
  store.search = (match, kind, ...r) => { let rows = origSearch(match, kind, ...r); if (kind === "doc" && mode.cap) rows = rows.slice(0, mode.cap); if (kind === "doc") lastPoolRids = new Set(rows.map((x) => Number(x.rid))); return rows; };
  store.knnCandidates = (kind, qvec, k, exclude, filter) => {
    if (kind !== "doc") return origKnn(kind, qvec, k, exclude, filter);
    if (!mode.K) return [];
    const rows = secStmt.all(); // full scan per query, as store.knnCandidates does for fact/episode
    const top = rows.filter((r) => !lastPoolRids.has(r.rid)).map((r) => ({ r, cos: cosine(qvec, blob(r.vec)) })).filter((c) => c.cos > 0).sort((a, b) => b.cos - a.cos).slice(0, mode.K);
    nomRids = new Set(top.map((c) => c.r.rid)); nomKeys = new Set(top.map((c) => `${c.r.path}:${c.r.sl + 1}-${c.r.el + 1}`));
    return top.map(({ r }) => ({ path: r.path, kind: "doc", format: "md", score: 0, git: null, rid: r.rid, source: "file", chunk: { symbol: r.symbol, nodeType: r.node_type, startLine: r.sl, endLine: r.el } }));
  };
  const run = async (q, K, cap = 0, n = 20) => { mode = { K, cap }; nomRids = new Set(); const t = performance.now(); const res = await ctx.recall(q, { kind: "doc", n, log: false }); const ms = performance.now() - t; return { hits: toHits(res), ms, nom: new Set(nomRids), keys: new Set(nomKeys), raw: res }; };
  for (const [sname, qs] of Object.entries(SETS)) for (const q of qs.filter((x) => x.repo === repo)) {
    const empty = !q.question.trim();
    if (!empty) await ctx._embedQuery(q.question); // warm query-vector cache so neither variant pays the embed
    const R = {};
    for (const K of [0, ...KS]) R[K] = empty ? { hits: [], ms: 0, nom: new Set() } : await run(q.question, K);
    let bestNom = null, ctl = null;
    if (!empty) {
      const r100 = await run(q.question, 50, 0, 100); const i = r100.hits.findIndex((h) => r100.keys.has(keyOf(h))); bestNom = i < 0 ? null : i + 1;
      for (const K of [0, 50]) { const rc = await run(q.question, K, 10, 20); (ctl ??= {})[K] = { hits: rc.hits, nomInTop8: rc.hits.slice(0, 8).filter((h) => rc.keys.has(keyOf(h))).length }; }
    }
    const m8 = (await (async () => { mode = { K: 0 }; return empty ? [] : toHits(await ctx.recall(q.question, { kind: "doc", n: 8, log: false })); })());
    const sliceOk = JSON.stringify(m8) === JSON.stringify(R[0].hits.slice(0, 8)); // BASE n=8 must equal top8 of n=20
    for (const K of [0, ...KS]) {
      const d = (timing[`${sname}/${K}`] ??= []); if (!empty) d.push(R[K].ms);
    }
    perQ.push({ bestNom, ctl, set: sname, repo, id: q.id, query: q.question, empty, sliceOk, srcs: q.srcs, R: Object.fromEntries([0, ...KS].map((K) => [K, { hits: R[K].hits, nomIdx: R[K].raw ? R[K].raw.map((h, i) => (R[K].nom.has(Number(h.rid)) ? i : -1)).filter((i) => i >= 0) : [] }])) });
  }
  ctx.close();
}
// nomIdx relies on h.rid, which dropSource strips -> recompute nominee flag below from rank diff instead if empty
const rankOf = (hits, s, n) => { for (let i = 0; i < Math.min(hits.length, n); i++) if (hits[i].path === s.path && ov(hits[i].a, hits[i].b, s.a, s.b)) return i + 1; return Infinity; };
const fin = Number.isFinite;
const lines = [], P = (s = "") => lines.push(s);
P("# tinymem KNN-doc probe: should embeddings nominate doc sections?");
P("BASE = shipped recall (BM25 pool 400, cosine re-ranks). KNN-K = same + K nearest sections by cosine unioned (score 0 -> pool floor), fused by litectx's own _rankKind. 1x docs-only lroots, bareloop+bareagent. Script: poc/tinymem-knn-doc.mjs.");
P("Sections/vectors: " + Object.entries(stats).map(([r, s]) => `${r}=${s.sections} (no vec ${s.noVec})`).join(", ") + `. BASE n=8 == top-8 of BASE n=20 in ${perQ.filter((p) => p.sliceOk).length}/${perQ.filter((p) => !p.empty).length} queries.`);
P("No-overlap queries: every question word whose tokens occur in the gold source lines removed (`noverlap-queries.json`). Empty residual queries: " + noov.filter((q) => !q.question.trim()).length + `/${noov.length}` + " (recall returns [] for them: no match -> no embedding -> no nomination; counted as misses).");
P(); P("Cell: any-gold% / all-gold% / mean rank of first gold (over questions where found; count). Miss-penalised mean rank (miss = n+1) in brackets.");
P("| set | n questions | variant | n=8 | n=20 |"); P("|---|---|---|---|---|");
const better = {};
for (const sname of Object.keys(SETS)) {
  const rows = perQ.filter((p) => p.set === sname);
  for (const K of [0, ...KS]) {
    const cells = NS.map((n) => {
      let any = 0, all = 0, firsts = [], pen = [];
      for (const p of rows) {
        const rk = p.srcs.map((s) => rankOf(p.R[K].hits, s, n)), f = Math.min(...rk);
        if (rk.some(fin)) any++; if (rk.every(fin)) all++; if (fin(f)) firsts.push(f); pen.push(fin(f) ? f : n + 1);
      }
      const m = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : "-");
      return `${(100 * any / rows.length).toFixed(0)}% / ${(100 * all / rows.length).toFixed(0)}% / ${m(firsts)} (${firsts.length}) [${m(pen)}]`;
    });
    P(`| ${sname} | ${rows.length} | ${K ? "KNN-" + K : "BASE"} | ${cells.join(" | ")} |`);
  }
  for (const K of KS) for (const n of NS) {
    let b = 0, w = 0, e = 0;
    for (const p of rows) {
      const sc = (K0) => { const rk = p.srcs.map((s) => rankOf(p.R[K0].hits, s, n)); return [rk.filter(fin).length, -Math.min(...rk.map((x) => (fin(x) ? x : 999)))]; };
      const [a1, a2] = sc(0), [b1, b2] = sc(K);
      if (b1 > a1 || (b1 === a1 && b2 > a2)) b++; else if (b1 < a1 || (b1 === a1 && b2 < a2)) w++; else e++;
    }
    (better[sname] ??= []).push(`KNN-${K} n=${n}: better ${b}, worse ${w}, same ${e}`);
  }
}
P(); P("## Better / worse vs BASE (better = more gold found in top-n, ties by earlier first-gold rank)");
for (const [s, a] of Object.entries(better)) { P(`- ${s}: ` + a.join("; ")); }
// KNN-only hits: hits in KNN list not present in the BASE n=20 candidate... define nominee = in KNN list but not in BASE pool is unknowable post-hoc; use "not in BASE top-20" as proxy for n=8 noise
P(); P("## Noise cost: KNN-only hits (not in BASE top-20) that displaced a BASE top-8 gold hit out of the KNN top-8");
let nEx = 0, nDisp = 0;
for (const p of perQ) for (const K of KS) {
  const base = p.R[0].hits, knn = p.R[K].hits, b20 = new Set(base.map(keyOf));
  const lost = p.srcs.filter((s) => fin(rankOf(base, s, 8)) && !fin(rankOf(knn, s, 8)));
  if (!lost.length) continue;
  nDisp++;
  if (nEx < 12) { nEx++; P(`- [${p.set}] ${p.id} KNN-${K}: gold ${lost.map((s) => `${s.path}:${s.a}-${s.b}`).join(", ")} was BASE rank ${rankOf(base, lost[0], 8)}, now outside top 8. KNN top-8 new-to-BASE entries: ` + (knn.slice(0, 8).filter((h) => !b20.has(keyOf(h))).map((h) => `${h.path}:${h.a}-${h.b}`).join("; ") || "(none: demoted by reordering)")); }
}
P(`Total (question, K) cases where a BASE top-8 gold fell out of KNN top-8: ${nDisp} of ${perQ.length * KS.length}.`);
P(); P("## KNN-only hits in top-8 (not in BASE top-20): count per set/variant (mean per query)");
for (const sname of Object.keys(SETS)) for (const K of KS) {
  const rows = perQ.filter((p) => p.set === sname && !p.empty);
  const c = rows.map((p) => { const b = new Set(p.R[0].hits.map(keyOf)); return p.R[K].hits.slice(0, 8).filter((h) => !b.has(keyOf(h))).length; });
  const hitGold = rows.map((p) => p.R[K].hits.slice(0, 8).filter((h) => !new Set(p.R[0].hits.map(keyOf)).has(keyOf(h)) && p.srcs.some((s) => s.path === h.path && ov(h.a, h.b, s.a, s.b))).length);
  P(`- ${sname} KNN-${K}: ${(c.reduce((a, b) => a + b, 0) / rows.length).toFixed(2)} new entries per top-8; of those, gold: ${hitGold.reduce((a, b) => a + b, 0)} total`);
}
P(); P("## Time per query (ms, mean over non-empty queries, query vector pre-cached; includes per-query full scan of section vectors for KNN)");
P("| set | BASE | KNN-20 | KNN-50 |"); P("|---|---|---|---|");
const mm = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
for (const s of Object.keys(SETS)) P(`| ${s} | ${mm(timing[`${s}/0`])} | ${mm(timing[`${s}/20`])} | ${mm(timing[`${s}/50`])} |`);
P(); P("## Why nothing changes: best fused rank of any KNN-50 nominee (recall n=100), and a starved-pool control");
for (const sname of Object.keys(SETS)) {
  const rows = perQ.filter((p) => p.set === sname && !p.empty), br = rows.map((p) => p.bestNom);
  P(`- ${sname}: nominee anywhere in top-100 for ${br.filter((x) => x).length}/${rows.length} queries; in top-20 for ${br.filter((x) => x && x <= 20).length}; in top-8 for ${br.filter((x) => x && x <= 8).length}. BM25 pool is capped at 400 sections of ~1100-2300, so it already holds the semantically nearest sections.`);
}
P("Control (harness check, NOT a recommendation): BM25 pool artificially cut to its top-10 rows, so nominees must matter. any-gold / all-gold at n=8, BASE-pool10 vs KNN-50-pool10, nominees in top-8 (mean):");
for (const sname of Object.keys(SETS)) {
  const rows = perQ.filter((p) => p.set === sname && p.ctl);
  const f = (K) => { let any = 0, all = 0; for (const p of rows) { const rk = p.srcs.map((s) => rankOf(p.ctl[K].hits, s, 8)); if (rk.some(fin)) any++; if (rk.every(fin)) all++; } return `${(100 * any / rows.length).toFixed(0)}%/${(100 * all / rows.length).toFixed(0)}%`; };
  P(`- ${sname}: ${f(0)} -> ${f(50)}; nominees in top-8 mean ${(rows.reduce((a, p) => a + p.ctl[50].nomInTop8, 0) / rows.length).toFixed(2)}`);
}
// no-overlap diagnostics
P(); P("## No-overlap: per question (BASE / KNN-50 first-gold rank at n=20; - = miss)");
for (const p of perQ.filter((x) => x.set === "no-overlap")) {
  const f = (K) => { const r = Math.min(...p.srcs.map((s) => rankOf(p.R[K].hits, s, 20))); return fin(r) ? r : "-"; };
  P(`- ${p.id}${p.empty ? " (EMPTY residual)" : ""}: BASE ${f(0)} / KNN-20 ${f(20)} / KNN-50 ${f(50)} | q="${p.query.slice(0, 90)}"`);
}
writeFileSync(join(OUT, "report.md"), lines.join("\n") + "\n");
writeFileSync(join(OUT, "results.json"), JSON.stringify(perQ, (k, v) => (v === Infinity ? "inf" : v)));
console.log(lines.join("\n"));
