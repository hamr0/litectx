// contextgraph — the CE-pipeline observability primitive. Where `codegraph`/`getNode`/`related` map the
// CONTENT graph (files, edges, risk), contextgraph maps the PIPELINE: the verbs a context-engineering
// design composes, as nodes, and the data handed between them, as edges — captured from a REAL run.
//
// It works because every litectx verb returns an accountable result (recall → hits; assemble →
// {units, dropped, tokens} with compressed/summary flags). So `observe(ctx)` is a thin Proxy that reads
// args-in + result-out per call — no instrumentation inside the verbs. Two ways in:
//
//   const ctx = observe(new LiteCtx({ root }));        // wrap explicitly, OR:
//   const ctx = new LiteCtx({ root, trace: true });    // the config flag does the same wrap
//   const assemble = ctx.tap("assemble", rawAssemble); // free-function verbs join the same trace
//   await ctx.index(); await ctx.recall(q); await assemble(units, { budget });
//   ctx.trace.json();      // the structured trace { nodes, edges }
//   ctx.trace.mermaid();   // a Mermaid flowchart (renders on GitHub / in any preview)
//
// litectx ships the DATA + the agent-readable Mermaid + the verb→primitive taxonomy. Pixel rendering
// (SVG / an interactive viewer) is a consumer concern — see examples/contextgraph.

/**
 * @typedef {Object} TraceNode
 * @property {string} id                       stable node id (`n0`, `n1`, …)
 * @property {string} verb                     the verb called (`recall`, `assemble`, …)
 * @property {string} [primitive]              its CE primitive — `Write|Select|Compress|Isolate|Substrate`
 * @property {string} [detail]                 one-line summary read off the verb's result
 * @property {string} [accent]                 a colour hint for renderers (not interpreted here)
 * @property {number} col                      pipeline depth (layout hint)
 * @property {number} row                      parallel-branch lane (layout hint)
 * @property {Record<string, unknown>} [stats] the recorded args-in / result-out
 */
/**
 * @typedef {Object} TraceEdge
 * @property {string} from
 * @property {string} to
 * @property {string} [label]
 */

/** The four CE primitives (LangChain's trunk: every technique is Write, Select, Compress, or Isolate). */
export const PRIMITIVES = ["Write", "Select", "Compress", "Isolate"];

/**
 * Canonical verb → primitive map, grounded in `docs/01-product/litectx-ce-prd.md` §skill-map.
 * @type {Record<string, string[]>}
 */
export const VERBS_BY_PRIMITIVE = {
  Write: ["remember", "forget", "write-gate"],
  Select: ["recall", "impact"],
  Compress: ["assemble", "compress", "summaryWindow"],
  Isolate: ["stash", "peek", "evict", "scope"],
};

/** Flat verb → primitive lookup, derived from {@link VERBS_BY_PRIMITIVE}. @type {Record<string, string>} */
export const PRIMITIVE = Object.fromEntries(
  Object.entries(VERBS_BY_PRIMITIVE).flatMap(([prim, verbs]) => verbs.map((v) => [v, prim]))
);

// index/get/related build the graph the four primitives operate over — recorded, but not a CE primitive.
const SUBSTRATE = new Set(["index", "get", "related", "getNode"]);
const ACCENT = { Write: "#3a2c1c", Select: "#1c2f3a", Compress: "#1c3a2e", Isolate: "#2f1c3a", Substrate: "#21262d" };

/** @param {string} verb @returns {string|null} */
const primitiveOf = (verb) => PRIMITIVE[verb] ?? (SUBSTRATE.has(verb) ? "Substrate" : null);

/** @param {unknown} r @returns {number} hit-count of a recall result (flat array or grouped object) */
const count = (r) => (Array.isArray(r) ? r.length : r && typeof r === "object" ? Object.values(r).flat().length : 0);

/** @param {unknown} x @returns {string} a short, safe rendering of an arg/result for the trace */
const brief = (x) =>
  typeof x === "string" ? (x.length > 40 ? x.slice(0, 39) + "…" : x)
  : Array.isArray(x) ? `[${x.length} items]`
  : x && typeof x === "object" ? JSON.stringify(x).slice(0, 80)
  : String(x);

