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
> **Status: v0.5.0 — semantic by default** (`npm i litectx`). The POC gate has cleared — graph-aware recall beats plain FTS5/BM25 (PRD §11, `poc/RESULTS.md`) — and the surface is **implemented, tested (131 integration tests), CI-gated, and E2E-validated from the registry**: **recall** (every hit carries a `chunk` pointer — the matching function/section inside the file), **impact**, and **`get(id)`** (the body behind any pointer — written memory verbatim, files fresh from disk) over one shared graph (TS / JS / Python + Markdown), plus the **write path** (`remember`/`forget` for facts, episodes, and runtime docs) and **two consumption surfaces** — a CLI and a zero-dependency stdio **MCP server** (`litectx-mcp`), both thin adapters over the same public API. An **optional Claude Code integration** ships in `integrations/claude/` — an LSP-free pre-edit `impact()` hook and a SessionStart index-warmer (opt-in; nothing in the library depends on it). The deterministic **BM25 + spreading** core is always there; the **embeddings tier** (slice 6) is now **ON by default on the CLI and MCP** (pass `--no-embeddings` for the BM25-only base, e.g. offline or CI). It's what makes memory recall by *meaning*: written facts/episodes match *paraphrases* that share no words with the stored text (slice 11: cosine nominates, not just re-ranks — paraphrase recall 0.000 → 0.574), and it lifts natural-language code recall by ~+0.2 MRR. It rides on `@xenova/transformers` (an *optional* dep, auto-installed, runs locally via ONNX — no API, no cloud); if it's unavailable, litectx warns once and falls back to BM25. Cost is a one-time ~23 MB model download + index-time embedding; per-query is negligible (~0.7s first load, ~6ms warm). The raw `LiteCtx` library API stays explicit (`embeddings: true`) so embedders opt in deliberately. **New in v0.4.0**: the **complete access-log tier** — `recentActivity()` ("what was I working on" — the chunks litectx witnessed you edit recently), `promotionCandidates()` (hot agent **episodes** to distil into durable **facts**, an explicit ladder into `reviewCandidates`), and **trust columns** on written-memory hits (`provenance`/`use`/`occurredAt`, surfaced for the agent to weigh, never scored). Still roadmap (🚧): base-level activation — *and* a trust/stability **tie-breaker** — as a *ranking* signal stays deliberately **out**; POCs found both repo-dependent and prone to burying fresh or better-matching answers, so the edit signal lives in those views and trust lives in those columns, **never** in search scores — plus ergonomic graph accessors. Pre-1.0 — the surface is stable enough to use, but the API may still evolve (e.g. `recall()` is now async).

## What this is

litectx is **one substrate, two views**. The substrate is a code+context **graph**: typed nodes (functions, classes, files, doc chunks), typed edges (calls, called-by, imports), and per-node signals (recency, frequency, churn, complexity). Both views read that same graph — composed at query time, never re-extracted.

- **recall** — ranked search. Candidates are gated by FTS5/BM25, then re-weighted by **spreading activation across graph edges** (the ACT-R term validated to generalize). Git activity (commits, recency) rides along as per-hit grounding, not a score. The result is what's *relevant now*, not just what lexically matches. *(Base-level activation — recency × frequency decay — is the long-running-memory tier, layered in once a real access log exists; embeddings add the semantic tier.)*
- **impact** — give it a symbol; it walks calling / called-by edges to a **blast radius** and buckets the change risk **low / med / high**. Over-counting is acceptable by design — the output is a risk *bucket*, not a precise reference list.

