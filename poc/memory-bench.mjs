// Written-memory recall QUALITY gate (§11.3) — the slice-7 follow-through. The write path's
// integration tests prove round-trip *survival* (boolean); this bench measures *ranking quality*
// over a committed corpus of realistic facts/episodes, split by query category:
//
//   exact — shared content keywords: BM25's home turf. FLOORED (must hold-or-beat).
//   morph — inflectional variants (refund/refunds): FTS5 has no stemming, so the shipped core is
//           expected to score 0 here. PINNED by `expected` — the documented baseline a stemming
//           fix must consciously move (red-before-the-fix, like the ts-barrel gate).
//   para  — pure paraphrase: the embeddings-tier case. PINNED the same way.
//
// The bench also AUDITS ITS OWN LABELS (the impact-bench lesson: trust the metric only as far as
// the audit): a morph/para query that shares an exact keyword with its target's INDEXED text
// (body or id — the id is indexed) is mislabeled and fails the run; an exact query sharing none
// does too. So a wording drift in the dataset can't silently turn the metric into noise.
//
// Pure-memory mode: no repo, no index() — the corpus is written via remember(). Runs anywhere.
// Optional: `--embeddings` re-runs with the semantic tier when @huggingface/transformers is installed
// (skipped with a notice otherwise — never failed).
//
// Usage: node poc/memory-bench.mjs [--embeddings]

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { LiteCtx, splitIdent, keywords } from "../src/index.js";
import { indexBody } from "../src/tokenize.js";
import ds from "./datasets/memory-facts.mjs";

const WANT_EMB = process.argv.includes("--embeddings");
const DEPTH = 50;
const rr = (r) => (r === Infinity ? 0 : 1 / r);
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";
const CATS = ["exact", "morph", "para"];

// ---- label audit (asserted): category semantics must hold against the INDEXED text ----
const itemById = new Map([...ds.facts, ...ds.episodes].map((m) => [m.id, m]));
const auditFailures = [];
for (const Q of ds.queries) {
  const t = itemById.get(Q.target);
  if (!t) { auditFailures.push(`${Q.cat} "${Q.q}" → target ${Q.target} not in corpus`); continue; }
  const indexed = new Set(splitIdent(indexBody({ path: t.id, body: t.text })));
  const overlap = keywords(Q.q).filter((k) => indexed.has(k));
  if (Q.cat === "exact" && overlap.length === 0)
    auditFailures.push(`exact "${Q.q}" shares NO keyword with ${Q.target} — mislabeled (morph/para?)`);
  if (Q.cat !== "exact" && overlap.length > 0)
    auditFailures.push(`${Q.cat} "${Q.q}" shares [${overlap.join(",")}] with ${Q.target} — mislabeled (exact?)`);
}

