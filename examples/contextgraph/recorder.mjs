// contextgraph recorder — the reusable core (prototype of a future src/contextgraph.js primitive).
//
// A node per verb call, an edge per dataflow handoff. It works because every litectx verb already
// RETURNS an accountable result (recall → hits; assemble → {units, dropped, tokens} with compressed/
// summary flags) — so the trace is read straight from return values, no internal instrumentation.
//
// Layout is layered: a node's `col` is its depth in the pipeline, `row` separates parallel branches
// (e.g. an A/B bench running the same input two ways). Both default to a single horizontal line.

export class ContextGraph {
  constructor() { this.nodes = []; this.edges = []; }

  /** @param {{verb:string, detail:string, stats?:object, accent?:string, col?:number, row?:number}} n → node id */
  node(n) {
    const id = `n${this.nodes.length}`;
    const col = n.col ?? this.nodes.length, row = n.row ?? 0;
    this.nodes.push({ id, ...n, col, row });
    return id;
  }
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

  /** Self-contained SVG (zero deps) — layered layout, so it's viewable without a browser. */
  svg(opts = {}) {
    const title = opts.title ?? "litectx · contextgraph";
    const subtitle = opts.subtitle ?? "a CE pipeline, generated from a real run — verbs as nodes, data as edges";
    const NW = 212, NH = 68, GAPX = 172, GAPY = 50, PAD = 28, TOP = 72;
    const cols = Math.max(...this.nodes.map((n) => n.col)) + 1, rows = Math.max(...this.nodes.map((n) => n.row)) + 1;
    const W = PAD * 2 + cols * NW + (cols - 1) * GAPX, H = TOP + rows * NH + (rows - 1) * GAPY + PAD;
    const byId = (id) => this.nodes.find((n) => n.id === id);
    const cx = (n) => PAD + n.col * (NW + GAPX) + NW / 2, cy = (n) => TOP + n.row * (NH + GAPY) + NH / 2;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));
    const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`];
    p.push(`<rect width="${W}" height="${H}" fill="#0d1117"/>`);
    p.push(`<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#768390"/></marker></defs>`);
    p.push(`<text x="${PAD}" y="30" fill="#adbac7" font-size="13" font-weight="bold">${esc(title)}</text>`);
    p.push(`<text x="${PAD}" y="48" fill="#636e7b" font-size="10.5">${esc(subtitle)}</text>`);
    for (const e of this.edges) {
      const s = byId(e.from), t = byId(e.to);
      const x1 = cx(s) + NW / 2, y1 = cy(s), x2 = cx(t) - NW / 2, y2 = cy(t);
      p.push(`<line x1="${x1}" y1="${y1}" x2="${x2 - 5}" y2="${y2}" stroke="#768390" stroke-width="1.5" marker-end="url(#arrow)"/>`);
      const lbl = cut(e.label || "", 30), mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      if (lbl) {
        const lw = lbl.length * 6.1 + 14;
        p.push(`<rect x="${mx - lw / 2}" y="${my - 21}" width="${lw}" height="17" rx="5" fill="#161b22" stroke="#30363d"/>`);
        p.push(`<text x="${mx}" y="${my - 9}" fill="#adbac7" font-size="10" text-anchor="middle">${esc(lbl)}</text>`);
      }
    }
    for (const n of this.nodes) {
      const nx = cx(n) - NW / 2, ny = cy(n) - NH / 2, fill = n.accent || "#21262d";
      p.push(`<rect x="${nx}" y="${ny}" width="${NW}" height="${NH}" rx="11" fill="${fill}" stroke="#444c56"/>`);
      p.push(`<text x="${cx(n)}" y="${cy(n) - 6}" fill="#f0f6fc" font-size="15" font-weight="bold" text-anchor="middle">${esc(n.verb)}</text>`);
      p.push(`<text x="${cx(n)}" y="${cy(n) + 15}" fill="#909dab" font-size="10.5" text-anchor="middle">${esc(cut(n.detail, 30))}</text>`);
    }
    p.push(`</svg>`);
    return p.join("\n");
  }

  /**
   * Tree / COVERAGE view: the CE trunk (Write · Select · Compress · Isolate) with every verb branching
   * off its primitive. Verbs THIS design used are lit + numbered in execution order; unused verbs stay
   * dim — so you see, at a glance, which primitives a litectx build exercises and where each verb sits
   * (and spot a verb under the wrong primitive, or a missing stage). Lit set is read from the trace.
   */
  treeSvg(opts = {}) {
    const used = new Map(); // verb → execution-order number (first appearance)
    for (const n of this.nodes) if (!used.has(n.verb)) used.set(n.verb, used.size + 1);
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const C0 = 28, C1 = 236, C2 = 452, VW = 248, VH = 34, VGAP = 12, BAND = 24, TOP = 84;
    let y = TOP; const py = {}, vy = {};
    for (const prim of PRIMITIVES) {
      const ys = [];
      for (const v of VERBS_BY_PRIMITIVE[prim]) { vy[v] = y; ys.push(y); y += VH + VGAP; }
      py[prim] = (ys[0] + ys[ys.length - 1]) / 2; y += BAND;
    }
    const H = y + 8, W = C2 + VW + 28, rootY = (py[PRIMITIVES[0]] + py[PRIMITIVES[PRIMITIVES.length - 1]]) / 2;
    const PW = 150, PH = 40, RW = 168, RH = 44, accent = { Write: "#3a2c1c", Select: "#1c2f3a", Compress: "#1c3a2e", Isolate: "#2f1c3a" };
    const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`];
    p.push(`<rect width="${W}" height="${H}" fill="#0d1117"/>`);
    p.push(`<text x="${C0}" y="30" fill="#adbac7" font-size="13" font-weight="bold">${esc(opts.title ?? "litectx · contextgraph — CE coverage")}</text>`);
    p.push(`<text x="${C0}" y="48" fill="#636e7b" font-size="10.5">Write · Select · Compress · Isolate as the trunk; verbs this design USED are lit + numbered in run order</text>`);
    const line = (x1, y1, x2, y2, on) => p.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${on ? "#768390" : "#21262d"}" stroke-width="1.5"/>`);
    // root → primitives
    for (const prim of PRIMITIVES) line(C0 + RW, rootY, C1, py[prim], true);
    // primitive → verbs
    for (const prim of PRIMITIVES) for (const v of VERBS_BY_PRIMITIVE[prim]) line(C1 + PW, py[prim], C2, vy[v], used.has(v));
    // root node
    p.push(`<rect x="${C0}" y="${rootY - RH / 2}" width="${RW}" height="${RH}" rx="10" fill="#21262d" stroke="#444c56"/>`);
    p.push(`<text x="${C0 + RW / 2}" y="${rootY - 2}" fill="#f0f6fc" font-size="13" font-weight="bold" text-anchor="middle">graph substrate</text>`);
    p.push(`<text x="${C0 + RW / 2}" y="${rootY + 13}" fill="#909dab" font-size="9.5" text-anchor="middle">index · get · related</text>`);
    // primitive nodes
    for (const prim of PRIMITIVES) {
      p.push(`<rect x="${C1}" y="${py[prim] - PH / 2}" width="${PW}" height="${PH}" rx="9" fill="${accent[prim]}" stroke="#586069"/>`);
      p.push(`<text x="${C1 + PW / 2}" y="${py[prim] + 5}" fill="#f0f6fc" font-size="14" font-weight="bold" text-anchor="middle">${prim}</text>`);
    }
    // verb leaves
    for (const prim of PRIMITIVES) for (const v of VERBS_BY_PRIMITIVE[prim]) {
      const on = used.has(v), yy = vy[v];
      p.push(`<rect x="${C2}" y="${yy - VH / 2}" width="${VW}" height="${VH}" rx="8" fill="${on ? accent[prim] : "#161b22"}" stroke="${on ? "#768390" : "#272d36"}"/>`);
      if (on) {
        p.push(`<circle cx="${C2 + 17}" cy="${yy}" r="9" fill="#539bf5"/><text x="${C2 + 17}" y="${yy + 3.5}" fill="#0d1117" font-size="11" font-weight="bold" text-anchor="middle">${used.get(v)}</text>`);
      }
      p.push(`<text x="${C2 + 34}" y="${yy + 4}" fill="${on ? "#f0f6fc" : "#4b525c"}" font-size="12.5" font-weight="${on ? "bold" : "normal"}">${esc(v)}</text>`);
    }
    p.push(`</svg>`);
    return p.join("\n");
  }
}

