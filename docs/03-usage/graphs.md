# Graphs — codegraph & contextgraph

litectx exposes its graph as first-class public API, so two different graphs sit over the **same**
indexed data — no re-extraction:

| | **codegraph** | **contextgraph** |
|---|---|---|
| **what** | the **content** graph — files/symbols, `import` edges, risk | the **pipeline** — the CE verbs a design composes, and the data between them |
| **answers** | *what is the code, and what depends on what?* | *what does my CE design do, end to end — and what does it cover?* |
| **built from** | `getNode` · `related` · `impact` | `observe(ctx)` / `trace: true` → `ctx.trace` |
| **example** | `examples/graph-view/` | `examples/contextgraph/` |

Both are **views**, not core — read the data, render however you like. The lib ships the data + an
agent-readable Mermaid string; pixel rendering (SVG, an interactive viewer) is consumer code in the
examples.

---

## codegraph — the content graph

A map of the indexed repo: nodes are files/symbols, edges are `import`s, and each node carries an
`impact` risk bucket (low/med/high). Built from the substrate accessors:

```js
import { LiteCtx } from "litectx";
const lc = new LiteCtx({ root: "/path/to/repo" });
await lc.index();

const node  = lc.getNode("src/auth.js");          // one node + its symbols
const near  = lc.related("src/auth.js");          // its import neighborhood (exact, persisted edges)
const blast = await lc.impact("validateToken");   // callers/callees → low/med/high risk bucket
```

Emit a `{ nodes, edges }` JSON by walking `related()` over the files you care about (add `impact()` for
the risk badge), then render it. The worked viewer is **`examples/graph-view/`** — a zero-dep
`index.html` that fetches `graph.json` and draws the import neighborhood; click a node and its `impact`
risk shows as a badge (over-counts by design; never drawn as edges — no LSP, ever).

```sh
cd examples/graph-view && python3 -m http.server 8010   # → http://127.0.0.1:8010/index.html
```

---

## contextgraph — the pipeline view

Captures a **real run** of your CE design — every verb call, in order, with the data handed between
them. It works because every litectx verb returns an accountable result, so a thin Proxy reads
args-in + result-out with no changes to litectx internals.

### Wire it — two ways

```js
import { LiteCtx, observe } from "litectx";

const ctx = observe(new LiteCtx({ root }));        // (a) explicit wrap, OR
const ctx = new LiteCtx({ root, trace: true });    // (b) the config flag — same thing
```

Free-function verbs (`assemble` / `compress` / `summaryWindow`) are separate imports, so fold them into
the same trace with `tap`:

```js
import { assemble as rawAssemble } from "litectx";
const assemble = ctx.tap("assemble", rawAssemble);
```

Then **run your loop unchanged** — every `ctx.recall`/`remember`/… and tapped call is recorded live:

```js
await ctx.index();
await ctx.recall("validate auth token", { kind: "code" });
await assemble(units, { budget });
ctx.stash("scratch", payload);
```

### Read it — two views

```js
ctx.trace.json();      // { nodes, edges } — the structured trace
ctx.trace.mermaid();   // a Mermaid flowchart — renders on GitHub / in any preview
```

- **flow** — the run in execution order, each node tagged with its CE primitive, the data on the edges.
- **tree / coverage** — the **Write · Select · Compress · Isolate** trunk with every verb branching off;
  the verbs your design *used* are lit + numbered, the rest dim. This is the diagnostic: see which
  primitives you cover, which you skip, and whether a verb sits under the wrong one. The verb→primitive
  map (`PRIMITIVE`, `VERBS_BY_PRIMITIVE`, `PRIMITIVES`) is grounded in the CE-PRD skill-map.

litectx ships `json()` + `mermaid()`. For the SVG flow/tree renders and the **interactive** viewer
(toggle flow/tree, click a verb for its recorded calls), copy `examples/contextgraph/render.mjs` +
`index.html`:

```sh
node examples/contextgraph/pipeline.mjs                 # the observe() drop-in (writes the artifacts)
cd examples/contextgraph && python3 -m http.server 8011 # → http://127.0.0.1:8011/index.html
```

### Apply it to anything you build

Wrap the `LiteCtx` your build already constructs (or flip `trace: true`), run your real session, and dump
`ctx.trace`. The graph is your actual run — `examples/contextgraph/from-bench.mjs` does exactly this against
`poc/assemble-bench.mjs`, surfacing the bench's COMPRESS-rescue A/B as a branching graph.

> **Overhead.** A bare `new LiteCtx(...)` (no `trace`) is untouched — no proxy, zero cost. Tracing only
> records small summaries of args/results; it never changes what the verbs do.
