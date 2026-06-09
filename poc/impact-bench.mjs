// Impact-view E2E gate (PRD §11.3) — the impact analogue of bench-lib.mjs. Indexes a stable repo
// through the real LiteCtx, runs each hand-audited symbol through `impact()`, and scores against
// ground truth with the §7.2 checks:
//
//   SAFETY (the load-bearing invariant): a `used` symbol must NEVER read SILENTLY isolated — it
//     must have either a reference (refCount > 0) or an explicit hedge. A silent "isolated → safe"
//     is the one dangerous error. Target: ZERO. (Sets the exit code.)
//   ISOLATION accuracy (datasets that label `isolated`): impact()'s verdict — refCount === 0 —
//     must match the ground-truth `isolated`. A used symbol that name-only resolution can't see
//     (barrel/alias rename, §7.2) reads refCount 0 → mismatch. This is the 5b gate: the
//     `barrel-default-alias` label fails until the alias mitigation lands. (Sets the exit code.)
//   QUALITY: confirmed-caller-FILE recall = |found ∩ known| / |known|. Misses are under-counts in
//     the caller LIST (decorators, dynamic dispatch, unresolved aliases) — informative, not gated,
//     since the SAFETY floor still holds.
//
// Precision / over-count is deliberately NOT gated (§7.2: over-count is safe). Usage:
//   node impact-bench.mjs              (all datasets)   |   node impact-bench.mjs impact-ts

import { existsSync } from "node:fs";
import { LiteCtx } from "../src/index.js";

const DATASETS = process.argv[2] ? [process.argv[2]] : ["impact-aurora", "impact-mcprune", "impact-ts"];
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";

let safetyFailures = 0;
let isolationFailures = 0;
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

    // SAFETY: a used symbol that reads refCount 0 with NO hedge is a silent false-isolation — the
    // §7.2 cardinal sin. (refCount 0 WITH a hedge is allowed: hedged, not silent.)
    const safe = !L.used || r.refCount > 0 || r.hedges.length > 0;
    if (!safe) safetyFailures++;

    // ISOLATION accuracy (only where the dataset states ground truth): impact says "isolated" iff
    // refCount === 0; that must match `L.isolated`. This is where barrel/alias under-counts surface.
    let isoTag = "";
    if (L.isolated !== undefined) {
      const predictedIsolated = r.refCount === 0;
      const isoOk = predictedIsolated === L.isolated;
      if (!isoOk) isolationFailures++;
      isoTag = `  ISO:${isoOk ? "ok" : `MISS(said ${predictedIsolated ? "isolated" : "used"}, truth ${L.isolated ? "isolated" : "used"})`}`;
    }

    console.log(
      `  ${L.symbol.padEnd(24)} caller-recall ${pct(recall)} (${found.length}/${L.callerFiles.length})  ` +
      `risk:${r.risk} refs:${r.refCount}  SAFETY:${safe ? "ok" : "SILENT-ISOLATION"}${isoTag}`
    );
    if (missed.length) console.log(`      missed callers: ${missed.join(", ")}`);
  }
  console.log(`  ── mean confirmed-caller recall: ${pct(recallSum / ds.labels.length)}`);
}

console.log(`\nSAFETY failures (silent isolations — MUST be 0): ${safetyFailures}`);
console.log(`ISOLATION-accuracy failures (used symbol read as isolated — MUST be 0): ${isolationFailures}`);
process.exitCode = safetyFailures === 0 && isolationFailures === 0 ? 0 : 1;
console.log();