// canonical verb → CE primitive map (grounded in docs/01-product/litectx-ce-prd.md §skill-map, lines 205-214).
// The trunk LangChain anchors on: every CE technique is Write, Select, Compress, or Isolate.
export const PRIMITIVES = ["Write", "Select", "Compress", "Isolate"];
export const VERBS_BY_PRIMITIVE = {
  Write: ["remember", "forget", "write-gate"],
  Select: ["recall", "impact"],
  Compress: ["assemble", "compress", "summaryWindow"],
  Isolate: ["stash", "peek", "evict", "scope"],
};
export const PRIMITIVE = Object.fromEntries(
  Object.entries(VERBS_BY_PRIMITIVE).flatMap(([prim, verbs]) => verbs.map((v) => [v, prim]))
);

// the graph layer the four primitives operate over — recorded, but not itself a CE primitive (it's the root)
const SUBSTRATE = new Set(["index", "get", "related", "getNode"]);
const ACCENT = { Write: "#3a2c1c", Select: "#1c2f3a", Compress: "#1c3a2e", Isolate: "#2f1c3a", Substrate: "#21262d" };
const primitiveOf = (verb) => PRIMITIVE[verb] ?? (SUBSTRATE.has(verb) ? "Substrate" : null);
const count = (r) => (Array.isArray(r) ? r.length : r && typeof r === "object" ? Object.values(r).flat().length : 0);
const brief = (x) =>
  typeof x === "string" ? (x.length > 40 ? x.slice(0, 39) + "…" : x)
  : Array.isArray(x) ? `[${x.length} items]`
  : x && typeof x === "object" ? JSON.stringify(x).slice(0, 80)
  : String(x);
