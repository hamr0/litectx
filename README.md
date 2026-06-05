```
   .ts · .js · .py · .md     ─┐
   git blame · commit log     ─┤   ╭───────────────╮      recall  → ranked, activation-weighted hits
   tree-sitter · ripgrep -w   ─┼─▶ │ ▓▓ litectx ▓▓ │ ─▶  impact  → called-by/calling blast radius + risk
   ACT-R activation           ─┘   ╰───────────────╯      one SQLite file · no service · embeddings opt-in

   litectx
```

> A **lite, local-first code+context graph** you `import`. It indexes your code and docs into one SQLite file — typed nodes, typed edges, per-node signals — and exposes two views over that substrate: **recall** (ranked search, weighted by ACT-R-style activation, not just BM25) and **impact** (walk the call graph to a called-by/calling blast radius + a low/med/high risk bucket). Edges come from **tree-sitter + `ripgrep -w` only — no LSP server, ever**. The graph itself is public API, so future graph views are queries over the same data, not re-extractions.
> **One** production dependency (`better-sqlite3`), Node >= 18. No daemon, no service, no telemetry — it runs in your process against a file on disk. Embeddings are the single opt-in tier; the deterministic BM25 + activation core ships on by default.

<p align="center">
  <a href="https://github.com/hamr0/litectx/actions/workflows/ci.yml"><img src="https://github.com/hamr0/litectx/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/litectx?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

---

> [!NOTE]
> **Status: design / POC stage.** `litectx@0.0.1` reserves the name. The API below is the **target shape** from the [PRD](docs/01-product/litectx-memory-prd.md), not yet shipped. Everything is gated on one question first — *does activation + graph-aware recall measurably beat plain FTS5/BM25?* (PRD §11). Pass → v1 builds in that sequence. Watch this space.

## What this is

litectx is **one substrate, two views**. The substrate is a code+context **graph**: typed nodes (functions, classes, files, doc chunks), typed edges (calls, called-by, imports), and per-node signals (recency, frequency, churn, complexity). Both views read that same graph — composed at query time, never re-extracted.

- **recall** — ranked search. Candidates are gated by FTS5/BM25, then re-weighted by **spreading activation across graph edges** (the ACT-R term validated to generalize). Git activity (commits, recency) rides along as per-hit grounding, not a score. The result is what's *relevant now*, not just what lexically matches. *(Base-level activation — recency × frequency decay — is the long-running-memory tier, layered in once a real access log exists; embeddings add the semantic tier.)*
- **impact** — give it a symbol; it walks calling / called-by edges to a **blast radius** and buckets the change risk **low / med / high**. Over-counting is acceptable by design — the output is a risk *bucket*, not a precise reference list.

It is **not** an LSP / language server, **not** a code-intelligence SaaS, **not** an embeddings-first semantic search (that's the opt-in tier), and ships **no UI or server** — it's a library against a SQLite file. The only per-adopter customization is *what* to index (by file extension) and *which* tier (deterministic vs. + embeddings); litectx owns the shape (extract → graph → rank).

## Install

```sh
npm install litectx
```

Node **>= 18**. **One production dependency** (`better-sqlite3`); `typescript` / `@types/node` are dev-only (JSDoc → generated `.d.ts`, so you get autocomplete out of the box). Embeddings, if enabled, pull in their own optional tier.

## Quick start

> Target API (design stage — subject to change until v1).

```js
import { LiteCtx } from "litectx";

// one config — point it at a repo, choose what to index
const ctx = new LiteCtx({
  root: "/path/to/repo",
  include: [".ts", ".js", ".py", ".md"],   // routed by EXTENSION, never sniffed
  embeddings: false,                         // the one opt-in tier (off by default)
});

await ctx.index();   // incremental: git status → mtime → content-hash

// recall — kind-scoped; kinds never share a ranking, so prose can't bury code
const hits = ctx.recall("where do we validate the auth token?", { kind: "code" });
// → [{ path, kind, format, score }, …]   (omit kind → grouped { code, doc }, 5 each)

// impact — blast radius + risk bucket for a symbol
const blast = ctx.impact("validateToken");
// → { risk: "high", callers: [...], calls: [...], reach: 37 }

// the graph is public API — query the substrate directly
const node = ctx.graph.node("src/auth.ts#validateToken");
const callers = ctx.graph.edges(node, "called-by");
```

**Indexing is routed by file extension**, never by sniffing content. v1 languages: **TypeScript, JavaScript, Python** for code, plus **Markdown** docs. Re-indexing is incremental over a 3-tier git check (status → mtime → content-hash), and **git activity** (commit count + recency, from `git log`) is attached to each hit as grounding metadata — so you can see what's been worked on, without it skewing the ranking.

**`kind` is first-class.** v1 indexes `code` and `doc` (Markdown). The schema reserves `fact`, `episode`, and other doc formats (pdf/docx/txt via a `format` field) with **no migration** — activation applies across kinds, which is how longer-term memory lands later.

## The graph

One SQLite file holds the whole substrate — nodes, edges, signals, and the FTS5 index — so the data outlives the process and one file is the entire read surface.

```jsonc
// node: a function, with the signals recall weighs
{ "id": "src/auth.ts#validateToken", "kind": "code", "lang": "ts",
  "span": [42, 71], "deps": ["jwt", "src/config.ts"],
  "recency": 0.81, "frequency": 12, "churn": 0.34, "complexity": 7 }

// edge: typed, directional — the call graph impact walks
{ "from": "src/routes.ts#handler", "to": "src/auth.ts#validateToken", "type": "calls" }
```

```js
// recall result — lexical match gated, then activation re-ranked
{ path: "src/auth.ts", kind: "code", span: [42, 71], score: 0.91, activation: 1.74 }

// impact result — blast radius bucketed, not a raw ref dump
{ risk: "high", reach: 37, callers: [/* … */], calls: [/* … */] }
```

**complexity ≠ risk:** complexity is a local AST branch count; risk/impact is reference count from the call graph (blast radius). They're separate fields, by design.

## Docs

| | |
|---|---|
| **Integration Guide** (`litectx.context.md`) | The complete adopter contract — every option, the full public API, the graph schema, extension contracts, the refusals. *Hand it to your AI assistant.* **(coming with v1)** |
| **[PRD](docs/01-product/litectx-memory-prd.md)** | Locked decisions + *why*, the substrate/views model, the POC gate, build order, the refusals. *(repo-only)* |
| **[CHANGELOG](CHANGELOG.md)** | keep-a-changelog; an entry every release. |

## License

Apache 2.0. See [LICENSE](LICENSE).