async function run(embeddings) {
  // root is required but never indexed — pure-memory mode. A throwaway tmp dir keeps it honest
  // (nothing in cwd can leak into the corpus even by accident).
  const root = mkdtempSync(join(tmpdir(), "litectx-membench-"));
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings });
  try {
    for (const f of ds.facts) await ctx.remember(f.id, f.text, { kind: "fact" });
    for (const e of ds.episodes) await ctx.remember(e.id, e.text, { kind: "episode", occurredAt: e.occurredAt });
    const rows = [];
    for (const Q of ds.queries) {
      const hits = await ctx.recall(Q.q, { kind: Q.kind, n: DEPTH });
      const i = hits.findIndex((h) => h.path === Q.target);
      rows.push({ ...Q, rank: i < 0 ? Infinity : i + 1 });
    }
    return rows;
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const agg = (rs) => ({
  mrr: rs.length ? rs.reduce((s, r) => s + rr(r.rank), 0) / rs.length : 0,
  p1: rs.length ? rs.filter((r) => r.rank === 1).length / rs.length : 0,
  p3: rs.length ? rs.filter((r) => r.rank <= 3).length / rs.length : 0,
});

function report(label, rows) {
  console.log(`\n[memory-facts] ${label} · ${ds.facts.length} facts + ${ds.episodes.length} episodes (written, pure-memory mode)`);
  const m = agg(rows);
  console.log(`    ALL        MRR ${m.mrr.toFixed(3)}  P@1 ${pct(m.p1)}  P@3 ${pct(m.p3)}   (${rows.length} queries)`);
  for (const cat of CATS) {
    const rs = rows.filter((r) => r.cat === cat);
    const c = agg(rs);
    console.log(`    ${cat.toUpperCase().padEnd(10)} MRR ${c.mrr.toFixed(3)}  P@1 ${pct(c.p1)}  P@3 ${pct(c.p3)}   (${rs.length})`);
  }
  const missed = rows.filter((r) => r.rank === Infinity);
  if (missed.length) console.log(`    unranked (${missed.length}): ${missed.map((r) => `${r.cat}:"${r.q}"`).join("  ")}`);
  return rows;
}

// ---- core run (BM25, the shipped default) — this is what the gate asserts ----
const rows = report("BM25 core", await run(false));
let failures = 0;

console.log(`\nGATE SUMMARY (§11.3 written-memory recall):`);
for (const [msg, bad] of auditFailures.map((m) => [m, true])) { console.log(`  AUDIT FAIL  ${msg}`); if (bad) failures++; }
if (!auditFailures.length) console.log(`  label audit: ${ds.queries.length}/${ds.queries.length} ok (exact share ≥1 keyword; morph/para share 0)`);

for (const cat of Object.keys(ds.floors ?? {})) {
  const mrr = agg(rows.filter((r) => r.cat === cat)).mrr;
  const pass = mrr >= ds.floors[cat];
  if (!pass) failures++;
  console.log(`  ${cat.toUpperCase().padEnd(7)} MRR ${mrr.toFixed(3)} ${pass ? "≥" : "<"} floor ${ds.floors[cat].toFixed(3)}  →  ${pass ? "PASS" : "FAIL"}`);
}
for (const cat of Object.keys(ds.expected ?? {})) {
  const mrr = agg(rows.filter((r) => r.cat === cat)).mrr;
  const pass = Math.abs(mrr - ds.expected[cat]) < 1e-9;
  if (!pass) failures++;
  console.log(`  ${cat.toUpperCase().padEnd(7)} MRR ${mrr.toFixed(3)} ${pass ? "=" : "≠"} expected ${ds.expected[cat].toFixed(3)}  →  ${pass ? "PASS (documented baseline)" : "FAIL — moved; update dataset `expected` consciously"}`);
}
console.log(`  failures (MUST be 0): ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;

// ---- optional embeddings pass — GATED WHEN IT RUNS (slice 11: the KNN union earns floors).
// Like the repo corpora: an absent model dep is skipped, never failed (local gate discipline);
// but when the pass runs, `ds.embFloors` assert hold-or-beat — para is no longer free to regress
// to its pre-union 0.000.
if (WANT_EMB) {
  try {
    await import("@huggingface/transformers");
    const erows = report("BM25 + embeddings (KNN-union tier)", await run(true));
    let efail = 0;
    console.log(`\nGATE SUMMARY (embeddings tier — enforced only when this pass runs):`);
    for (const cat of Object.keys(ds.embFloors ?? {})) {
      const mrr = agg(erows.filter((r) => r.cat === cat)).mrr;
      const pass = mrr >= ds.embFloors[cat];
      if (!pass) efail++;
      console.log(`  ${cat.toUpperCase().padEnd(7)} MRR ${mrr.toFixed(3)} ${pass ? "≥" : "<"} floor ${ds.embFloors[cat].toFixed(3)}  →  ${pass ? "PASS" : "FAIL"}`);
    }
    console.log(`  failures (MUST be 0): ${efail}`);
    if (efail) process.exitCode = 1;
  } catch {
    console.log(`\n[memory-facts] --embeddings requested but @huggingface/transformers is not installed — skipped (npm i @huggingface/transformers)`);
  }
}
console.log();
