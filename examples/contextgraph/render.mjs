// SVG renderers for a contextgraph trace — CONSUMER-side view code. litectx ships the data (`ctx.trace`),
// the agent-readable `.mermaid()`, and the W/S/C/I taxonomy; pixels are the consumer's concern, so the
// fancy SVGs live here. Each takes a graph (a `ContextGraph` or any `{ nodes, edges }`) → an SVG string.
//
// opts.theme: "light" (off-white, default) | "dark". opts.maxCols: snake-wrap the flow after N nodes.

import { PRIMITIVES, VERBS_BY_PRIMITIVE } from "../../src/index.js";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

/** Theme palettes. Primitive accents are pastel tints (light) / deep tints (dark) of the same hues. */
export const THEMES = {
  light: {
    bg: "#f7f5ef", panel: "#fffdf8", panelStroke: "#e2dccc", node: "#ffffff", stroke: "#d3ccbc",
    line: "#a79e8b", lineDim: "#e7e2d6", title: "#3a352b", sub: "#8c8473", text: "#2a261f", muted: "#7c7565",
    tag: "#9a9182", num: "#2f6fb3", numText: "#ffffff",
    accent: { Write: "#f4e7d2", Select: "#d9e9f4", Compress: "#d7f0e0", Isolate: "#ece0f6", Substrate: "#efece3" },
  },
  dark: {
    bg: "#0d1117", panel: "#161b22", panelStroke: "#30363d", node: "#21262d", stroke: "#444c56",
    line: "#768390", lineDim: "#21262d", title: "#adbac7", sub: "#636e7b", text: "#f0f6fc", muted: "#909dab",
    tag: "#8b98a5", num: "#539bf5", numText: "#0d1117",
    accent: { Write: "#3a2c1c", Select: "#1c2f3a", Compress: "#1c3a2e", Isolate: "#2f1c3a", Substrate: "#2a2f37" },
  },
};
const theme = (opts) => THEMES[opts.theme === "dark" ? "dark" : "light"];

/** A horizontal colour key: each CE primitive → its swatch, laid right-to-left from `rightX`. @returns {string} svg */
function legend(t, rightX, y) {
  const items = [...PRIMITIVES, "Substrate"];
  const p = [];
  let x = rightX;
  for (let i = items.length - 1; i >= 0; i--) {
    const k = items[i];
    x -= k.length * 6.7;
    p.push(`<text x="${x}" y="${y + 4}" fill="${t.muted}" font-size="10.5">${k}</text>`);
    x -= 19; // swatch + gap
    p.push(`<rect x="${x}" y="${y - 6}" width="13" height="13" rx="3" fill="${t.accent[k]}" stroke="${t.stroke}"/>`);
    x -= 16; // gap to next item
  }
  return p.join("\n");
}

/** Flow view — verbs in execution order, primitive-tagged, snake-wrapping when long; data on the edges. */
export function svg(graph, opts = {}) {
  const t = theme(opts);
  const title = opts.title ?? "litectx · contextgraph";
  const subtitle = opts.subtitle ?? "a CE pipeline, generated from a real run — verbs as nodes, data as edges";
  const NW = 212, NH = 74, GAPX = 150, GAPY = 74, PAD = 28, TOP = 98, maxCols = opts.maxCols ?? 4;

  // serpentine layout for a LINEAR flow (all row 0); explicit col/row branches (e.g. the bench A/B) keep theirs
  const linear = Math.max(...graph.nodes.map((n) => n.row)) === 0;
  /** @type {Map<string,{col:number,row:number}>} */ const pos = new Map();
  if (linear && graph.nodes.length > maxCols) {
    graph.nodes.forEach((n, i) => { const row = Math.floor(i / maxCols), k = i % maxCols; pos.set(n.id, { col: row % 2 === 0 ? k : maxCols - 1 - k, row }); });
  } else {
    graph.nodes.forEach((n) => pos.set(n.id, { col: n.col, row: n.row }));
  }
  const cols = Math.max(...[...pos.values()].map((q) => q.col)) + 1, rows = Math.max(...[...pos.values()].map((q) => q.row)) + 1;
  const W = PAD * 2 + cols * NW + (cols - 1) * GAPX, H = TOP + rows * NH + (rows - 1) * GAPY + PAD;
  const byId = (id) => graph.nodes.find((n) => n.id === id);
  const cx = (n) => PAD + pos.get(n.id).col * (NW + GAPX) + NW / 2, cy = (n) => TOP + pos.get(n.id).row * (NH + GAPY) + NH / 2;

  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`];
  p.push(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);
  p.push(`<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="${t.line}"/></marker></defs>`);
  p.push(`<text x="${PAD}" y="32" fill="${t.title}" font-size="15" font-weight="bold">${esc(title)}</text>`);
  p.push(`<text x="${PAD}" y="51" fill="${t.sub}" font-size="10.5">${esc(subtitle)}</text>`);
  p.push(legend(t, W - PAD, 75));

  for (const e of graph.edges) {
    const s = byId(e.from), d = byId(e.to), ps = pos.get(s.id), pd = pos.get(d.id);
    let x1, y1, x2, y2;
    if (ps.row === pd.row) { const dir = pd.col > ps.col ? 1 : -1; x1 = cx(s) + dir * NW / 2; x2 = cx(d) - dir * NW / 2; y1 = y2 = cy(s); }
    else { x1 = x2 = cx(s); y1 = cy(s) + NH / 2; y2 = cy(d) - NH / 2; } // snake wrap → vertical drop
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ex = x2 - (dx / len) * 5, ey = y2 - (dy / len) * 5;
    p.push(`<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${t.line}" stroke-width="1.5" marker-end="url(#arrow)"/>`);
    const lbl = cut(e.label || "", 30), mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    if (lbl) {
      const lw = lbl.length * 6.1 + 14;
      p.push(`<rect x="${mx - lw / 2}" y="${my - 21}" width="${lw}" height="17" rx="5" fill="${t.panel}" stroke="${t.panelStroke}"/>`);
      p.push(`<text x="${mx}" y="${my - 9}" fill="${t.muted}" font-size="10" text-anchor="middle">${esc(lbl)}</text>`);
    }
  }
  for (const n of graph.nodes) {
    const nx = cx(n) - NW / 2, ny = cy(n) - NH / 2, fill = n.accent ? (t.accent[n.primitive] ?? t.node) : t.node;
    p.push(`<rect x="${nx}" y="${ny}" width="${NW}" height="${NH}" rx="11" fill="${fill}" stroke="${t.stroke}"/>`);
    if (n.primitive) p.push(`<text x="${cx(n)}" y="${cy(n) - 22}" fill="${t.tag}" font-size="9.5" letter-spacing="1.2" font-weight="bold" text-anchor="middle">${esc(String(n.primitive).toUpperCase())}</text>`);
    p.push(`<text x="${cx(n)}" y="${cy(n) - 2}" fill="${t.text}" font-size="16" font-weight="bold" text-anchor="middle">${esc(n.verb)}</text>`);
    p.push(`<text x="${cx(n)}" y="${cy(n) + 18}" fill="${t.muted}" font-size="10.5" text-anchor="middle">${esc(cut(n.detail ?? "", 30))}</text>`);
  }
  p.push(`</svg>`);
  return p.join("\n");
}

