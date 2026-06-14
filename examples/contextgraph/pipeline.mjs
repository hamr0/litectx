// THE DROP-IN: wrap your LiteCtx with observe(), run your CE loop normally, get the graph of your
// ACTUAL session — live, not a hand-drawn build. This example exercises all four CE primitives so both
// views are interesting:
//   • flow  (contextgraph-pipeline-flow.svg) — how it ran, in order.
//   • tree  (contextgraph-pipeline-tree.svg) — the Write/Select/Compress/Isolate trunk; the verbs this
//            run used are lit + numbered, the rest dim. "What does my CE cover / is anything misplaced?"
//   • index.html — the same trace, interactive (click a verb for its recorded calls).
//
// Run:  node examples/contextgraph/pipeline.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LiteCtx, assemble as rawAssemble, compress as rawCompress } from "../../src/index.js";
import { observe, VERBS_BY_PRIMITIVE, PRIMITIVES } from "./recorder.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// ---- wrap once; everything below is a NORMAL litectx call — observe() records it live ------------
const ctx = observe(new LiteCtx({ root: join(here, "..", ".."), dbPath: ":memory:" }));
const assemble = ctx.tap("assemble", rawAssemble);   // free-function verbs join the same trace
const compress = ctx.tap("compress", rawCompress);

await ctx.index();                                                          // SUBSTRATE
await ctx.remember("fact:auth", "Auth is JWT, verified in validateToken middleware.", { kind: "fact", by: "human" }); // WRITE
const hits = await ctx.recall("validate auth token middleware", { kind: "code", n: 6, body: true });                 // SELECT

const units = hits.map((h, i) => ({
  id: h.chunk?.symbol ? `${h.path}#${h.chunk.symbol}` : `${h.path}#${i}`,
  role: "tool", content: h.body ?? "", kind: h.kind, format: h.path.split(".").pop(), symbol: h.chunk?.symbol,
}));
const inTok = units.reduce((s, u) => s + Math.ceil((u.content?.length ?? 0) / 4), 0);
await assemble(units, { budget: Math.round(inTok * 0.45) });               // COMPRESS
await compress({ text: units[0].content, format: units[0].format, symbol: units[0].symbol }, { level: "signature" }); // COMPRESS
ctx.stash("scratch:run1", "a large intermediate result parked out of the context window");                           // ISOLATE

// ---- read the trace: two views of THIS session ---------------------------------------------------
const g = ctx.trace;
const json = { ...g.json(), taxonomy: VERBS_BY_PRIMITIVE, primitives: PRIMITIVES };
writeFileSync(join(here, "contextgraph-pipeline.json"), JSON.stringify(json, null, 2) + "\n");
writeFileSync(join(here, "contextgraph-pipeline-flow.svg"), g.svg({ title: "litectx · contextgraph — flow (how it ran, in order)", subtitle: "verbs in execution order, captured live by observe()" }) + "\n");
writeFileSync(join(here, "contextgraph-pipeline-tree.svg"), g.treeSvg() + "\n");

console.log("verbs observed:", g.nodes.map((n) => n.verb).join(" → "));
console.log(`wrote contextgraph-pipeline.json + -flow.svg + -tree.svg to ${here}`);
console.log(`open index.html (served) for the interactive view`);
