// litectx POC — PRD §11 gate harness. THROWAWAY. Not shipped, never imported by the lib.
//
// Hypothesis to kill or confirm:
//   Does activation + graph-aware recall measurably beat plain FTS5/BM25?
//
// Method: index aurora's .py files into one SQLite FTS5 table. For each eval query,
// rank candidate files two ways and compare where the ground-truth file lands:
//   A) baseline  = pure BM25 (FTS5 bm25()).
//   B) litectx   = re-rank the SAME FTS candidates by 0.5*BM25 + 0.3*activation + 0.2*spreading.
//        - activation = git-seeded ACT-R base level: BLA = ln(Σ age_days^-d), d=0.5,
//          commit timestamps as pseudo-accesses (the PRD cold-start unification, validated here).
//        - spreading  = 1-hop over import edges (regex-derived): a file inherits the best
//          lexical relevance among its import-neighbors.
// FTS5 gate: candidates = files that match the query (BLA never surfaces a non-matching file).
//
// Run: node run.mjs   (cwd = poc/, aurora at ../../aurora or ~/PycharmProjects/aurora)

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { QUERIES } from "./queries.mjs";

const AURORA = ["/home/hamr/PycharmProjects/aurora", "/home/hamr/Documents/PycharmProjects/aurora"]
  .find(existsSync);
if (!AURORA) throw new Error("aurora repo not found");
const DECAY = 0.5;
const W = { bm25: 0.5, bla: 0.3, spread: 0.2 };
const git = (...a) => execFileSync("git", ["-C", AURORA, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });

