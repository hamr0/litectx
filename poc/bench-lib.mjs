// Integration gate for the litectx LIBRARY (not the research ablation in run.mjs).
// Indexes a dataset's repo through the real `LiteCtx`, runs the labeled queries through
// `recall()`, and reports where the ground-truth file lands. This is the always-green
// gate from PRD §11.1: every slice must hold-or-beat these numbers on BOTH repos.
//
// Usage: node bench-lib.mjs            (both datasets)
//        node bench-lib.mjs gitdone    (one)

import { existsSync } from "node:fs";
import { LiteCtx } from "../src/index.js";

const DATASETS = process.argv[2] ? [process.argv[2]] : ["aurora", "gitdone"];
const DEPTH = 100;

const rr = (r) => (r === Infinity ? 0 : 1 / r);
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";

for (const name of DATASETS) {
  const ds = (await import(`./datasets/${name}.mjs`)).default;
  const root = ds.roots.find(existsSync);
  if (!root) { console.log(`\n[${name}] repo not found — skipped`); continue; }

  const ctx = new LiteCtx({ root, include: ds.include, pathspecs: ds.pathspecs, dbPath: ":memory:" });
  const { files } = ctx.index();

  const rows = ds.queries.map((Q) => {
    const hits = ctx.recall(Q.q, { limit: DEPTH });
    const i = hits.findIndex((h) => h.path === Q.target);
    return { ...Q, rank: i < 0 ? Infinity : i + 1 };
  });
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
}
console.log();
