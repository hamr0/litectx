// THROWAWAY slice-2 POC: does tree-sitter SYMBOL-level chunking hold-or-beat the
// file-granularity BM25 baseline on the multi-repo gate? (PRD §11.2 slice 2.)
//
// Binding under test: web-tree-sitter (WASM) + prebuilt tree-sitter-wasms grammars.
// Chunker: per-language def-node set (the embryo of langdef.js) → one chunk per
// function/method/class + a file "preamble" chunk for top-level lines no def covers.
// Bench: queries target FILES, so we collapse chunks→best-rank-per-file and measure
// file rank, head-to-head with file-granularity (same FTS5 body construction as store.js).
//
// Usage: node chunk-poc.mjs           (both datasets, both granularities)
//        node chunk-poc.mjs gitdone

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, extname } from "node:path";
import Database from "better-sqlite3";
import Parser from "web-tree-sitter"; // 0.22.x: CJS default export is the Parser class
import { splitIdent, ftsMatch } from "../src/tokenize.js";

const WASM = "node_modules/tree-sitter-wasms/out";

// --- langdef embryo: extension → grammar + the def-node types that become chunks ---
const LANG = {
  ".py": { wasm: "tree-sitter-python.wasm", defs: new Set(["function_definition", "class_definition"]) },
  ".js": { wasm: "tree-sitter-javascript.wasm", defs: new Set(["function_declaration", "method_definition", "class_declaration", "arrow_function", "function_expression"]) },
  ".ts": { wasm: "tree-sitter-typescript.wasm", defs: new Set(["function_declaration", "method_definition", "class_declaration", "arrow_function", "function_expression"]) },
};

await Parser.init();
const Language = Parser.Language; // populated after init() in 0.22.x
/** @type {Map<string, any>} */
const parsers = new Map();
for (const [ext, cfg] of Object.entries(LANG)) {
  const lang = await Language.load(join(WASM, cfg.wasm));
  const p = new Parser();
  p.setLanguage(lang);
  parsers.set(ext, p);
}

// Walk the tree, collect [startLine, endLine] for every def-node. Returns sorted,
// non-redundant ranges; a "preamble" chunk later covers lines no def-node owns.
function defRanges(node, defs, out) {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (defs.has(c.type)) out.push([c.startPosition.row, c.endPosition.row, c.type]);
    defRanges(c, defs, out); // recurse for nested methods/classes (over-counting is fine)
  }
  return out;
}

/** file → list of { path, startLine, endLine, text, type } chunks */
function chunkFile(root, rel) {
  const ext = extname(rel).toLowerCase();
  const cfg = LANG[ext];
  const src = readFileSync(join(root, rel), "utf8");
  const lines = src.split("\n");
  if (!cfg) return [{ path: rel, startLine: 0, endLine: lines.length - 1, text: src, type: "file" }];

  const tree = parsers.get(ext).parse(src);
  const ranges = defRanges(tree.rootNode, cfg.defs, []);
  const chunks = ranges.map(([s, e, type]) => ({ path: rel, startLine: s, endLine: e, text: lines.slice(s, e + 1).join("\n"), type }));

  // preamble: top-level lines no def-node covers (imports, constants, module docstring)
  const covered = new Array(lines.length).fill(false);
  for (const [s, e] of ranges) for (let i = s; i <= e; i++) covered[i] = true;
  const pre = lines.filter((_, i) => !covered[i]).join("\n").trim();
  if (pre) chunks.push({ path: rel, startLine: 0, endLine: lines.length - 1, text: pre, type: "preamble" });
  return chunks.length ? chunks : [{ path: rel, startLine: 0, endLine: lines.length - 1, text: src, type: "file" }];
}

function collectFiles(root, include, pathspecs) {
  const inc = new Set(include);
  return execFileSync("git", ["-C", root, "ls-files", ...(pathspecs ?? [])], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n").filter(Boolean).filter((f) => inc.has(extname(f).toLowerCase()));
}

// FTS5 store mirroring src/store.js: body = path tokens doubled + content.
function buildIndex(rows) {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, body)");
  const ins = db.prepare("INSERT INTO docs(path, body) VALUES (@path, @body)");
  const tx = db.transaction(() => {
    for (const r of rows) {
      const pt = splitIdent(r.path).join(" ");
      ins.run({ path: r.path, body: `${pt} ${pt}\n${r.text}` });
    }
  });
  tx();
  return db;
}

// return ALL matching chunks (path, score) so we can pool per file different ways
function searchAll(db, query) {
  const m = ftsMatch(query);
  if (!m) return [];
  return db.prepare("SELECT path, -bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score DESC").all(m);
}

