// Recall litmus, cross-repo (scratch) — validates the embeddings-default question on aurora/gitdone
// using their EXISTING verified labeled queries (zero leakage, reuses bench datasets). For each
// repo: index with embeddings on (vectors stored once), then run the natural-language queries under
// BM25-off and an embeddings-weight sweep. Reports MRR / P@1 / P@3 / missed for the code targets.
//
// These dataset queries are realistic natural-language questions (already moderately keyword-rich),
// so this is the honest "does turning embeddings on lift real code recall?" test — the crux of
// whether the opt-in tier should become a default. Usage: node poc/recall-litmus-repos.mjs <aurora|gitdone> [w...]

import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const name = process.argv[2];
if (!["aurora", "gitdone"].includes(name)) { console.error("usage: recall-litmus-repos.mjs <aurora|gitdone> [weights...]"); process.exit(1); }
const SWEEP = process.argv.slice(3).map(Number).filter((x) => !Number.isNaN(x));
const WEIGHTS = SWEEP.length ? SWEEP : [0.3, 0.5, 0.7, 1.0];

const ds = (await import(`./datasets/${name}.mjs`)).default;
const root = ds.roots.find(existsSync);
if (!root) { console.error(`no checkout of ${name} found`); process.exit(1); }

const rr = (r) => (r > 0 ? 1 / r : 0);
const pct = (x) => (100 * x).toFixed(0).padStart(3) + "%";

async function run(ctx) {
  const ranks = [];
  for (const { q, target } of ds.queries) {
    const hits = await ctx.recall(q, { kind: "code", n: 10, log: false });
    const i = hits.findIndex((h) => h.path === target);
    ranks.push(i < 0 ? 0 : i + 1);
  }
  const mrr = ranks.reduce((s, r) => s + rr(r), 0) / ranks.length;
  return {
    mrr,
    p1: ranks.filter((r) => r === 1).length / ranks.length,
    p3: ranks.filter((r) => r >= 1 && r <= 3).length / ranks.length,
    missed: ranks.filter((r) => r === 0).length,
  };
}
const line = (label, m) => console.log(`  ${label.padEnd(16)} MRR ${m.mrr.toFixed(3)}   P@1 ${pct(m.p1)}   P@3 ${pct(m.p3)}   missed ${m.missed}/${ds.queries.length}`);

const db = join(mkdtempSync(join(tmpdir(), `litmus-${name}-`)), "i.db");
console.log(`[${name}] ${root} — indexing ${ds.include} with embeddings (one-time)…`);
const t0 = Date.now();
const idx = new LiteCtx({ root, include: ds.include, pathspecs: ds.pathspecs, dbPath: db, embeddings: true });
const r = await idx.index();
idx.close();
console.log(`indexed ${r.files} files in ${((Date.now() - t0) / 1000).toFixed(1)}s · ${ds.queries.length} queries\n`);

const bm25 = new LiteCtx({ root, dbPath: db, embeddings: false });
line("BM25 (off)", await run(bm25));
bm25.close();
for (const w of WEIGHTS) {
  const e = new LiteCtx({ root, dbPath: db, embeddings: true, embedWeight: w });
  line(`emb@${w}`, await run(e));
  e.close();
}
rmSync(db, { recursive: true, force: true });
