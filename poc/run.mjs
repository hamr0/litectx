// litectx POC — PRD §11 gate harness. THROWAWAY. Not shipped, never imported by the lib.
//
// Hypothesis to kill or confirm:
//   Does activation + graph-aware recall measurably beat plain FTS5/BM25?
//
// Usage: node run.mjs [dataset]      dataset = aurora (default) | gitdone
//
// Method: index a repo's source files into one SQLite FTS5 table. For each eval query,
// order the SAME FTS candidate set four ways and see where the ground-truth file lands:
//   baseline = pure BM25 · +bla = BM25+git-activation · +spread = BM25+graph · litectx = all.
//   - bla     = git-seeded ACT-R base level: ln(Σ age_days^-d), commits as pseudo-accesses.
//   - spread  = 1-hop over code edges (python imports OR cjs requires): a file inherits the
//               best lexical relevance among its graph neighbors.
// FTS5 gate: candidates = files that match the query (activation never surfaces a non-match).

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const DATASET = process.argv[2] || "aurora";
const ds = (await import(`./datasets/${DATASET}.mjs`)).default;
const ROOT = ds.roots.find(existsSync);
if (!ROOT) throw new Error(`repo not found for dataset ${DATASET}`);
const DECAY = 0.5;
const W = { bm25: 0.5, bla: 0.3, spread: 0.2 };
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });

// ---- code-aware tokenization (split snake_case + camelCase, like aurora's tokenizer) ----
const STOP = new Set("the a an is are be how where what when which does do i of to into for from on in it its and or s as we use used using system code module responsible".split(" "));
const splitIdent = (s) => s
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[^A-Za-z0-9]+/g, " ")
  .toLowerCase().split(/\s+/).filter(Boolean);
const keywords = (q) => [...new Set(splitIdent(q).filter((w) => w.length >= 3 && !STOP.has(w)))];

// ---- collect files ----
const files = git("ls-files", ...ds.pathspecs).trim().split("\n").filter(Boolean);
const fileSet = new Set(files);

// ---- edges (undirected, intra-repo) ----
const neighbors = new Map(files.map((f) => [f, new Set()]));
const link = (a, b) => { if (b && b !== a && fileSet.has(b)) { neighbors.get(a).add(b); neighbors.get(b).add(a); } };

if (ds.edges === "python") {
  const modToFile = new Map();
  for (const f of files) {
    const i = f.indexOf("/src/");
    if (i < 0) continue;
    const mod = f.slice(i + 5).replace(/\.py$/, "").replace(/\//g, ".").replace(/\.__init__$/, "");
    modToFile.set(mod, f);
  }
  const resolve = (mod) => modToFile.get(mod) || modToFile.get(mod.split(".").slice(0, -1).join(".")) || null;
  const re = /^\s*(?:from\s+([\w.]+)\s+import\s+([\w,\s*]+)|import\s+([\w.]+))/gm;
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), "utf8");
    let m;
    while ((m = re.exec(text))) {
      const cands = [];
      if (m[1]) { cands.push(m[1]); for (const n of m[2].split(",").map((x) => x.trim().split(" ")[0]).filter(Boolean)) cands.push(`${m[1]}.${n}`); }
      if (m[3]) cands.push(m[3]);
      for (const c of cands) link(f, resolve(c));
    }
  }
} else if (ds.edges === "cjs") {
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;       // relative requires only
  for (const f of files) {
    const text = readFileSync(join(ROOT, f), "utf8");
    let m;
    while ((m = re.exec(text))) {
      const base = join(dirname(f), m[1]).replace(/\\/g, "/");
      const cand = [base, `${base}.js`, `${base}/index.js`].find((p) => fileSet.has(p));
      link(f, cand);
    }
  }
}

// ---- git-seeded base-level activation: BLA = ln(Σ age_days^-d) ----
const NOW = parseInt(git("log", "-1", "--format=%at").trim(), 10);
const commits = new Map(files.map((f) => [f, []]));
{
  const log = git("log", "--format=C%at", "--name-only", "--", ...ds.pathspecs);
  let t = null;
  for (const line of log.split("\n")) {
    if (/^C\d+$/.test(line)) { t = parseInt(line.slice(1), 10); continue; }
    if (t != null && fileSet.has(line)) commits.get(line).push(t);
  }
}
const bla = new Map();
for (const f of files) {
  const ts = commits.get(f);
  if (!ts.length) { bla.set(f, 0); continue; }
  let sum = 0;
  for (const t of ts) sum += Math.pow(Math.max((NOW - t) / 86400, 1), -DECAY);
  bla.set(f, Math.log(sum));
}

// ---- FTS5 index (path tokens folded into body so filename matches count, for all rankers) ----
const db = new Database(":memory:");
db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, txt)");
const ins = db.prepare("INSERT INTO docs(rowid, path, txt) VALUES (?,?,?)");
const rowToFile = [];
db.transaction(() => {
  files.forEach((f, idx) => {
    const body = readFileSync(join(ROOT, f), "utf8");
    const pathTok = splitIdent(f).join(" ");
    ins.run(idx + 1, f, `${pathTok} ${pathTok} ${body} ${splitIdent(body).join(" ")}`);
    rowToFile[idx + 1] = f;
  });
})();

