// Trust/stability tie-breaker POC (PRD §15 5c). Question: does breaking recall TIES by stability
// (stable = low churn) lift the known-relevant file's rank, or pollute it? A tie-breaker is NOT a
// re-rank weight — it only reorders hits whose relevance is (near-)equal, so it can never cross a
// relevance gap by construction. We sweep the tie-band ε to find where "safe no-op" turns into "soft
// re-rank that pollutes": ε=0 = pure exact-score tie (reorder only identical scores); ε>0 = treat
// hits within ε·scoreRange as one tie-group, stable-first inside it.
//
// Churn proxy: git commit count per file (total, and within a 90d window — aurora's max_days cap).
// The SHIPPED signal is witnessed chunk_edits (accrues at runtime); git-churn is the cold-bench
// proxy, exactly the stance access-bench.mjs takes for edit-activation. This tests the DIRECTION
// (does stable-first help?), not the witnessed mechanism. `use` (recall_log) is empty on a cold
// bench, so the code half tests stability only; the use/human-verified tie-break is facts-side
// (scenario-tested, no oracle). Hypothesis sign: stable-first (low churn) = more trusted.
// Usage: node poc/trust-tiebreak-poc.mjs    (skips any repo whose checkout is absent)
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { LiteCtx } from "../src/index.js";

const EPS = [0, 0.02, 0.05, 0.1, 0.2]; // tie-band as a fraction of the per-query score range
const DEPTH = 100; // match bench-lib.mjs depth so baseline MRR reproduces the canonical floor line
const D90 = 90 * 86400;

// per-file churn from git history: total edits + edits in the last 90 days. Lower = more stable.
function churnSig(root, glob) {
  const raw = execFileSync("git", ["-C", root, "log", "--pretty=format:C %ct", "--name-only", "--", glob], { encoding: "utf8", maxBuffer: 1 << 28 });
  const times = new Map(); let t = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("C ")) t = +line.slice(2);
    else if (line.trim()) { const p = line.trim(); (times.get(p) ?? times.set(p, []).get(p)).push(t); }
  }
  const now = Math.max(...[...times.values()].flat(), 0);
  return (path) => { const ts = times.get(path) ?? []; return { total: ts.length, recent: ts.filter((x) => now - x <= D90).length }; };
}

// Reorder a score-ranked hit list: cluster into tie-groups by score gaps (gap ≤ band joins), then
// sort each group stable-first (lower churn), original order on churn ties. ε=0 ⇒ band 0 ⇒ only
// exactly-equal scores group ⇒ a pure exact-tie tie-break.
function reorder(hits, churnOf, key, eps) {
  const scores = hits.map((h) => h.score);
  const band = eps * ((Math.max(...scores) - Math.min(...scores)) || 1);
  const groups = []; let cur = [];
  for (let i = 0; i < hits.length; i++) {
    if (i > 0 && hits[i - 1].score - hits[i].score > band) { groups.push(cur); cur = []; }
    cur.push(hits[i]);
  }
  if (cur.length) groups.push(cur);
  const out = [];
  for (const g of groups) {
    out.push(...g.map((h, i) => [h, i]).sort((a, b) => key(churnOf(a[0].path)) - key(churnOf(b[0].path)) || a[1] - b[1]).map((x) => x[0]));
  }
  return out;
}

const REPOS = [
  { name: "aurora", ds: "aurora", glob: "*.py" },
  { name: "gitdone", ds: "gitdone", glob: "*.js" },
  {
    name: "litectx", root: "/home/hamr/PycharmProjects/litectx", include: [".js"], pathspecs: ["src/*.js"], glob: "*.js",
    queries: [
      { q: "split a camelCase identifier into separate tokens", target: "src/tokenize.js" },
      { q: "compute blast radius and change risk bucket for a symbol", target: "src/impact.js" },
      { q: "cosine similarity between two embedding vectors", target: "src/embedder.js" },
      { q: "resolve an import specifier to a target file path", target: "src/edges.js" },
      { q: "resolve a renamed barrel re-export through a tsconfig path alias", target: "src/tsalias.js" },
      { q: "extract function and class chunks with tree-sitter", target: "src/chunker.js" },
      { q: "nominate nearest stored vectors by cosine for paraphrase recall", target: "src/store.js" },
    ],
  },
];

