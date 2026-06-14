// contextgraph — visualize ANY CE design built with litectx.
//
// `codegraph` (see ../graph-view) maps the CONTENT graph: files, import edges, risk. `contextgraph` is
// the other view — the PIPELINE: the verbs a CE design composes (index/recall/assemble/compress/
// summaryWindow/remember/impact …) as nodes, and the DATA handed between them as edges. It answers
// "what does this context-engineering design actually do, end to end?" — generated from a REAL run,
// so it reports what happened (kept/compressed/dropped, tokens), not a hand-drawn intent.
//
// This is the retrieval pipeline. For contextgraph applied to an existing bench, see from-bench.mjs.
// Run from the repo root (or anywhere):  node examples/contextgraph/contextgraph.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LiteCtx, assemble } from "../../src/index.js"; // adopters: import from "litectx"
import { ContextGraph } from "../../src/index.js";
import { svg } from "./render.mjs";

const here = dirname(fileURLToPath(import.meta.url));

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
writeFileSync(join(here, "contextgraph.svg"), svg(g, { theme: "light" }) + "\n");
writeFileSync(join(here, "contextgraph.md"), "# contextgraph (generated)\n\n```mermaid\n" + g.mermaid() + "\n```\n");

console.log(g.mermaid());
console.log(`\nwrote contextgraph.{json,svg,md} to ${here}`);
console.log(`open examples/contextgraph/index.html for the interactive view`);