// ---- rankers ----
function matchQuery(q) {
  const kws = keywords(q);
  if (!kws.length) return [];
  const match = kws.map((k) => `"${k}"`).join(" OR ");
  return db.prepare("SELECT rowid, -bm25(docs) AS rel FROM docs WHERE docs MATCH ? ORDER BY rel DESC").all(match)
    .map((r) => ({ file: rowToFile[r.rowid], rel: r.rel }));
}
const minmax = (arr, get) => {
  const v = arr.map(get), lo = Math.min(...v), hi = Math.max(...v);
  return (x) => (hi > lo ? (get(x) - lo) / (hi - lo) : (arr.length === 1 ? 1 : 0));
};
const VARIANTS = { baseline: [1, 0, 0], "+bla": [0.6, 0.4, 0], "+spread": [0.6, 0, 0.4], litectx: [0.5, 0.3, 0.2] };
function rank(q) {
  const cands = matchQuery(q);
  if (!cands.length) return { orders: {}, inFts: new Set() };
  const nb = minmax(cands, (c) => c.rel);
  const bb = minmax(cands, (c) => bla.get(c.file) ?? 0);
  const relNorm = new Map(cands.map((c) => [c.file, nb(c)]));
  const feats = cands.map((c) => {
    let spread = 0;
    for (const n of neighbors.get(c.file)) if (relNorm.has(n)) spread = Math.max(spread, relNorm.get(n));
    return { file: c.file, bm25: nb(c), bla: bb(c), spread };
  });
  const orders = {};
  for (const [name, w] of Object.entries(VARIANTS))
    orders[name] = [...feats].sort((a, b) =>
      (w[0] * b.bm25 + w[1] * b.bla + w[2] * b.spread) - (w[0] * a.bm25 + w[1] * a.bla + w[2] * a.spread)
    ).map((f) => f.file);
  return { orders, inFts: new Set(cands.map((c) => c.file)) };
}

// ---- metrics ----
const VNAMES = Object.keys(VARIANTS);
const rankOf = (list, t) => { const i = list.indexOf(t); return i < 0 ? Infinity : i + 1; };
const rr = (r) => (r === Infinity ? 0 : 1 / r);
const results = ds.queries.map((Q) => {
  const { orders, inFts } = rank(Q.q);
  const ranks = {};
  for (const v of VNAMES) ranks[v] = orders[v] ? rankOf(orders[v], Q.target) : Infinity;
  return { ...Q, ranks, matched: inFts.has(Q.target) };
});
const agg = (rows, v) => ({
  mrr: rows.reduce((s, r) => s + rr(r.ranks[v]), 0) / rows.length,
  p1: rows.filter((r) => r.ranks[v] === 1).length / rows.length,
  p3: rows.filter((r) => r.ranks[v] <= 3).length / rows.length,
  p5: rows.filter((r) => r.ranks[v] <= 5).length / rows.length,
});

// ---- report ----
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";
const fmt = (r) => (r === Infinity ? " —" : String(r).padStart(2));
const edges = [...neighbors.values()].reduce((s, x) => s + x.size, 0) / 2;
console.log(`\n[${ds.name}] ${files.length} files (${ds.pathspecs.join(",")}) · NOW=${new Date(NOW * 1000).toISOString().slice(0, 10)} · ${ds.edges}-edges=${edges}\n`);
console.log("  diff  " + VNAMES.map((v) => v.padStart(8)).join("") + "   query");
for (const r of results)
  console.log(`  ${r.diff.padEnd(4)}  ${VNAMES.map((v) => fmt(r.ranks[v]).padStart(8)).join("")}   ${r.matched ? "" : "✗FTS "}${r.q}`);
function table(label, rows) {
  console.log(`\n  ${label} (n=${rows.length})`);
  const base = agg(rows, "baseline");
  for (const v of VNAMES) {
    const m = agg(rows, v);
    const d = v === "baseline" ? "" : `   Δmrr ${m.mrr - base.mrr >= 0 ? "+" : ""}${(m.mrr - base.mrr).toFixed(3)}`;
    console.log(`    ${v.padEnd(9)} MRR ${m.mrr.toFixed(3)}  P@1 ${pct(m.p1)}  P@3 ${pct(m.p3)}  P@5 ${pct(m.p5)}${d}`);
  }
}
table("ALL", results);
table("EASY", results.filter((r) => r.diff === "easy"));
table("HARD", results.filter((r) => r.diff === "hard"));
const ftsMiss = results.filter((r) => !r.matched).length;
const moved = results.filter((r) => r.ranks.litectx !== r.ranks.baseline);
const better = moved.filter((r) => r.ranks.litectx < r.ranks.baseline).length;
console.log(`\n  FTS5 ceiling: ${results.length - ftsMiss}/${results.length} targets matched (all rankers blind to the other ${ftsMiss}).`);
console.log(`  litectx vs baseline: moved ${moved.length}/${results.length} — ${better} better, ${moved.length - better} worse.\n`);
