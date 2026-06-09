// Integration gate for the litectx LIBRARY (not the research ablation in run.mjs).
// Indexes a dataset's repo through the real `LiteCtx`, runs the labeled queries through
// `recall()`, and reports where the ground-truth file lands. This is the always-green
// gate from PRD §11.1: every slice must hold-or-beat these numbers on BOTH repos.
//
// ASSERTED (PRD §11.3): a dataset with a `floor` (its committed ALL-MRR regression line, a small
// epsilon below the shipped number) FAILS the run if it drops below — `process.exitCode = 1`, so a
// regression breaks the gate, it doesn't just print. The corpora are LOCAL checkouts (see each
// dataset's `roots`); an absent repo is SKIPPED, never failed, so this is safe to invoke anywhere
// (it simply gates nothing when the corpus isn't present — reported explicitly, never silently).
// Per LIBRARY_CONVENTIONS §5 the merge gate is typecheck+build:types+test only, so this stays a
// LOCAL pre-push gate, not a CI step.
//
// Usage: node bench-lib.mjs            (both datasets)
//        node bench-lib.mjs gitdone    (one)

import { existsSync } from "node:fs";
import { LiteCtx } from "../src/index.js";

const DATASETS = process.argv[2] ? [process.argv[2]] : ["aurora", "gitdone"];
const DEPTH = 100;

/** @type {{ name: string, status: "PASS"|"FAIL"|"skipped (no floor)", mrr: number, floor: number }[]} */
const gate = [];
let floorFailures = 0;
let checked = 0;

const rr = (r) => (r === Infinity ? 0 : 1 / r);
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";

for (const name of DATASETS) {
  const ds = (await import(`./datasets/${name}.mjs`)).default;
  const root = ds.roots.find(existsSync);
  if (!root) { console.log(`\n[${name}] repo not found — skipped`); continue; }

  const ctx = new LiteCtx({ root, include: ds.include, pathspecs: ds.pathspecs, dbPath: ":memory:" });
  const { files } = await ctx.index();

  /** @type {any[]} */
  const rows = [];
  for (const Q of ds.queries) {
    // every dataset target is a code file; scope recall to kind:"code". For aurora-mixed (md in
    // the index) this is the whole point — the kind filter holds the py-only baseline exactly,
    // with no md doc able to bury a code target (§5: kinds never share a ranking).
    const hits = await ctx.recall(Q.q, { kind: "code", n: DEPTH });
    const i = hits.findIndex((h) => h.path === Q.target);
    rows.push({ ...Q, rank: i < 0 ? Infinity : i + 1 });
  }
  ctx.close();

  const agg = (rs) => ({
    mrr: rs.reduce((s, r) => s + rr(r.rank), 0) / rs.length,
    p1: rs.filter((r) => r.rank === 1).length / rs.length,
    p3: rs.filter((r) => r.rank <= 3).length / rs.length,
    p5: rs.filter((r) => r.rank <= 5).length / rs.length,
  });
  const line = (label, rs) => {
    const m = agg(rs);
    console.log(`    ${label.padEnd(10)} MRR ${m.mrr.toFixed(3)}  P@1 ${pct(m.p1)}  P@3 ${pct(m.p3)}  P@5 ${pct(m.p5)}`);
  };

  console.log(`\n[${name}] litectx library · ${files} files indexed (file-granularity BM25)`);
  line("ALL", rows);
  line("EASY", rows.filter((r) => r.diff === "easy"));
  line("HARD", rows.filter((r) => r.diff === "hard"));
  const missed = rows.filter((r) => r.rank === Infinity).map((r) => r.target);
  if (missed.length) console.log(`    not in top ${DEPTH}: ${missed.join(", ")}`);

  // ---- the asserted floor (§11.3): ALL MRR must hold-or-beat the committed line ----
  const mrr = agg(rows).mrr;
  if (typeof ds.floor === "number") {
    checked++;
    const pass = mrr >= ds.floor;
    if (!pass) floorFailures++;
    gate.push({ name, status: pass ? "PASS" : "FAIL", mrr, floor: ds.floor });
    console.log(`    GATE  ALL MRR ${mrr.toFixed(3)} ${pass ? "≥" : "<"} floor ${ds.floor.toFixed(3)}  →  ${pass ? "PASS" : "FAIL"}`);
  } else {
    gate.push({ name, status: "skipped (no floor)", mrr, floor: NaN });
  }
}

// ---- gate summary: explicit about what was enforced vs skipped (no silent pass) ----
console.log(`\nGATE SUMMARY (§11.3 recall regression floor):`);
for (const g of gate) {
  const detail = Number.isNaN(g.floor) ? "" : ` (MRR ${g.mrr.toFixed(3)} vs floor ${g.floor.toFixed(3)})`;
  console.log(`  ${g.name.padEnd(10)} ${g.status}${detail}`);
}
if (checked === 0) console.log(`  ⚠ no floored dataset present — gate enforced NOTHING (corpora are local; see dataset roots)`);
console.log(`  floor failures (MUST be 0): ${floorFailures}`);
process.exitCode = floorFailures === 0 ? 0 : 1;
console.log();