// ---- tokenization (code-aware: split snake_case + camelCase, like aurora's tokenizer) ----
const STOP = new Set("the a an is are be how where what when which does do i of to into for from on in it its and or s as we use used using system code".split(" "));
function splitIdent(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")     // camelCase -> camel Case
    .replace(/[^A-Za-z0-9]+/g, " ")              // snake/dots/slashes -> spaces
    .toLowerCase().split(/\s+/).filter(Boolean);
}
function keywords(q) {
  return [...new Set(splitIdent(q).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

// ---- collect files ----
const files = git("ls-files", "*.py").trim().split("\n").filter(Boolean);
const fileSet = new Set(files);

// ---- module path -> file (for import edges) ----
const modToFile = new Map();
for (const f of files) {
  const i = f.indexOf("/src/");
  if (i < 0) continue;
  let mod = f.slice(i + 5).replace(/\.py$/, "").replace(/\//g, ".").replace(/\.__init__$/, "");
  modToFile.set(mod, f);
}

// ---- import edges (undirected, intra-repo only) ----
const neighbors = new Map(files.map((f) => [f, new Set()]));
const importRe = /^\s*(?:from\s+([\w.]+)\s+import\s+([\w,\s*]+)|import\s+([\w.]+))/gm;
function resolve(mod) {
  if (modToFile.has(mod)) return modToFile.get(mod);
  const cut = mod.split("."); cut.pop();              // from pkg.mod import sym -> try pkg.mod's parent
  const parent = cut.join(".");
  return modToFile.get(parent) || null;
}
for (const f of files) {
  const text = readFileSync(join(AURORA, f), "utf8");
  let m;
  while ((m = importRe.exec(text))) {
    const cands = [];
    if (m[1]) {                                        // from X import a, b
      cands.push(m[1]);
      for (const name of m[2].split(",").map((x) => x.trim().split(" ")[0]).filter(Boolean))
        cands.push(`${m[1]}.${name}`);
    }
    if (m[3]) cands.push(m[3]);                         // import X.Y
    for (const c of cands) {
      const tgt = resolve(c);
      if (tgt && tgt !== f) { neighbors.get(f).add(tgt); neighbors.get(tgt).add(f); }
    }
  }
}

// ---- git-seeded base-level activation: BLA = ln(Σ age_days^-d) ----
const NOW = parseInt(git("log", "-1", "--format=%at").trim(), 10);
const commits = new Map(files.map((f) => [f, []]));
{
  const log = git("log", "--format=C%at", "--name-only", "--", "*.py");
  let t = null;
  for (const line of log.split("\n")) {
    if (/^C\d+$/.test(line)) { t = parseInt(line.slice(1), 10); continue; }
    if (t != null && fileSet.has(line)) commits.get(line).push(t);
  }
}
const bla = new Map();
for (const f of files) {
  const ts = commits.get(f);
  if (!ts.length) { bla.set(f, 0); continue; }          // never-touched = neutral
  let sum = 0;
  for (const t of ts) { const days = Math.max((NOW - t) / 86400, 1); sum += Math.pow(days, -DECAY); }
  bla.set(f, Math.log(sum));                             // recency (small age) + frequency (more terms)
}

// ---- build FTS5 index. path tokens folded into body so filename matches count (both rankers). ----
const db = new Database(":memory:");
db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, txt)");
const ins = db.prepare("INSERT INTO docs(rowid, path, txt) VALUES (?,?,?)");
const rowToFile = [];
const insMany = db.transaction(() => {
  files.forEach((f, idx) => {
    const body = readFileSync(join(AURORA, f), "utf8");
    const pathTokens = splitIdent(f).join(" ");
    const codeTokens = splitIdent(body).join(" ");      // camelCase/snake split, mirrors aurora tokenizer
    ins.run(idx + 1, f, `${pathTokens} ${pathTokens} ${body} ${codeTokens}`); // path doubled = light boost
    rowToFile[idx + 1] = f;
  });
});
insMany();

// ---- rankers ----
function matchQuery(q) {
  const kws = keywords(q);
  if (!kws.length) return [];
  const match = kws.map((k) => `"${k}"`).join(" OR ");
  // bm25() lower = better; flip sign so higher = more relevant
  const rows = db.prepare("SELECT rowid, -bm25(docs) AS rel FROM docs WHERE docs MATCH ? ORDER BY rel DESC").all(match);
  return rows.map((r) => ({ file: rowToFile[r.rowid], rel: r.rel }));
}
const minmax = (arr, get) => {
  const vals = arr.map(get); const lo = Math.min(...vals), hi = Math.max(...vals);
  return (x) => (hi > lo ? (get(x) - lo) / (hi - lo) : (arr.length === 1 ? 1 : 0));
};
// variants: weight vectors over [bm25, bla, spread]
const VARIANTS = {
  baseline: [1.0, 0.0, 0.0],
  "+bla":   [0.6, 0.4, 0.0],
  "+spread":[0.6, 0.0, 0.4],
  litectx:  [0.5, 0.3, 0.2],
};
function rank(q) {
  const cands = matchQuery(q);                           // FTS5 gate
  if (!cands.length) return { orders: {}, inFts: new Set() };
  const nb = minmax(cands, (c) => c.rel);                // normalized BM25 over candidates
  const bb = minmax(cands, (c) => bla.get(c.file) ?? 0); // normalized git BLA over candidates
  const relNormFull = new Map(cands.map((c) => [c.file, nb(c)]));
  const feats = cands.map((c) => {
    let spread = 0;                                      // 1-hop: best neighbor relevance
    for (const n of neighbors.get(c.file)) if (relNormFull.has(n)) spread = Math.max(spread, relNormFull.get(n));
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
const rankOf = (list, target) => { const i = list.indexOf(target); return i < 0 ? Infinity : i + 1; };
const rr = (r) => (r === Infinity ? 0 : 1 / r);

const results = QUERIES.map((Q) => {
  const { orders, inFts } = rank(Q.q);
  const ranks = {};
  for (const v of VNAMES) ranks[v] = orders[v] ? rankOf(orders[v], Q.target) : Infinity;
  return { ...Q, ranks, matched: inFts.has(Q.target) };
});

function agg(rows, v) {
  const n = rows.length;
  return {
    mrr: rows.reduce((s, r) => s + rr(r.ranks[v]), 0) / n,
    p1: rows.filter((r) => r.ranks[v] === 1).length / n,
    p3: rows.filter((r) => r.ranks[v] <= 3).length / n,
    p5: rows.filter((r) => r.ranks[v] <= 5).length / n,
  };
}

// ---- report ----
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";
const fmt = (r) => (r === Infinity ? " —" : String(r).padStart(2));
console.log(`\naurora: ${files.length} .py files · NOW=${new Date(NOW * 1000).toISOString().slice(0, 10)} · import-edges=${[...neighbors.values()].reduce((s, x) => s + x.size, 0) / 2}\n`);
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
console.log(`  litectx re-rank vs baseline: moved ${moved.length}/${results.length} — ${better} better, ${moved.length - better} worse.\n`);