It is **not** an LSP / language server, **not** a code-intelligence SaaS, **not** an embeddings-first semantic search (that's the opt-in tier), and ships **no UI or server** — it's a library against a SQLite file. The only per-adopter customization is *what* to index (by file extension) and *which* tier (deterministic vs. + embeddings); litectx owns the shape (extract → graph → rank).

## Where litectx fits

litectx is one piece of a small family, and it helps to know the split:

- **litectx = what an agent *knows*, and how it's organized** — the context organ / memory. A library you `import`; no loop, no LLM, no process of its own.
- **baresuite (`bareagent` + `bareguard`) = what an agent *does*, step by step, safely** — the runtime: the agent loop, the human-in-the-loop gates, tool dispatch, budgets, content-trust.

If litectx is memory, baresuite is the nervous system and muscles. They meet at one seam — a `{ store, search, get, delete }` interface — so baresuite *calls* litectx whenever a task runs long enough that context management starts to matter. The dependency points one way: **baresuite consumes litectx; never the reverse.** litectx is standalone.

| | baresuite | litectx |
|---|---|---|
| **is a** | runtime / harness | library |
| **owns** | loop, tools, gates, spawn, budgets | recall, impact, graph, memory, the context primitives |
| **made for** | lightweight **one-shot** automation | **persistent, long-running** agent loops |
| **LLM / loop** | yes | no — deterministic |
| **depends on** | imports litectx | nothing (standalone) |

The short version: baresuite runs a task *once*; litectx is what turns a naive agent-in-a-loop into a **smart, flexible one that remembers** — carrying context and decisions across iterations instead of starting cold every pass.

> **On "cede".** In the design docs you'll see capabilities marked ⊘ **CEDE** — that's the plain verb *cede* (to hand off), **not** an acronym. It marks what litectx deliberately **doesn't** do because it belongs to baresuite: the agent loop, sub-agent orchestration, sandboxes, the *decision* of when to compress. litectx owns the data and the mechanism; baresuite owns the control flow.

## Install

```sh
npm install litectx
```

Node **>= 18**. **One production dependency** (`better-sqlite3`); `typescript` / `@types/node` are dev-only (JSDoc → generated `.d.ts`, so you get autocomplete out of the box). Embeddings, if enabled, pull in their own optional tier.

> **`impact()` needs `ripgrep` (`rg`) on `PATH`.** The caller sweep shells out to `rg -w` (no LSP, ever) — it is *not* bundled. Without `rg`, the sweep returns nothing and a symbol reads as **0 callers**, i.e. falsely *isolated* (the one dangerous error litectx guards against). Install ripgrep on any host that calls `impact()`; `recall`/`index` don't need it.

## Quick start

```js
import { LiteCtx } from "litectx";

// one config — point it at a repo, choose what to index (by extension)
const ctx = new LiteCtx({
  root: "/path/to/repo",
  include: [".ts", ".js", ".py", ".md"],   // routed by EXTENSION, never sniffed
});

await ctx.index();   // incremental: (mtime, size) fast-skip → content-hash

// recall — kind-scoped; kinds never share a ranking, so prose can't bury code (async)
const hits = await ctx.recall("where do we validate the auth token?", { kind: "code" });
// → [{ path, kind, format, score, git }, …]   (omit kind → grouped { code, doc, fact, episode }, 5 each)

// impact — blast radius + risk bucket for a symbol (async; shells `rg -w`)
const blast = await ctx.impact("validateToken");
// → { symbol, risk: "high", refCount: 37, confirmed, mentions,
//     callers: [...], callees: [...], complexity, defs, hedges }  |  null

// memory that isn't a file — facts/episodes/runtime docs; survives every index() pass
await ctx.remember("fact:auth-uses-jwt", "Auth is JWT, verified in middleware.", { kind: "fact", by: "human" });
const facts = await ctx.recall("jwt auth", { kind: "fact" });
ctx.get("fact:auth-uses-jwt")?.text;   // the body behind any pointer (recall returns ranked pointers)
ctx.forget("fact:auth-uses-jwt");   // by key — or forget({ by: "agent" }) in bulk
```

**Opt-in semantic tier:** `new LiteCtx({ root, embeddings: true })` fuses embedding cosine into recall (the dual≈85% → tri≈95% step) — and for written memory (`fact`/`episode`) it also **nominates**: the stored vectors nearest the query join the candidate pool, so a paraphrase sharing no words with a fact still finds it ("money back" → the refunds fact; bench para MRR 0.000 → 0.574 with exact/morph held). Off by default — it needs the optional peer dep (`npm i @xenova/transformers`) and loads a small local model on first use; the deterministic BM25 + spreading core never touches it.

**No integration code at all — two surfaces ship in the box**, both thin adapters over the same public API (use the lib, the CLI, the MCP server, or all three against one index):

```sh
litectx index && litectx recall "auth token validation" --kind code
echo "Auth is JWT, verified in middleware." | litectx remember fact:auth-uses-jwt
litectx get fact:auth-uses-jwt        # body → stdout, pipes clean
litectx help                          # all commands + the output-column legend
```

```jsonc
// MCP (Claude Code, Cursor, …): stdio, spawned by the client, not a daemon. Zero extra deps.
{ "mcpServers": { "litectx": { "command": "litectx-mcp", "args": ["--root", "/path/to/repo"] } } }
// → tools: index · recall · impact · get · recent · promotions · remember · forget
```

The graph substrate is public API; today you query it through the exported `Store` (`symbolDefs`, `nodesForPath`, `allSymbolNames`). Ergonomic accessors (`getNode` / `related`) are 🚧 roadmap.

**Indexing is routed by file extension**, never by sniffing content. v1 languages: **TypeScript, JavaScript, Python** for code, plus **Markdown** docs. The file list comes from `git ls-files` (a filesystem walk outside a git repo); re-indexing is incremental — a `(mtime, size)` fast-skip falls through to a content-hash. **git activity** (commit count + recency, from `git log`) is attached to each hit as grounding metadata — so you can see what's been worked on, without it skewing the ranking.

**`kind` is first-class — and the write path is live.** Files enter via `index()` → `code` / `doc` (Markdown); knowledge that isn't a file enters via `remember()` → `fact` / `episode` / `doc` (an agent's learned facts, session events, runtime FAQs). Written memory lives in the same store, recalls through the same kind-scoped ranking, carries provenance (`by: "human" | "agent"`), and structurally survives re-indexing. Every recall hit is logged — the audit trail behind `reviewCandidates()` (a human validates well-used agent **facts**) and `promotionCandidates()` (the agent distils well-used **episodes** into facts; litectx flags, never summarizes). `recentActivity()` answers "what was I working on" from witnessed edits. Episodes are an ephemeral scratchpad — a 30-day rolling window, auto-pruned on write. These access-log **read views** ship; base-level activation as a *ranking* signal stays out (POC-found repo-dependent). Other doc formats (pdf/docx/txt via `format`) remain schema-reserved, **no migration**.

