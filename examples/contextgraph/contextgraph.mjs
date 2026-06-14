// contextgraph — visualize ANY CE design built with litectx.
//
// `codegraph` (see ../graph-view) maps the CONTENT graph: files, import edges, risk. `contextgraph` is
// the other view — the PIPELINE: the verbs a CE design composes (index/recall/assemble/compress/
// summaryWindow/remember/impact …) as nodes, and the DATA handed between them as edges. It answers
// "what does this context-engineering design actually do, end to end?" — and it's generated from a REAL
// run, so it reports what happened (kept/compressed/dropped counts, tokens), not a hand-drawn intent.
//
// The recorder below is the prototype of the future `src/contextgraph.js` lib primitive. It works
// because every litectx verb already RETURNS an accountable result — so a thin tracer over return
// values reconstructs the whole graph; no internal instrumentation needed.
//
// Run from the repo root:  node examples/contextgraph/contextgraph.mjs
// Outputs (written next to this file): contextgraph.json (the trace) · contextgraph.svg · contextgraph.md
// Then open index.html for the interactive view, or look at the .svg / .md.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LiteCtx, assemble } from "../../src/index.js"; // adopters: import from "litectx"

const here = dirname(fileURLToPath(import.meta.url));

// ---- the recorder: a node per verb call, an edge per dataflow handoff (prototype of the lib primitive)
class ContextGraph {
  constructor() { this.nodes = []; this.edges = []; }
  /** @param {{verb:string, detail:string, stats?:object, accent?:string}} n → node id */
  node(n) { const id = `n${this.nodes.length}`; this.nodes.push({ id, ...n }); return id; }
  /** record the data handed from one verb to the next */
  edge(from, to, label) { this.edges.push({ from, to, label }); return to; }
  json() { return { nodes: this.nodes, edges: this.edges }; }

  /** Mermaid flowchart — agent-readable, renders on GitHub / in any markdown preview. */
  mermaid() {
    const esc = (s) => String(s).replace(/"/g, "'");
    const out = ["flowchart LR"];
    for (const n of this.nodes) out.push(`  ${n.id}["<b>${esc(n.verb)}</b><br/><small>${esc(n.detail)}</small>"]`);
    for (const e of this.edges) out.push(`  ${e.from} -->|"${esc(e.label)}"| ${e.to}`);
    return out.join("\n");
  }

  /** Self-contained SVG render (zero deps) — a horizontal pipeline, so it's viewable without a browser. */
  svg() {
    const NW = 212, NH = 68, GAP = 168, PAD = 28, CY = 104;
    const W = PAD * 2 + this.nodes.length * NW + (this.nodes.length - 1) * GAP, H = 184;
    const x = (i) => PAD + i * (NW + GAP);
    const idx = (id) => this.nodes.findIndex((n) => n.id === id);
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
    const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`];
    p.push(`<rect width="${W}" height="${H}" fill="#0d1117"/>`);
    p.push(`<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#768390"/></marker></defs>`);
    p.push(`<text x="${PAD}" y="30" fill="#adbac7" font-size="13" font-weight="bold">litectx · contextgraph</text>`);
    p.push(`<text x="${PAD}" y="48" fill="#636e7b" font-size="10.5">a CE pipeline, generated from a real run — verbs as nodes, data as edges</text>`);
    for (const e of this.edges) {
      const x1 = x(idx(e.from)) + NW, x2 = x(idx(e.to)), mx = (x1 + x2) / 2;
      p.push(`<line x1="${x1}" y1="${CY}" x2="${x2 - 5}" y2="${CY}" stroke="#768390" stroke-width="1.5" marker-end="url(#arrow)"/>`);
      const lbl = cut(e.label, 30), lw = lbl.length * 6.1 + 14;
      p.push(`<rect x="${mx - lw / 2}" y="${CY - 24}" width="${lw}" height="17" rx="5" fill="#161b22" stroke="#30363d"/>`);
      p.push(`<text x="${mx}" y="${CY - 12}" fill="#adbac7" font-size="10" text-anchor="middle">${esc(lbl)}</text>`);
    }
    this.nodes.forEach((n, i) => {
      const nx = x(i), fill = n.accent || "#21262d";
      p.push(`<rect x="${nx}" y="${CY - NH / 2}" width="${NW}" height="${NH}" rx="11" fill="${fill}" stroke="#444c56"/>`);
      p.push(`<text x="${nx + NW / 2}" y="${CY - 6}" fill="#f0f6fc" font-size="15" font-weight="bold" text-anchor="middle">${esc(n.verb)}</text>`);
      p.push(`<text x="${nx + NW / 2}" y="${CY + 15}" fill="#909dab" font-size="10.5" text-anchor="middle">${esc(cut(n.detail, 30))}</text>`);
    });
    p.push(`</svg>`);
    return p.join("\n");
  }
}

// ---- run a REAL CE design over this repo: index → recall → assemble(+COMPRESS) -------------------
const g = new ContextGraph();
const repoRoot = join(here, "..", ".."); // index THIS repo regardless of cwd
const ctx = new LiteCtx({ root: repoRoot, dbPath: ":memory:" }); // embeddings off → deterministic graph

const stats = await ctx.index();
const indexN = g.node({ verb: "index", detail: `${stats?.files ?? "?"} files → graph`, stats });

const query = "assemble budget fit compress signature drop tier";
const hits = await ctx.recall(query, { kind: "code", n: 8, body: true });
const recallN = g.node({ verb: "recall", detail: `${hits.length} code hits`, stats: { query, kind: "code", hits: hits.length } });
g.edge(indexN, recallN, "query the index");

// SELECT is the caller's job (litectx doctrine) — the host turns hits into transcript Units it injects.
const units = hits.map((h, i) => ({
  id: h.chunk?.symbol ? `${h.path}#${h.chunk.symbol}` : `${h.path}#${i}`,
  role: "tool", content: h.body ?? "", kind: h.kind,
  format: h.path.split(".").pop(), symbol: h.chunk?.symbol,
}));
const inTokens = units.reduce((s, u) => s + Math.ceil((u.content?.length ?? 0) / 4), 0);
const budget = Math.round(inTokens * 0.45); // illustrative: tight enough to exercise FIT + COMPRESS + drop

const fit = await assemble(units, { budget });
const compressed = fit.units.filter((u) => u.compressed).length;
const verbatim = fit.units.length - compressed;
const assembleN = g.node({ verb: "assemble", detail: `budget ${budget} tok`, stats: { budget, inUnits: units.length, inTokens } });
g.edge(recallN, assembleN, `${units.length} units · ${inTokens} tok`);

const ctxN = g.node({ verb: "→ context window", detail: `${fit.tokens} tok assembled`, accent: "#1c3a2e", stats: { tokens: fit.tokens, verbatim, compressed, dropped: fit.dropped.length } });
g.edge(assembleN, ctxN, `kept ${verbatim} · comp ${compressed} · drop ${fit.dropped.length}`);

// ---- emit: the trace JSON (the primitive's output) + two renders ---------------------------------
writeFileSync(join(here, "contextgraph.json"), JSON.stringify(g.json(), null, 2) + "\n");
writeFileSync(join(here, "contextgraph.svg"), g.svg() + "\n");
writeFileSync(join(here, "contextgraph.md"), "# contextgraph (generated)\n\n```mermaid\n" + g.mermaid() + "\n```\n");

console.log(g.mermaid());
console.log(`\nwrote contextgraph.json · contextgraph.svg · contextgraph.md to ${here}`);
console.log(`open examples/contextgraph/index.html for the interactive view`);
