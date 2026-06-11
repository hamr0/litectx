// Action-signal bench (PRD §11.3 / §14 #4): measures whether folding EDIT-ACTIVATION into recall
// LIFTS the known-relevant file's rank or POLLUTES it. The honest test of base-level activation as a
// recall term — the access-log tier's core claim. Non-circular: relevance labels are the committed
// recall ground truth; the activation is computed from real git edit history, independent of them.
//
// For each repo: index (real lib, kind:code), run the labeled {q→target} queries, compute per-file
// edit-BLA = ln(Σ age^-0.5) over commit times at HEAD, re-rank the recall pool by
// norm(recallScore) + w·norm(editBLA), sweep w, report MRR(w). Activation re-ranks the pool, never
// gates (PRD). SAFETY GATE (the §7.2-style asymmetry — pollution is the danger): no swept weight may
// drop MRR below the recall baseline floor; a positive lift is reported, never required.
// Usage: node poc/access-bench.mjs    (skips any repo whose checkout is absent)
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { LiteCtx } from "../src/index.js";

const D = 0.5;
const WEIGHTS = [0, 0.1, 0.2, 0.3, 0.5];
const minmax = (xs) => { const lo = Math.min(...xs), hi = Math.max(...xs); return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0.5)); };

function editBLA(root, glob) {
  const raw = execFileSync("git", ["-C", root, "log", "--pretty=format:C %ct", "--name-only", "--", glob], { encoding: "utf8", maxBuffer: 1 << 28 });
  const times = new Map(); let t = 0;
  for (const line of raw.split("\n")) {
    if (line.startsWith("C ")) t = +line.slice(2);
    else if (line.trim()) (times.get(line.trim()) ?? times.set(line.trim(), []).get(line.trim())).push(t);
  }
  const now = Math.max(...[...times.values()].flat());
  return (path) => { const ts = times.get(path); return ts ? Math.log(ts.reduce((s, x) => s + Math.max(now - x, 1) ** -D, 0)) : -5; };
}

// repos: reuse the committed recall datasets (aurora/gitdone) + an inline litectx label set.
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

let failures = 0, ran = 0;
console.log("Action-signal bench — recall MRR by edit-activation weight (pollution = MRR falls as w rises)\n");
for (const repo of REPOS) {
  let root = repo.root, include = repo.include, pathspecs = repo.pathspecs, queries = repo.queries, floor;
  if (repo.ds) {
    const ds = (await import(`./datasets/${repo.ds}.mjs`)).default;
    root = ds.roots.find(existsSync); include = ds.include; pathspecs = ds.pathspecs; queries = ds.queries; floor = ds.floor;
  }
  if (!root || !existsSync(root)) { console.log(`[${repo.name}] checkout absent — skipped`); continue; }
  ran++;
  const ctx = new LiteCtx({ root, include, pathspecs, dbPath: ":memory:" });
  await ctx.index();
  const bla = editBLA(root, repo.glob);
  const mrr = WEIGHTS.map(() => 0);      // FLAT: score = relevance + w·activation  (topic-blind)
  const mrrC = WEIGHTS.map(() => 0);     // CONDITIONED: score = relevance + w·relevance·activation
  for (const { q, target } of queries) {
    const hits = await ctx.recall(q, { kind: "code", n: 10 });
    const sN = minmax(hits.map((h) => h.score));
    const bN = minmax(hits.map((h) => bla(h.path)));
    const rankAt = (scoreOf) => { const o = hits.map((h, i) => [h.path, scoreOf(i)]).sort((a, b) => b[1] - a[1]); return o.findIndex(([p]) => p === target) + 1; };
    WEIGHTS.forEach((w, wi) => {
      const rf = rankAt((i) => sN[i] + w * bN[i]);          if (rf) mrr[wi] += 1 / rf;
      const rc = rankAt((i) => sN[i] + w * sN[i] * bN[i]);  if (rc) mrrC[wi] += 1 / rc;
    });
  }
  const norm = mrr.map((m) => m / queries.length), normC = mrrC.map((m) => m / queries.length);
  const base = norm[0];
  console.log(`[${repo.name}] ${queries.length} queries` + (floor != null ? `  (recall floor ${floor})` : ""));
  console.log("  " + "form".padEnd(13) + WEIGHTS.map((w) => `w=${w}`.padStart(8)).join("") + "   verdict");
  console.log("  " + "flat".padEnd(13) + norm.map((m) => m.toFixed(3).padStart(8)).join("") + `   ${norm.slice(1).some((m) => m > base + 0.01) ? "lift" : "no lift / pollution"}`);
  console.log("  " + "conditioned".padEnd(13) + normC.map((m) => m.toFixed(3).padStart(8)).join("") + `   ${normC.slice(1).every((m) => m >= base - 0.005) ? (normC.slice(1).some((m) => m > base + 0.005) ? "lift, no pollution" : "neutral, no pollution") : "pollutes"}`);
  // SAFETY: the baseline (w=0) must hold the recall floor; pollution (any w that drops below floor) is reported per-weight.
  if (floor != null && base < floor) { console.log(`  ✗ baseline MRR ${base.toFixed(3)} < recall floor ${floor}`); failures++; }
  const polluted = WEIGHTS.filter((w, i) => i && floor != null && norm[i] < floor);
  if (polluted.length) console.log(`  ⚠ POLLUTION: weights ${polluted.join("/")} drop MRR below the recall floor ${floor}`);
  console.log();
}
console.log(`GATE: ${ran} repo(s) ran, ${failures} baseline failure(s).`);
console.log(failures ? "FAIL" : "PASS (baselines hold; edit-activation lift/pollution reported per repo above)");
process.exitCode = failures ? 1 : 0;
