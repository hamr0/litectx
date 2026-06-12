// POC — retrieval-confidence label off TOP RAW COSINE (the R-S8 salvage question).
// Throwaway — never ship the POC.
//
// THE RISKIEST ASSUMPTION (what this POC exists to falsify):
//   Does the best semantic match's RAW cosine separate "the answer is in the store"
//   (should label "ok") from "nothing relevant is here" (should label "weak")?
//   If the two distributions overlap, the label is fiction → drop it.
//   If a threshold τ cleanly splits them, the label is real → report τ.
//
// Signal = max cosine(query, stored-vector) over the queried kind — the absolute
// "is anything close" reading the label would use (facts/episodes only: their KNN
// union already reaches the whole store by vector, so max-over-store == what the
// label sees; code is gated and excluded, per the grounding).
//
// Positives  = the committed answerable queries (target IS in the corpus).
// Negatives  = NEW queries whose answer is NOT in the corpus:
//                easy = clearly off-domain; hard = in-domain-but-absent (the stress test).
//
// Usage: node poc/confidence-poc.mjs   (needs @huggingface/transformers)

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LiteCtx, cosine } from "../src/index.js";
import ds from "./datasets/memory-facts.mjs";

// ---- negatives: answer genuinely NOT in the 24 facts / 5 episodes ----
const NEGATIVES = [
  // easy — clearly off-domain (sanity floor: these MUST score low or the signal is meaningless)
  { q: "best recipe for sourdough bread", tag: "easy" },
  { q: "how do I reset my bluetooth headphones", tag: "easy" },
  { q: "what time does the cafeteria open", tag: "easy" },
  { q: "company parental leave policy", tag: "easy" },
  { q: "how many vacation days do new employees get", tag: "easy" },
  { q: "what is the office dress code", tag: "easy" },
  { q: "gym membership reimbursement", tag: "easy" },
  { q: "who won the football game last night", tag: "easy" },
  // hard — adjacent to the domain but genuinely absent (where a confidence label earns or loses trust)
  { q: "what message queue do we use", tag: "hard" },
  { q: "which CI provider runs the pipeline", tag: "hard" },
  { q: "what cloud region are we deployed in", tag: "hard" },
  { q: "how is the on-call rotation scheduled", tag: "hard" },
  { q: "what frontend framework does the UI use", tag: "hard" },
  { q: "do we support GraphQL queries", tag: "hard" },
  { q: "how are container images built", tag: "hard" },
  { q: "what is the disaster recovery RTO target", tag: "hard" },
  { q: "how do we handle GDPR data deletion requests", tag: "hard" },
  { q: "what is the kafka topic partition count", tag: "hard" },
];

const root = mkdtempSync(join(tmpdir(), "litectx-confpoc-"));
const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: true });

function quantiles(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { min: s[0], p25: q(0.25), med: q(0.5), p75: q(0.75), max: s[s.length - 1] };
}
const f3 = (x) => x.toFixed(3);

try {
  for (const f of ds.facts) await ctx.remember(f.id, f.text, { kind: "fact" });
  for (const e of ds.episodes) await ctx.remember(e.id, e.text, { kind: "episode", occurredAt: e.occurredAt });

  // pull every stored vector, grouped by kind
  const rows = ctx.store.db.prepare("SELECT path, kind FROM mem WHERE kind IN ('fact','episode')").all();
  const vecMap = ctx.store.getEmbeddings(rows.map((r) => r.path));
  const byKind = { fact: [], episode: [] };
  for (const r of rows) { const v = vecMap.get(r.path); if (v) byKind[r.kind].push({ path: r.path, v }); }

  // max cosine over the queried kind + whether the closest item IS the target
  async function topCosine(q, kind) {
    const qv = await ctx._embedQuery(q);
    let best = -1, bestPath = null;
    for (const { path, v } of byKind[kind]) { const c = cosine(qv, v); if (c > best) { best = c; bestPath = path; } }
    return { cos: best, bestPath };
  }

  const pos = [];
  for (const Q of ds.queries) {
    const { cos, bestPath } = await topCosine(Q.q, Q.kind);
    pos.push({ ...Q, cos, hitTarget: bestPath === Q.target });
  }
  const neg = [];
  for (const N of NEGATIVES) {
    const { cos } = await topCosine(N.q, "fact"); // unanswerable agent questions default to fact recall
    neg.push({ ...N, cos });
  }

  // ---- report distributions ----
  console.log(`\n=== TOP RAW COSINE: answerable (positives) vs unanswerable (negatives) ===`);
  console.log(`positives n=${pos.length} (exact/morph/para, target in store)`);
  for (const cat of ["exact", "morph", "para"]) {
    const xs = pos.filter((p) => p.cat === cat).map((p) => p.cos);
    const Q = quantiles(xs);
    console.log(`  ${cat.padEnd(6)} n=${xs.length}  cos[min ${f3(Q.min)}  p25 ${f3(Q.p25)}  med ${f3(Q.med)}  p75 ${f3(Q.p75)}  max ${f3(Q.max)}]`);
  }
  console.log(`negatives n=${neg.length} (no answer in store)`);
  for (const tag of ["easy", "hard"]) {
    const xs = neg.filter((n) => n.tag === tag).map((n) => n.cos);
    const Q = quantiles(xs);
    console.log(`  ${tag.padEnd(6)} n=${xs.length}  cos[min ${f3(Q.min)}  p25 ${f3(Q.p25)}  med ${f3(Q.med)}  p75 ${f3(Q.p75)}  max ${f3(Q.max)}]`);
  }

  // ---- separability: AUC (Mann–Whitney) of "positive has higher cos than negative" ----
  const P = pos.map((p) => p.cos), Ngv = neg.map((n) => n.cos);
  let wins = 0, ties = 0;
  for (const a of P) for (const b of Ngv) { if (a > b) wins++; else if (a === b) ties++; }
  const auc = (wins + 0.5 * ties) / (P.length * Ngv.length);
  console.log(`\nAUC(pos>neg) = ${f3(auc)}   (0.5 = no separation, 1.0 = perfect)`);

  // ---- threshold sweep: pick τ, report what "weak = cos<τ" would do ----
  console.log(`\nτ sweep  —  weak := topCos < τ`);
  console.log(`   τ      pos→weak (false alarm)     neg→weak (correct catch)`);
  for (const tau of [0.25, 0.30, 0.35, 0.40, 0.45, 0.50]) {
    const fa = pos.filter((p) => p.cos < tau).length;
    const catch_ = neg.filter((n) => n.cos < tau).length;
    console.log(`  ${tau.toFixed(2)}   ${String(fa).padStart(2)}/${pos.length} (${(100*fa/pos.length).toFixed(0)}%)            ${String(catch_).padStart(2)}/${neg.length} (${(100*catch_/neg.length).toFixed(0)}%)`);
  }

  // worst offenders to eyeball the overlap zone
  const overlapNeg = neg.filter((n) => n.cos >= 0.35).sort((a, b) => b.cos - a.cos);
  const weakPos = pos.filter((p) => p.cos < 0.40).sort((a, b) => a.cos - b.cos);
  if (overlapNeg.length) console.log(`\nhigh-cosine NEGATIVES (would wrongly read "ok"): ${overlapNeg.map((n) => `${f3(n.cos)} "${n.q}"`).join("  ·  ")}`);
  if (weakPos.length) console.log(`low-cosine POSITIVES (would wrongly read "weak"): ${weakPos.map((p) => `${f3(p.cos)} ${p.cat}:"${p.q}"`).join("  ·  ")}`);
  console.log();
} finally {
  ctx.close();
  rmSync(root, { recursive: true, force: true });
}
