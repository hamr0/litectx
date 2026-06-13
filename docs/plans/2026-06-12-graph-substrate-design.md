# Graph substrate — `getNode` / `related` (design, 2026-06-12)

> **Status: BUILT & validated.** `getNode`/`related` shipped to `src/store.js` + `src/index.js`,
> 7 regression tests (`test/graph.test.js`), POC `poc/graph-substrate-poc.mjs`, example consumer
> `examples/graph-view/`. tsc + 174 tests green. Implements CE-PRD **R-G1/R-G2** (the graph-substrate
> accessors); this doc records the design and the rationale behind the shape so it isn't re-litigated.

## Goal

The graph is first-class public API — recall and impact are *views* over it (memory-PRD §2), and so
are the future **codegraph** / **contextgraph** (§9). Until now the graph had no direct accessor: you
could *search* it (`recall`) or ask *blast radius* (`impact`), but not **look up one node** or **walk
its edges**. `getNode`/`related` close that — the substrate a human code-map and a future `assemble()`
both read.

Two goals drove the shape, one now, one later:
- **codegraph (now):** a human searches/clicks a file → sees what it connects to. Built; demoed in
  `examples/graph-view/`.
- **contextgraph (later):** visualize CE end-to-end — facts/episodes/compressed nodes linked by CE
  relations (`derived_from`/`supersedes`). Not built; the substrate accommodates it for free (below).

## Shape (locked)

**Node identity = path/id, file-granular.** Edges are file→file; the integer `nodes.id` is unstable
across re-index and unreferenced. So the node is the **path** (or written-memory id), consistent with
`get`/`remember`/`forget`. Chunks are *contents of* a node, never nodes themselves.

```js
getNode(id)                              // → GraphNode | null   (describe; `get` returns the body)
  → { id, kind, format, source, git, chunks: [{symbol,nodeType,startLine,endLine}],
      edges: { imports, importedBy } }   // written memory → chunks:[], edges:{0,0}, source:"direct"

related(id, { edge="import", dir="both", hops=1 })   // → { items: RelatedNode[], truncated }
  → items: [{ id, kind, format, hops, via }]         // via: "out"=seed imports it · "in"=imports seed
```

Decisions and why:
- **`related` = persisted `import` edges only.** Clean seam: `related` is cheap/exact; `calls`/blast
  is `impact()`'s on-demand job (`rg -w` + tree-sitter, symbol-level). Folding calls in would duplicate
  impact or hide heavy compute behind a "cheap" accessor.
- **`dir` default `both`** (the neighbourhood — what a human clicking a file wants); `out`/`in` for
  directed/programmatic callers. Each result is `via`-tagged so `both` isn't ambiguous.
- **`hops` default 1, hard-capped at 3**, `truncated` flags the cap. Navigation, not ranking, so
  multi-hop is legitimate; the cap stops a walk returning half the repo. (Recall caps at 1-hop because
  more hops dilute *ranking* — a different concern.)
- **`edge` is a generic type param.** The `edges` table is `(type, src_path, dst_path)`; `import`/
  `call` are just values. Future CE edges (`derived_from`/`supersedes`) are **new type values, zero
  migration** — `related(id, {edge:"derived_from"})` will just work once a producer emits them. This
  one choice is the entire cost of keeping contextgraph open. We do **not** build those edges now (no
  producer exists; that would be speculative dead data).
- **`getNode` is kind-agnostic** — files, facts, episodes describe uniformly (written memory = a
  zero-chunk, zero-edge node), so contextgraph nodes need no new accessor.

**Seam invariant (tested):** `getNode.edges.imports === related(out,1).length` and
`importedBy === related(in,1).length` — counts and walk can't drift.

## The human-surface scope decision (codegraph view)

litectx ships the **graph data**, never the visualization. The click/highlight/render lives in a
consumer (`examples/graph-view/` is a demo, repo-only, not in `files`). The view's job is **map →
glance → one safety check**, deliberately bounded:
1. import map (orientation) · 2. click → import neighbourhood · 3. per-node `impact` *risk* · 4. search.

Anything past that is the IDE's lane (editing, diffs) or the agent's lane (ranked recall, embeddings).

**Why imports-as-edges + impact-as-badge (the a/b/b′ exploration).** We built three variants on real
data (litectx's own `src/`) and compared:
- **(a) call-overlay edges** — draws `impact()` callers as graph edges. Rejected: impact **over-counts
  by design** (name-based `rg -w`; `index.js` showed ~52 callers, "called-by leaf modules" — false).
  Drawing a probabilistic signal in the *precise* idiom of edges **poisons trust in the exact import
  edges beside it.** A glance tool dies the moment it's caught lying once.
- **(b) risk-colored nodes** — cleaner, but the risk landscape saturates to all-high (same over-count),
  so the coloring carries little signal.
- **(b′) clean import map + single fuzzy badge** — CHOSEN. Edges = imports (exact); `impact` is one
  labeled `~N callers (fuzzy)` badge, never an edge. **Principle: match the representation to the
  data's confidence** — exact data earns edges, fuzzy data earns a badge.

## Future: an accurate call-graph view (deferred, not rejected)

A human call-graph *would* be valuable ("who actually calls this" > "who imports this file"). We
deferred it on **cost + trustworthiness**, not value:
- The cheap version (file-aggregate `impact`) is too noisy to draw as edges.
- The accurate version requires **persisting tree-sitter-*confirmed* call edges** (the roadmap's
  "persist call edges") — and even then it's a *tighter bucket, not exact*: tree-sitter confirms "a
  call to something named X," but disambiguating *which* X needs binding/type info = LSP, permanently
  refused. So "more accurate, not precise."
- Meanwhile the probabilistic call signal **already serves agents** via `impact()` (a bucket + hedges,
  which an agent weighs fine — only the human *eye* is misled when fuzz is drawn as precise edges).

So: humans get the exact import map now; an accurate (not exact) human call-graph is gated on
persisting confirmed call edges, at which point it earns its edges and variant (a) becomes buildable
on trustworthy data.

## What shipped
- `src/store.js`: `getNode(id)`, `related(id, opts)` + `GraphNode`/`RelatedNode` typedefs.
- `src/index.js`: facade delegators + JSDoc.
- `test/graph.test.js`: 7 tests (kind-agnostic, seam invariant, dir, multi-hop BFS, cap, null).
- `poc/graph-substrate-poc.mjs`: candidate-SQL validation + `examples/graph-view/graph.json` generator.
- `examples/graph-view/`: b′ demo (zero-dep, offline, repo-only).
- Channel: **API-only** for now (MCP only if a model-caller ever needs graph navigation — §10.5).

*Memory: [[litectx-absorbs-all-ce-primitives]]. Pairs with the baresuite handoff
(`docs/02-engineering/baresuite-litectx-prd.md`, the integration contract — formerly
`litectx-for-baresuite.md`).*