/** Tree / coverage view — the W/S/C/I trunk with every verb branching off; used ones lit + numbered. */
export function treeSvg(graph, opts = {}) {
  const t = theme(opts);
  const used = new Map(); // verb → execution-order number (first appearance)
  for (const n of graph.nodes) if (!used.has(n.verb)) used.set(n.verb, used.size + 1);

  const C0 = 28, C1 = 236, C2 = 452, VW = 248, VH = 34, VGAP = 12, BAND = 24, TOP = 84;
  let y = TOP; const py = {}, vy = {};
  for (const prim of PRIMITIVES) {
    const ys = [];
    for (const v of VERBS_BY_PRIMITIVE[prim]) { vy[v] = y; ys.push(y); y += VH + VGAP; }
    py[prim] = (ys[0] + ys[ys.length - 1]) / 2; y += BAND;
  }
  const H = y + 8, W = C2 + VW + 28, rootY = (py[PRIMITIVES[0]] + py[PRIMITIVES[PRIMITIVES.length - 1]]) / 2;
  const PW = 150, PH = 40, RW = 168, RH = 44;
  const p = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace">`];
  p.push(`<rect width="${W}" height="${H}" fill="${t.bg}"/>`);
  p.push(`<text x="${C0}" y="32" fill="${t.title}" font-size="15" font-weight="bold">${esc(opts.title ?? "litectx · contextgraph — CE coverage")}</text>`);
  p.push(`<text x="${C0}" y="51" fill="${t.sub}" font-size="10.5">Write · Select · Compress · Isolate as the trunk; verbs this design USED are lit + numbered in run order</text>`);
  const line = (x1, y1, x2, y2, on) => p.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${on ? t.line : t.lineDim}" stroke-width="1.5"/>`);
  for (const prim of PRIMITIVES) line(C0 + RW, rootY, C1, py[prim], true);
  for (const prim of PRIMITIVES) for (const v of VERBS_BY_PRIMITIVE[prim]) line(C1 + PW, py[prim], C2, vy[v], used.has(v));
  p.push(`<rect x="${C0}" y="${rootY - RH / 2}" width="${RW}" height="${RH}" rx="10" fill="${t.node}" stroke="${t.stroke}"/>`);
  p.push(`<text x="${C0 + RW / 2}" y="${rootY - 2}" fill="${t.text}" font-size="13" font-weight="bold" text-anchor="middle">graph substrate</text>`);
  p.push(`<text x="${C0 + RW / 2}" y="${rootY + 13}" fill="${t.muted}" font-size="9.5" text-anchor="middle">index · get · related</text>`);
  for (const prim of PRIMITIVES) {
    p.push(`<rect x="${C1}" y="${py[prim] - PH / 2}" width="${PW}" height="${PH}" rx="9" fill="${t.accent[prim]}" stroke="${t.stroke}"/>`);
    p.push(`<text x="${C1 + PW / 2}" y="${py[prim] + 5}" fill="${t.text}" font-size="14" font-weight="bold" text-anchor="middle">${prim}</text>`);
  }
  for (const prim of PRIMITIVES) for (const v of VERBS_BY_PRIMITIVE[prim]) {
    const on = used.has(v), yy = vy[v];
    p.push(`<rect x="${C2}" y="${yy - VH / 2}" width="${VW}" height="${VH}" rx="8" fill="${on ? t.accent[prim] : t.panel}" stroke="${on ? t.stroke : t.panelStroke}"/>`);
    if (on) p.push(`<circle cx="${C2 + 17}" cy="${yy}" r="9" fill="${t.num}"/><text x="${C2 + 17}" y="${yy + 3.5}" fill="${t.numText}" font-size="11" font-weight="bold" text-anchor="middle">${used.get(v)}</text>`);
    p.push(`<text x="${C2 + 34}" y="${yy + 4}" fill="${on ? t.text : t.muted}" font-size="12.5" font-weight="${on ? "bold" : "normal"}">${esc(v)}</text>`);
  }
  p.push(`</svg>`);
  return p.join("\n");
}