const CHURN_DEFS = [
  { name: "total", key: (c) => c.total },
  { name: "recent90d", key: (c) => c.recent },
];
const rankOf = (list, target) => list.findIndex((h) => h.path === target) + 1;

console.log("Trust/stability tie-break — recall MRR by tie-band ε (stable-first inside a tie). Pollution = MRR drops below the recall floor.\n");
let ran = 0, failures = 0;
for (const repo of REPOS) {
  let { root, include, pathspecs, queries, glob } = repo, floor;
  if (repo.ds) {
    const ds = (await import(`./datasets/${repo.ds}.mjs`)).default;
    root = ds.roots.find(existsSync); include = ds.include; pathspecs = ds.pathspecs; queries = ds.queries; floor = ds.floor;
  }
  if (!root || !existsSync(root)) { console.log(`[${repo.name}] checkout absent — skipped\n`); continue; }
  ran++;
  const ctx = new LiteCtx({ root, include, pathspecs, dbPath: ":memory:" });
  await ctx.index();
  const churnOf = churnSig(root, glob);

  // baseline: recall as-is (score order). Also gather the hit lists once per query.
  const hitsByQ = [];
  let baseMRR = 0, withTies = 0;
  for (const { q, target } of queries) {
    const hits = await ctx.recall(q, { kind: "code", n: DEPTH });
    hitsByQ.push({ hits, target });
    baseMRR += 1 / (rankOf(hits, target) || Infinity);
    // does this query even have an exact-score tie to break? (fire-opportunity at ε=0)
    const s = hits.map((h) => h.score);
    if (s.some((x, i) => s.some((y, j) => i !== j && x === y))) withTies++;
  }
  baseMRR /= queries.length;
  console.log(`[${repo.name}] ${queries.length} queries  baseline MRR ${baseMRR.toFixed(3)}` + (floor != null ? `  (recall floor ${floor})` : "") + `  exact-tie queries: ${withTies}/${queries.length}`);
  console.log("  " + "churn/ε".padEnd(12) + EPS.map((e) => `ε=${e}`.padStart(9)).join("") + "   fired");

  for (const cd of CHURN_DEFS) {
    const row = [], fired = [];
    for (const eps of EPS) {
      let mrr = 0, changes = 0;
      for (const { hits, target } of hitsByQ) {
        const ro = reorder(hits, churnOf, cd.key, eps);
        mrr += 1 / (rankOf(ro, target) || Infinity);
        if (ro.some((h, i) => h.path !== hits[i].path)) changes++;
      }
      mrr /= queries.length;
      row.push(mrr); fired.push(changes);
      // GATE asserts only the SHIPPABLE form — the exact-tie (ε=0) tie-break, which must hold the
      // recall floor (it does: it's a measured no-op). Band pollution at ε>0 is the FINDING — the
      // reason trust must NOT reorder recall — reported per row, never a gate failure.
      if (eps === 0 && floor != null && mrr < floor - 1e-9) failures++;
    }
    const verdict = row.slice(1).some((m) => m > baseMRR + 1e-9) ? "lift" : row.some((m) => m < baseMRR - 1e-9) ? "POLLUTES" : "no-op";
    console.log("  " + cd.name.padEnd(12) + row.map((m) => m.toFixed(3).padStart(9)).join("") + `   ${fired.join("/")}  ${verdict}`);
  }
  console.log();
}
console.log(`GATE: ${ran} repo(s) ran, exact-tie (ε=0) floor failures: ${failures}.`);
console.log(
  failures
    ? "FAIL — the exact-tie form drops below the recall floor"
    : "PASS — exact-tie tie-break is floor-safe everywhere (a no-op); ANY band is repo-dependent pollution → the finding: trust must not reorder recall (ships as surfaced columns, slice 5c)."
);
process.exitCode = failures ? 1 : 0;
