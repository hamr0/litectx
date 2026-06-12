// POC — validate the getNode/related graph-substrate accessors before wiring them into the API.
// Throwaway. Usage: node poc/graph-substrate-poc.mjs   (writes examples/graph-view/graph.json)
//
// RISKIEST ASSUMPTION (per prove-don't-assert) — NOT the trivial row-read:
//   Do the PERSISTED import edges form a real, navigable file-graph on a real repo, such that
//   getNode + related + impact COMPOSE into the click-and-explore goal? If the graph is empty or
//   trivial, the whole visualization premise is dead. So this indexes litectx's OWN src/ (modules
//   that genuinely import each other) and proves:
//     1. edges exist, are file→file, non-trivial.
//     2. getNode(path) → kind/format + chunks (symbols inside) + correct per-type edge COUNTS.
//        getNode is kind-agnostic: a written fact resolves too (zero chunks, zero edges).
//     3. related(path,{edge,dir,hops}) BFS → real neighbours; dir out/in/both; dedup; hop-cap holds.
//        `edge` is a GENERIC type param (default "import") so future CE edges slot in unchanged.
//     4. impact(symbol) composes as the SECOND accessor (blast radius), distinct from related.
//   Exercises the EXACT SQL getNode()/related() will ship, run directly against a real store.

import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { LiteCtx } from "../src/index.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, "..");

// Index litectx's own src/ into an ephemeral store → a real module import-graph.
const tmp = mkdtempSync(join(tmpdir(), "litectx-graphpoc-"));
const ctx = new LiteCtx({ root: repoRoot, dbPath: ":memory:", embeddings: false });
await ctx.index({ paths: ["src/"] });
const db = ctx.store.db;

// ── candidate SQL (verbatim what the shipped accessors will run) ───────────────────────────────

/** getNode(id): file node (with its chunks + per-type edge counts) OR written-memory node. */
function getNode(id) {
  const chunks = db
    .prepare("SELECT symbol, node_type AS nodeType, start_line AS startLine, end_line AS endLine FROM nodes WHERE path = ? ORDER BY start_line")
    .all(id);
  if (chunks.length) {
    const meta = db.prepare("SELECT kind, format FROM nodes WHERE path = ? LIMIT 1").get(id);
    const git = db.prepare("SELECT commits, last_commit AS lastCommit FROM git_sig WHERE path = ?").get(id) ?? null;
    const imports = db.prepare("SELECT COUNT(*) c FROM edges WHERE type='import' AND src_path = ?").get(id).c;
    const importedBy = db.prepare("SELECT COUNT(*) c FROM edges WHERE type='import' AND dst_path = ?").get(id).c;
    return { id, kind: meta.kind, format: meta.format, source: "file", git, chunks, edges: { imports, importedBy } };
  }
  const mem = db.prepare("SELECT kind, format, provenance FROM mem WHERE path = ?").get(id);
  if (mem) return { id, kind: mem.kind, format: mem.format, source: "direct", by: mem.provenance, chunks: [], edges: {} };
  return null;
}

/** related(id,{edge,dir,hops}): BFS over persisted edges of `type=edge`. dir out|in|both. */
function related(id, { edge = "import", dir = "both", hops = 1 } = {}) {
  const MAX_HOPS = 3;
  const depth = Math.min(hops, MAX_HOPS);
  const truncated = hops > MAX_HOPS;
  const outQ = db.prepare("SELECT dst_path AS p FROM edges WHERE type=? AND src_path=?");
  const inQ = db.prepare("SELECT src_path AS p FROM edges WHERE type=? AND dst_path=?");
  const seen = new Map([[id, 0]]); // path -> hop at which first reached
  const out = [];
  let frontier = [id];
  for (let h = 1; h <= depth; h++) {
    const next = [];
    for (const node of frontier) {
      const neigh = [];
      if (dir === "out" || dir === "both") for (const r of outQ.all(edge, node)) neigh.push([r.p, "out"]);
      if (dir === "in" || dir === "both") for (const r of inQ.all(edge, node)) neigh.push([r.p, "in"]);
      for (const [p, via] of neigh) {
        if (seen.has(p)) continue;
        seen.set(p, h);
        const meta = db.prepare("SELECT kind, format FROM nodes WHERE path=? LIMIT 1").get(p);
        out.push({ id: p, kind: meta?.kind ?? null, format: meta?.format ?? null, hops: h, via });
        next.push(p);
      }
    }
    frontier = next;
  }
  return { items: out, truncated };
}

// ── validation ────────────────────────────────────────────────────────────────────────────────

const fileCount = db.prepare("SELECT COUNT(DISTINCT path) c FROM nodes").get().c;
const edgeCount = db.prepare("SELECT COUNT(*) c FROM edges WHERE type='import'").get().c;
console.log(`indexed: ${fileCount} files, ${edgeCount} import edges`);
assert.ok(edgeCount >= 5, `RISK CHECK: graph must be non-trivial, got ${edgeCount} edges`);

// pick the most-connected file as the demo anchor (the hub a human would click first)
const hub = db
  .prepare("SELECT p, COUNT(*) c FROM (SELECT src_path p FROM edges WHERE type='import' UNION ALL SELECT dst_path p FROM edges WHERE type='import') GROUP BY p ORDER BY c DESC LIMIT 1")
  .get().p;

