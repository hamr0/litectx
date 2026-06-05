// litectx Slice-4 Step-0 POC — spreading with REAL-ish edges. THROWAWAY. Not shipped.
//
// The original POC (run.mjs) validated 1-hop spreading on BOTH repos (+0.028 aurora /
// +0.021 gitdone) using IMPORT edges only. Slice 4 ships TWO edge types (calls + imports,
// ledger §11). Two questions before building the real `edges` module:
//   Q1  Does spreading still lift now that slice-3 raised the BM25 baseline (code-aware body)?
//   Q2  Do CALL edges help recall too, or just imports? (calls are the blast-radius signal —
//       do they also carry relevance for spreading, or only add noise?)
//
// Edge approximations (throwaway — the real module uses tree-sitter call-queries + ripgrep -w):
//   imports : python `import`/`from` + cjs relative `require` (verbatim from run.mjs)
//   calls   : symbol-def scan (def/class/function/const NAME) → symbol→file map; file A links to
//             file B if A's word-set contains a symbol B defines (name len >= 4, skip symbols
//             defined in >3 files as ambiguous). Over-counts by design (doctrine: over-count ok).
// Spreading: 1-hop, candidate inherits the best BM25-normed relevance among graph neighbors
// (same model as run.mjs). FTS gate identical to run.mjs so baseline == the validated baseline.

import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const STOP = new Set("the a an is are be how where what when which does do i of to into for from on in it its and or s as we use used using system code module responsible".split(" "));
const splitIdent = (s) => s
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[^A-Za-z0-9]+/g, " ")
  .toLowerCase().split(/\s+/).filter(Boolean);
const keywords = (q) => [...new Set(splitIdent(q).filter((w) => w.length >= 3 && !STOP.has(w)))];
const minmax = (arr, get) => {
  const v = arr.map(get), lo = Math.min(...v), hi = Math.max(...v);
  return (x) => (hi > lo ? (get(x) - lo) / (hi - lo) : (arr.length === 1 ? 1 : 0));
};
const rr = (r) => (r === Infinity ? 0 : 1 / r);
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";

// symbol definitions per language (cheap regex; throwaway stand-in for tree-sitter def-queries)
const DEF_RE = [
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:def|class|function)\s+([A-Za-z_]\w+)/g, // py/js/ts def/class/function
  /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w+)\s*=/g,                 // js/ts arrow/func consts
];

const DATASETS = process.argv[2] ? [process.argv[2]] : ["aurora", "gitdone"];
const rows = [];