// per-verb one-line summary read off (args, result) — each verb's accountable return value
/** @type {Record<string, (a: any[], r: any) => string>} */
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
 * The recorder: a node per verb call, an edge per dataflow handoff. Build one directly for a custom
 * trace, or let {@link observe} fill it. `col`/`row` are layout hints (depth / parallel lane) that
 * default to a single horizontal line.
 */
export class ContextGraph {
  constructor() {
    /** @type {TraceNode[]} */ this.nodes = [];
    /** @type {TraceEdge[]} */ this.edges = [];
  }

  /**
   * @param {{verb: string, detail?: string, primitive?: string, accent?: string, stats?: Record<string, unknown>, col?: number, row?: number}} n
   * @returns {string} the new node's id
   */
  node(n) {
    const id = `n${this.nodes.length}`;
    this.nodes.push({ id, ...n, col: n.col ?? this.nodes.length, row: n.row ?? 0 });
    return id;
  }

  /** Record the data handed from one verb to the next. @param {string} from @param {string} to @param {string} [label] @returns {string} */
  edge(from, to, label) {
    this.edges.push({ from, to, label });
    return to;
  }

  /** @returns {{ nodes: TraceNode[], edges: TraceEdge[] }} the structured trace */
  json() {
    return { nodes: this.nodes, edges: this.edges };
  }

  /** @returns {string} a Mermaid flowchart of the trace — agent-readable, renders anywhere markdown does */
  mermaid() {
    const esc = (/** @type {string} */ s) => String(s).replace(/"/g, "'");
    const out = ["flowchart LR"];
    for (const n of this.nodes) out.push(`  ${n.id}["<b>${esc(n.verb)}</b><br/><small>${esc(n.detail ?? "")}</small>"]`);
    for (const e of this.edges) out.push(`  ${e.from} -->|"${esc(e.label ?? "")}"| ${e.to}`);
    return out.join("\n");
  }
}

/**
 * Wrap a `LiteCtx` so every CE verb call is recorded LIVE into a {@link ContextGraph}. Drop it in next
 * to your build, run your loop unchanged, then read `.trace`. Zero changes to litectx internals — the
 * proxy reads each verb's args + return value (the same accountable results recall/assemble already
 * give back). `new LiteCtx({ trace: true })` applies this wrap for you.
 *
 *   proxy.trace          → the {@link ContextGraph} (call `.json()` / `.mermaid()`)
 *   proxy.tap(verb, fn)  → wrap a free-function verb (assemble/compress/summaryWindow) into the same trace
 *
 * The proxy boundary is intentionally untyped (`any`) — like the embedder's optional-dep boundary — so
 * the dynamic forwarding needs no cast or `@ts-ignore`.
 * @param {any} ctx  a LiteCtx instance (or any object whose CE verbs return accountable results)
 * @returns {any} the same object, proxied to record CE verb calls; `.trace` exposes the graph
 */
export function observe(ctx) {
  const graph = new ContextGraph();
  /** @type {string | null} */ let prev = null;
  /** @param {string} verb @param {any[]} args @param {any} result */
  const record = (verb, args, result) => {
    const prim = primitiveOf(verb) ?? undefined;
    const id = graph.node({
      verb,
      primitive: prim,
      accent: prim ? ACCENT[/** @type {keyof typeof ACCENT} */ (prim)] : undefined,
      detail: (SUMMARY[verb] ?? (() => ""))(args, result),
      stats: { args: args.map(brief), out: brief(result) },
    });
    if (prev) graph.edge(prev, id, "");
    prev = id;
    return result;
  };
  /** @param {string} verb @param {Function} fn @param {any} self */
  const wrap = (verb, fn, self) => (/** @type {any[]} */ ...args) => {
    const out = fn.apply(self, args);
    return out && typeof out.then === "function" ? out.then((/** @type {any} */ r) => record(verb, args, r)) : record(verb, args, out);
  };
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "trace") return graph;
      if (prop === "tap") return (/** @type {string} */ verb, /** @type {Function} */ fn) => wrap(verb, fn, undefined);
      const val = target[prop];
      if (typeof val !== "function" || typeof prop !== "string" || primitiveOf(prop) == null) {
        return typeof val === "function" ? val.bind(target) : val;
      }
      return wrap(prop, val, target);
    },
  });
}