console.log("\n── getNode(hub) ──");
const node = getNode(hub);
assert.ok(node, "getNode must resolve an indexed file");
assert.ok(node.chunks.length > 0, "a code file must expose its symbols as chunks");
console.log(`${node.id}  kind=${node.kind} format=${node.format} chunks=${node.chunks.length} edges=${JSON.stringify(node.edges)}`);
console.log("  first chunks:", node.chunks.slice(0, 4).map((c) => `${c.symbol ?? c.nodeType}@${c.startLine}`).join(", "));
// edge counts must match what related returns directed
assert.equal(node.edges.imports, related(hub, { dir: "out", hops: 1 }).items.length, "getNode.imports must match related(out,1)");
assert.equal(node.edges.importedBy, related(hub, { dir: "in", hops: 1 }).items.length, "getNode.importedBy must match related(in,1)");

console.log("\n── related(hub, both, 1) ──");
const r1 = related(hub, { dir: "both", hops: 1 });
for (const it of r1.items) console.log(`  ${it.via.padEnd(3)} h${it.hops}  ${it.id}`);
assert.ok(r1.items.every((i) => i.id !== hub), "BFS must not include the seed");
assert.equal(new Set(r1.items.map((i) => i.id)).size, r1.items.length, "results must be deduped");

console.log("\n── related(hub, both, 3) — multi-hop reach + dedup ──");
const r3 = related(hub, { dir: "both", hops: 3 });
const byHop = r3.items.reduce((m, i) => ((m[i.hops] = (m[i.hops] || 0) + 1), m), {});
console.log("  reach by hop:", JSON.stringify(byHop), "total:", r3.items.length);
assert.ok(r3.items.length >= r1.items.length, "3-hop reach must cover 1-hop");
assert.equal(related(hub, { dir: "both", hops: 99 }).truncated, true, "hop cap must flag truncation");

console.log("\n── getNode kind-agnostic: a written fact ──");
await ctx.remember("fact:demo", "litectx ships a graph substrate.", { kind: "fact" });
const fact = getNode("fact:demo");
assert.ok(fact && fact.chunks.length === 0 && Object.keys(fact.edges).length === 0, "fact = zero-chunk zero-edge node");
console.log(`  ${fact.id}  kind=${fact.kind} source=${fact.source} by=${fact.by}`);

console.log("\n── impact(symbol) composes as the SECOND accessor (blast radius) ──");
const sym = node.chunks.find((c) => c.symbol)?.symbol;
const blast = sym ? await ctx.impact(sym) : null;
if (blast) console.log(`  impact(${sym}) → risk=${blast.risk} callers=${blast.callers?.length ?? 0}`);
console.log("  (related = imports/dependencies · impact = callers/blast — two distinct edges, a view overlays both)");

// ── bake impact() callers per file (the TRUE call-blast, distinct from imported-by) ──────────────
// related = imports (persisted, cheap). impact = called-by (on-demand rg+tree-sitter, ~150ms/symbol).
// Dedupe by symbol name so the bake is fast; attribute a symbol's caller files to the file(s) that
// DEFINE it. This is real impact() output, computed at index/dump time (recompute on re-index) — the
// fast-click human view's safety layer, NOT a per-click live call (33 symbols × 150ms would lag).
console.log("\n── baking impact() callers (real call-blast) ──");
const calledBy = new Map();      // definingFile -> Set(callerFiles)
const symDefs = db.prepare("SELECT DISTINCT symbol, path FROM nodes WHERE symbol IS NOT NULL").all();
const uniqSyms = [...new Set(symDefs.map((r) => r.symbol))];
const callersOf = new Map(), riskOf = new Map(); // symbol -> caller files / risk bucket (impact once per name)
for (const s of uniqSyms) {
  const r = await ctx.impact(s).catch(() => null);
  callersOf.set(s, [...new Set((r?.callers ?? []).map((c) => c.path))]); // caller FILES (callers = [{path,line}])
  riskOf.set(s, r?.risk ?? "low");
}
for (const { symbol, path } of symDefs) {
  const set = calledBy.get(path) ?? calledBy.set(path, new Set()).get(path);
  for (const f of callersOf.get(symbol) ?? []) if (f !== path) set.add(f);
}
const totalCallEdges = [...calledBy.values()].reduce((n, s) => n + s.size, 0);
console.log(`  impact() resolved call-blast on ${uniqSyms.length} unique symbols → ${totalCallEdges} file-level caller links`);

// ── dump the graph for the example GUI ──────────────────────────────────────────────────────────
const allFiles = db.prepare("SELECT DISTINCT path FROM nodes ORDER BY path").all().map((r) => r.path);
const RANK = { low: 0, medium: 1, high: 2 };
const fileSyms = new Map(); // file -> its named symbols (for the worst-risk badge)
for (const { symbol, path } of symDefs) (fileSyms.get(path) ?? fileSyms.set(path, []).get(path)).push(symbol);
const nodes = allFiles.map((p) => {
  const n = getNode(p);
  const syms = fileSyms.get(p) ?? [];
  const risk = syms.reduce((w, s) => (RANK[riskOf.get(s) ?? "low"] > RANK[w] ? riskOf.get(s) : w), "low");
  return {
    id: p, kind: n.kind, symbols: n.chunks.filter((c) => c.symbol).length,
    imports: n.edges.imports, importedBy: n.edges.importedBy, // edges = related (EXACT)
    callers: (calledBy.get(p) ?? new Set()).size,             // impact() caller count (over-counts) — the badge
    risk,                                                     // worst impact() risk among the file's symbols — the badge
  };
});
const edges = db.prepare("SELECT src_path AS source, dst_path AS target FROM edges WHERE type='import'").all();
const outDir = join(repoRoot, "examples", "graph-view");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "graph.json"), JSON.stringify({ root: "src/", hub, nodes, edges }, null, 2));
console.log(`\n✓ all assertions passed — wrote examples/graph-view/graph.json (${nodes.length} nodes, ${edges.length} edges)`);
ctx.close();