// pool chunk scores → one score per file, rank files, return target's rank.
// mode: "max" (best chunk), "sum" (all chunks), "top3" (sum of 3 best chunks).
function fileRank(hits, target, mode) {
  /** @type {Map<string, number[]>} */
  const byFile = new Map();
  for (const h of hits) (byFile.get(h.path) ?? byFile.set(h.path, []).get(h.path)).push(h.score);
  const scored = [...byFile.entries()].map(([path, ss]) => {
    ss.sort((a, b) => b - a);
    const score = mode === "max" ? ss[0] : mode === "top3" ? ss.slice(0, 3).reduce((a, b) => a + b, 0) : ss.reduce((a, b) => a + b, 0);
    return { path, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const i = scored.findIndex((r) => r.path === target);
  return i < 0 ? Infinity : i + 1;
}

const rr = (r) => (r === Infinity ? 0 : 1 / r);
const pct = (x) => (x * 100).toFixed(0).padStart(3) + "%";
const agg = (rs) => ({
  mrr: rs.reduce((s, r) => s + rr(r.rank), 0) / rs.length,
  p1: rs.filter((r) => r.rank === 1).length / rs.length,
  p3: rs.filter((r) => r.rank <= 3).length / rs.length,
  p5: rs.filter((r) => r.rank <= 5).length / rs.length,
});
function report(label, rows) {
  const m = agg(rows);
  console.log(`    ${label.padEnd(12)} MRR ${m.mrr.toFixed(3)}  P@1 ${pct(m.p1)}  P@3 ${pct(m.p3)}  P@5 ${pct(m.p5)}`);
}

const DATASETS = process.argv[2] ? [process.argv[2]] : ["aurora", "gitdone"];
const DEPTH = 100;

for (const name of DATASETS) {
  const ds = (await import(`./datasets/${name}.mjs`)).default;
  const root = ds.roots.find(existsSync);
  if (!root) { console.log(`\n[${name}] repo not found — skipped`); continue; }

  const files = collectFiles(root, ds.include, ds.pathspecs);

  // file-granularity rows (baseline reproduction)
  const fileRows = files.map((rel) => ({ path: rel, text: readFileSync(join(root, rel), "utf8") }));
  // chunk-granularity rows
  const chunkRows = files.flatMap((rel) => chunkFile(root, rel));

  const fileDb = buildIndex(fileRows);
  const chunkDb = buildIndex(chunkRows);

  const run = (db, mode) => ds.queries.map((Q) => ({ ...Q, rank: fileRank(searchAll(db, Q.q), Q.target, mode) }));

  // FUSED: file-level BM25 gate (preserves baseline) + α·(best chunk BM25), min-max
  // normalized per query. Tests whether chunk evidence can BEAT file-only ranking.
  const norm = (m) => { const v = [...m.values()]; const lo = Math.min(...v), hi = Math.max(...v); const d = hi - lo || 1; const o = new Map(); for (const [k, x] of m) o.set(k, (x - lo) / d); return o; };
  const bestPerFile = (hits) => { const m = new Map(); for (const h of hits) if (!m.has(h.path) || h.score > m.get(h.path)) m.set(h.path, h.score); return m; };
  const runFused = (alpha) => ds.queries.map((Q) => {
    const fileScores = bestPerFile(searchAll(fileDb, Q.q));
    const chunkScores = bestPerFile(searchAll(chunkDb, Q.q));
    const nf = norm(fileScores), nc = norm(chunkScores);
    const fused = new Map();
    for (const p of new Set([...nf.keys(), ...nc.keys()])) fused.set(p, (nf.get(p) ?? 0) + alpha * (nc.get(p) ?? 0));
    const scored = [...fused.entries()].map(([path, score]) => ({ path, score })).sort((a, b) => b.score - a.score);
    const i = scored.findIndex((r) => r.path === Q.target);
    return { ...Q, rank: i < 0 ? Infinity : i + 1 };
  });

  console.log(`\n[${name}] ${files.length} files · ${chunkRows.length} chunks (${(chunkRows.length / files.length).toFixed(1)}/file)`);
  const variants = [
    ["FILE-GRANULARITY (baseline)", () => run(fileDb, "max")],
    ["CHUNK · max-pool", () => run(chunkDb, "max")],
    ["CHUNK · top3-pool", () => run(chunkDb, "top3")],
    ["FUSED file+chunk α=0.3", () => runFused(0.3)],
    ["FUSED file+chunk α=0.6", () => runFused(0.6)],
  ];
  for (const [label, fn] of variants) {
    const rows = fn();
    console.log(`  ${label}:`);
    report("ALL", rows);
    report("EASY", rows.filter((r) => r.diff === "easy"));
    report("HARD", rows.filter((r) => r.diff === "hard"));
  }
  fileDb.close(); chunkDb.close();
}
console.log();