// per-verb one-line summary from (args, result) — read off each verb's accountable return value
const SUMMARY = {
  index: (a, r) => `${r?.files ?? "?"} files`,
  remember: (a) => `${a[0]}`,
  forget: (a) => (typeof a[0] === "string" ? a[0] : JSON.stringify(a[0])),
  recall: (a, r) => `${count(r)} hits`,
  impact: (a, r) => `${a[0]} → risk ${r?.risk ?? "?"}`,
  assemble: (a, r) => `${r?.units?.length ?? "?"} kept · ${r?.tokens ?? "?"} tok`,
  summaryWindow: (a, r) => `${r?.units?.length ?? "?"} kept · ${r?.tokens ?? "?"} tok`,
  compress: (a, r) => `${a?.[1]?.level ?? "signature"} · ${Math.ceil((typeof r === "string" ? r.length : 0) / 4)} tok`,
  stash: (a) => `${a[0]} parked`,
  peek: (a) => `${a[0]}`,
  evict: () => "evicted",
  get: (a) => `${a[0]}`,
};

/**
 * observe(ctx) — wrap a LiteCtx so every CE verb call is recorded LIVE into a contextgraph. Drop it in
 * next to your build, run your loop normally, then read `.trace`. It works for the same reason the
 * recorder is thin: every verb returns an accountable result, so the proxy reads args-in + result-out
 * with ZERO changes to litectx internals.
 *
 *   const ctx = observe(new LiteCtx({ root }));
 *   const assemble = ctx.tap("assemble", rawAssemble);   // free-function verbs join the same trace
 *   await ctx.index(); await ctx.recall(q); await assemble(units, { budget });
 *   ctx.trace.treeSvg();  ctx.trace.svg();  ctx.trace.json();   // your session, two views
 */
export function observe(ctx) {
  const graph = new ContextGraph();
  let prev = null;
  const record = (verb, args, result) => {
    const prim = primitiveOf(verb);
    const id = graph.node({ verb, primitive: prim, accent: ACCENT[prim], detail: (SUMMARY[verb] ?? (() => ""))(args, result), stats: { args: args.map(brief), out: brief(result) } });
    if (prev) graph.edge(prev, id, "");
    prev = id;
    return result;
  };
  const wrap = (verb, fn, self) => (...args) => {
    const out = fn.apply(self, args);
    return out && typeof out.then === "function" ? out.then((r) => record(verb, args, r)) : record(verb, args, out);
  };
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "trace") return graph;
      if (prop === "tap") return (verb, fn) => wrap(verb, fn, undefined);
      const val = target[prop];
      if (typeof val !== "function" || typeof prop !== "string" || primitiveOf(prop) == null) {
        return typeof val === "function" ? val.bind(target) : val;
      }
      return wrap(prop, val, target);
    },
  });
}
