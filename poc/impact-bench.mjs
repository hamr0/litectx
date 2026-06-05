// Impact-view E2E gate (PRD §11.3) — the impact analogue of bench-lib.mjs. Indexes a stable repo
// through the real LiteCtx, runs each hand-audited symbol through `impact()`, and scores against
// ground truth with the §7.2 PAIR of metrics:
//
//   SAFETY (the load-bearing one): a `used` symbol must NEVER read isolated (refCount > 0). A
//     safety failure = a false "isolated → safe", the one dangerous error. Target: ZERO.
//   QUALITY: confirmed-caller-FILE recall = |found ∩ known| / |known|. Misses here are under-counts
//     in the caller LIST (e.g. decorators, dynamic dispatch) — informative, not safety-critical,
//     since the mention floor still protects SAFETY.
//
// Precision / over-count is deliberately NOT gated (§7.2: over-count is safe). Usage:
//   node impact-bench.mjs            (both datasets)   |   node impact-bench.mjs impact-mcprune

import { existsSync } from "node:fs";
import { LiteCtx } from "../src/index.js";

const DATASETS = process.argv[2] ? [process.argv[2]] : ["impact-aurora", "impact-mcprune"];
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";

let safetyFailures = 0;
for (const name of DATASETS) {
  const ds = (await import(`./datasets/${name}.mjs`)).default;
  const root = ds.roots.find(existsSync);
  if (!root) { console.log(`\n[${name}] repo not found — skipped`); continue; }

  const ctx = new LiteCtx({ root, include: ds.include, pathspecs: ds.pathspecs, dbPath: ":memory:" });
  const { files } = await ctx.index();
  console.log(`\n[${name}] ${files} files indexed`);

  let recallSum = 0;
  for (const L of ds.labels) {
    const r = await ctx.impact(L.symbol);
    if (!r) { console.log(`  ${L.symbol.padEnd(24)} ERROR: not defined in index (bad label?)`); safetyFailures++; continue; }

    const confirmed = new Set(r.callers.map((c) => c.path));
    const found = L.callerFiles.filter((f) => confirmed.has(f));
    const missed = L.callerFiles.filter((f) => !confirmed.has(f));
    const recall = L.callerFiles.length ? found.length / L.callerFiles.length : 1;
    recallSum += recall;

    // SAFETY: a used symbol reported with refCount 0 is a false isolation — the §7.2 cardinal sin.
    const safe = !L.used || r.refCount > 0;
    if (!safe) safetyFailures++;

    console.log(
      `  ${L.symbol.padEnd(24)} caller-recall ${pct(recall)} (${found.length}/${L.callerFiles.length})  ` +
      `risk:${r.risk} refs:${r.refCount}  SAFETY:${safe ? "ok" : "FALSE-ISOLATION"}`
    );
    if (missed.length) console.log(`      missed callers: ${missed.join(", ")}`);
  }
  console.log(`  ── mean confirmed-caller recall: ${pct(recallSum / ds.labels.length)}`);
}

console.log(`\nSAFETY failures (false isolations — MUST be 0): ${safetyFailures}`);
process.exitCode = safetyFailures === 0 ? 0 : 1;
console.log();