for (const name of DATASETS) {
  const ds = (await import(`./datasets/${name}.mjs`)).default;
  const ROOT = ds.roots.find(existsSync);
  if (!ROOT) { console.log(`\n[${name}] repo not found — skipped`); continue; }
  const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });

  const files = git("ls-files", ...ds.pathspecs).trim().split("\n").filter(Boolean);
  const fileSet = new Set(files);
  const text = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

  // ---- import edges (undirected) ----
  const imp = new Map(files.map((f) => [f, new Set()]));
  const linkImp = (a, b) => { if (b && b !== a && fileSet.has(b)) { imp.get(a).add(b); imp.get(b).add(a); } };
  if (ds.edges === "python") {
    const modToFile = new Map();
    for (const f of files) { const i = f.indexOf("/src/"); if (i < 0) continue;
      modToFile.set(f.slice(i + 5).replace(/\.py$/, "").replace(/\//g, ".").replace(/\.__init__$/, ""), f); }
    const resolve = (m) => modToFile.get(m) || modToFile.get(m.split(".").slice(0, -1).join(".")) || null;
    const re = /^\s*(?:from\s+([\w.]+)\s+import\s+([\w,\s*]+)|import\s+([\w.]+))/gm;
    for (const f of files) { let m; while ((m = re.exec(text.get(f)))) {
      const c = []; if (m[1]) { c.push(m[1]); for (const n of m[2].split(",").map((x) => x.trim().split(" ")[0]).filter(Boolean)) c.push(`${m[1]}.${n}`); }
      if (m[3]) c.push(m[3]); for (const x of c) linkImp(f, resolve(x)); } }
  } else if (ds.edges === "cjs") {
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    for (const f of files) { let m; while ((m = re.exec(text.get(f)))) {
      const base = join(dirname(f), m[1]).replace(/\\/g, "/");
      linkImp(f, [base, `${base}.js`, `${base}/index.js`].find((p) => fileSet.has(p))); } }
  }

  // ---- call-ish edges via symbol-def → reference scan ----
  const defFiles = new Map(); // symbol -> Set(file)
  for (const f of files) for (const re of DEF_RE) { re.lastIndex = 0; let m;
    while ((m = re.exec(text.get(f)))) { const s = m[1];
      if (s.length < 4) continue; if (!defFiles.has(s)) defFiles.set(s, new Set()); defFiles.get(s).add(f); } }
  const symToFile = new Map(); // unambiguous defs only (<=3 definers)
  for (const [s, fs] of defFiles) if (fs.size <= 3) for (const f of fs) symToFile.set(`${s}@${f}`, [s, f]);
  const wordsOf = new Map(files.map((f) => [f, new Set((text.get(f).match(/[A-Za-z_]\w+/g) || []))]));
  const call = new Map(files.map((f) => [f, new Set()]));
  const linkCall = (a, b) => { if (b !== a) { call.get(a).add(b); call.get(b).add(a); } };
  const bySym = new Map(); for (const [, [s, f]] of symToFile) { if (!bySym.has(s)) bySym.set(s, []); bySym.get(s).push(f); }
  for (const a of files) { const w = wordsOf.get(a);
    for (const [s, defs] of bySym) if (w.has(s)) for (const b of defs) linkCall(a, b); }

  // ---- FTS gate (identical to run.mjs → baseline == validated baseline) ----
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, txt)");
  const ins = db.prepare("INSERT INTO docs(rowid, path, txt) VALUES (?,?,?)");
  const rowToFile = [];
  db.transaction(() => { files.forEach((f, i) => {
    const pathTok = splitIdent(f).join(" ");
    ins.run(i + 1, f, `${pathTok} ${pathTok} ${text.get(f)} ${splitIdent(text.get(f)).join(" ")}`);
    rowToFile[i + 1] = f; }); })();
  const matchQuery = (q) => { const kws = keywords(q); if (!kws.length) return [];
    return db.prepare("SELECT rowid, -bm25(docs) AS rel FROM docs WHERE docs MATCH ? ORDER BY rel DESC")
      .all(kws.map((k) => `"${k}"`).join(" OR ")).map((r) => ({ file: rowToFile[r.rowid], rel: r.rel })); };

  // edge-set chooser + variants
  const both = new Map(files.map((f) => [f, new Set([...imp.get(f), ...call.get(f)])]));
  const NB = { imports: imp, calls: call, both };
  const VARIANTS = {
    baseline: { nb: null, w: 0 },
    "imp.4": { nb: "imports", w: 0.4 }, "imp.3": { nb: "imports", w: 0.3 },
    "call.4": { nb: "calls", w: 0.4 }, "call.3": { nb: "calls", w: 0.3 },
    "both.4": { nb: "both", w: 0.4 }, "both.3": { nb: "both", w: 0.3 },
  };
  const VNAMES = Object.keys(VARIANTS);
  const rankOf = (list, t) => { const i = list.indexOf(t); return i < 0 ? Infinity : i + 1; };

  const results = ds.queries.map((Q) => {
    const cands = matchQuery(Q.q);
    if (!cands.length) return { ...Q, ranks: Object.fromEntries(VNAMES.map((v) => [v, Infinity])) };
    const nb = minmax(cands, (c) => c.rel);
    const relNorm = new Map(cands.map((c) => [c.file, nb(c)]));
    const ranks = {};
    for (const [v, cfg] of Object.entries(VARIANTS)) {
      const graph = cfg.nb ? NB[cfg.nb] : null;
      const scored = cands.map((c) => {
        let spread = 0;
        if (graph) for (const n of graph.get(c.file) || []) if (relNorm.has(n)) spread = Math.max(spread, relNorm.get(n));
        return { file: c.file, s: (1 - cfg.w) * nb(c) + cfg.w * spread };
      });
      ranks[v] = rankOf(scored.sort((a, b) => b.s - a.s).map((x) => x.file), Q.target);
    }
    return { ...Q, ranks };
  });
  db.close();

  const agg = (rs, v) => ({ mrr: rs.reduce((s, r) => s + rr(r.ranks[v]), 0) / rs.length,
    p1: rs.filter((r) => r.ranks[v] === 1).length / rs.length,
    p3: rs.filter((r) => r.ranks[v] <= 3).length / rs.length,
    p5: rs.filter((r) => r.ranks[v] <= 5).length / rs.length });
  const table = (label, rs) => { console.log(`\n  ${label} (n=${rs.length})`); const base = agg(rs, "baseline").mrr;
    for (const v of VNAMES) { const m = agg(rs, v);
      const d = v === "baseline" ? "" : `   Δmrr ${m.mrr - base >= 0 ? "+" : ""}${(m.mrr - base).toFixed(3)}${m.mrr >= base ? "  ✓" : ""}`;
      console.log(`    ${v.padEnd(9)} MRR ${m.mrr.toFixed(3)}  P@1 ${pct(m.p1)}  P@3 ${pct(m.p3)}  P@5 ${pct(m.p5)}${d}`); } };

  const eImp = [...imp.values()].reduce((s, x) => s + x.size, 0) / 2;
  const eCall = [...call.values()].reduce((s, x) => s + x.size, 0) / 2;
  console.log(`\n[${name}] ${files.length} files · import-edges=${eImp} · call-ish-edges=${eCall}`);
  table("ALL", results);
  table("HARD", results.filter((r) => r.diff === "hard"));
  rows.push({ name, results, agg });
}

console.log(`\n${"=".repeat(64)}\nVERDICT — spreading weights ≥ baseline on EVERY repo (ALL MRR):`);
const VN = ["imp.4", "imp.3", "call.4", "call.3", "both.4", "both.3"];
for (const v of VN) {
  const per = rows.map(({ name, results, agg }) => { const b = agg(results, "baseline").mrr, m = agg(results, v).mrr;
    return { name, ok: m >= b, d: m - b }; });
  console.log(`  ${per.every((r) => r.ok) ? "✓ ADOPTABLE" : "✗ rejected  "}  ${v.padEnd(8)}  ${per.map((r) => `${r.name} ${r.d >= 0 ? "+" : ""}${r.d.toFixed(3)}`).join("   ")}`);
}
console.log();