## The graph

One SQLite file holds the whole substrate — nodes, edges, signals, and the FTS5 index — so the data outlives the process and one file is the entire read surface.

```jsonc
// node: a symbol chunk (function/class/method/doc-section), with line span
{ "symbol": "validateToken", "kind": "code", "format": "ts",
  "node_type": "function_declaration", "start_line": 42, "end_line": 71 }

// edge: typed, directional. Today `import` edges are persisted (they drive recall
// spreading); the `call` graph that impact walks is resolved on demand, not stored.
{ "type": "import", "src_path": "src/routes.ts", "dst_path": "src/auth.ts" }
```

```js
// recall result — BM25-gated, then 1-hop import-spreading re-ranked; git is grounding, not scored
{ path: "src/auth.ts", kind: "code", format: "ts", score: 0.91, git: { commits: 12, lastCommit: 1.7e9 } }

// impact result — blast radius bucketed, not a raw ref dump (refCount = max(confirmed, mentions))
{ symbol: "validateToken", risk: "high", refCount: 37, confirmed: 31, mentions: 37,
  callers: [/* … */], callees: [/* … */], complexity: 7, defs: [/* … */], hedges: [/* … */] }
```

> **Roadmap signals:** per-node `recency` / `frequency` / `churn` and a recall `activation` term arrive with the **base-level activation** tier (it needs a real access log; git gives *edit* frequency, not *access* frequency). Today recall is **BM25 + spreading**, and `complexity` is computed on demand for impact.

**complexity ≠ risk:** complexity is a local AST branch count; risk/impact is reference count from the call graph (blast radius). They're separate fields, by design.

## Docs

| | |
|---|---|
| **Integration Guide** (`litectx.context.md`) | The complete adopter contract — every option, the full public API, the graph schema, extension contracts, the refusals. *Hand it to your AI assistant.* Ships in the package. |
| **[PRD](docs/01-product/litectx-memory-prd.md)** | Locked decisions + *why*, the substrate/views model, the POC gate, build order, the refusals. *(repo-only)* |
| **[CHANGELOG](CHANGELOG.md)** | keep-a-changelog; an entry every release. |

## License

Apache 2.0. See [LICENSE](LICENSE).
