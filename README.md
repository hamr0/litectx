```
   ╭───────────────────────────────────────╮
   │  litectx                                │
   │  the context-engineering library        │
   │  write · select · compress · isolate    │
   ╰───────────────────────────────────────╯
```

<p align="center">
  <a href="https://github.com/hamr0/litectx/actions/workflows/ci.yml"><img src="https://github.com/hamr0/litectx/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/github/package-json/v/hamr0/litectx?label=version&color=2a4f8c" alt="version (auto from package.json)">
  <img src="https://img.shields.io/badge/license-Apache%202.0-2a4f8c" alt="license: Apache 2.0">
</p>

**Every context-engineering primitive an agent needs, in one importable library. One production dependency (`better-sqlite3`).**

**Opinionated and lightweight**, like the rest of [baresuite](https://github.com/hamr0/bareagent). Light enough to read in an afternoon; complete enough that you don't reinvent recall, impact, memory, or budget-fitting. It doesn't make a model smarter and it doesn't bloat the build — it **scaffolds the rough spots where agents fail (finding the right file, remembering across sessions, fitting a budget) at low processing cost**, so a weaker model searches more like a strong one without replacing the model's own reasoning. Not a framework, not a service, not an LSP: a code+context **graph** in one SQLite file plus the verbs that read and write it. It owns no loop and calls no model of its own. Import what you need, ignore the rest.

> **Status: v0.14.0 — `npm i litectx`.** Pre-1.0: the surface is stable enough to use and CI-gated (240+ tests), but the API may still evolve (`recall()`/`impact()`/`assemble()` are async). Per-release detail lives in the [CHANGELOG](CHANGELOG.md).

## Quick start

```bash
npm install litectx
```

Node **>= 18**. **One production dependency** (`better-sqlite3`); `typescript` / `@types/node` are dev-only (JSDoc → generated `.d.ts`, so you get autocomplete out of the box).

**Give your AI assistant the integration guide.** `litectx.context.md` ships in the package — the complete adopter contract (every option, the full API, the graph schema, the refusals). Hand it over and your assistant knows how to wire litectx correctly:

```
Read litectx.context.md from node_modules/litectx/litectx.context.md
```

**Then it's six lines:**

```js
import { LiteCtx } from "litectx";

const ctx = new LiteCtx({ root: "/path/to/repo", include: [".ts", ".js", ".py", ".md"] });
await ctx.index();                                              // incremental: (mtime,size) → content-hash

const hits  = await ctx.recall("where do we validate the auth token?", { kind: "code" });
const blast = await ctx.impact("validateToken");               // blast radius + low/med/high risk bucket

await ctx.remember("fact:auth-uses-jwt", "Auth is JWT, verified in middleware.", { kind: "fact", by: "human" });
const facts = await ctx.recall("how does login work", { kind: "fact" });   // matches by meaning, not just words
```

> **`impact()` needs `ripgrep` (`rg`) on `PATH`** — the caller sweep shells out to `rg -w` (no LSP, ever). Without it a symbol reads as **0 callers**, i.e. falsely *isolated* (the one error litectx guards against). `recall`/`index` don't need it.

## What's inside

One substrate — a typed code+context **graph** in one SQLite file — and the verbs that read and write it. Every piece works alone; take what you need.

| Group | Primitives | What it does |
|---|---|---|
| **Substrate** | `index` · `getNode` · `related` · `get` · `Store` | Index a repo (routed by file **extension**, never sniffed) into typed nodes + `import` edges. The graph is public API — address a node, walk its edges, fetch any body. |
| **Views** | `recall` · `impact` | **recall** = BM25-gated, re-weighted by spreading activation across graph edges (relevant *now*, not just lexical). **impact** = walk callers/callees to a blast radius + a low/med/high risk bucket. Both compose over the same graph. |
| **Memory** | `remember` · `forget` · `recentActivity` · `promotionCandidates` · `reviewCandidates` | Knowledge that isn't a file — `fact` / `episode` / runtime `doc`. Lives in the same store, recalls through the same ranking, carries provenance, and survives every re-index. Episodes auto-prune on a 30-day window. |
| **Context verbs** | `assemble` · `summaryWindow` · `compress` · `stash` · `peek` · `evict` | The read/render half. **assemble** budget-fits a transcript (FIT, or COMPRESS a droppable unit to its signature). **summaryWindow** rolls old turns into one restorable summary. **compress** renders a symbol verbatim/signature/drop. **stash/peek/evict** park a payload out of context and page it back. *(Library/orchestration verbs — deliberately not MCP: deciding* when *to compress is the host loop's job, not a model verb.)* |
| **Sockets** | `liteCtxAsStore` · write-gate (`toWriteAction`) | Drop-in adapters. `liteCtxAsStore(lc)` makes a `LiteCtx` satisfy a host's `{ store, search, get, delete }` memory shape (e.g. bareagent's `Memory`) in one line. The write-gate emits a gate-able action before a memory write commits. |

**Tiers.** The deterministic **BM25 + spreading** core is always on. The **embeddings tier** (`embeddings: true`, or on by default on CLI/MCP) adds semantic recall via an optional local model (`@huggingface/transformers`, ONNX, no API) — it's what lets written memory match a *paraphrase* that shares no words with the stored text. One-time ~23 MB model download + index-time embedding; per-query is negligible (~6 ms warm). Unavailable → warn once, fall back to BM25.

## Surfaces

Three thin adapters over the **same public API** and the **same index** — use the library, the CLI, the MCP server, or all three.

```sh
# CLI — pipes clean, scriptable
litectx index && litectx recall "auth token validation" --kind code
echo "Auth is JWT, verified in middleware." | litectx remember fact:auth-uses-jwt
litectx get fact:auth-uses-jwt        # body → stdout
```

```jsonc
// MCP (Claude Code, Cursor, …): stdio, spawned by the client — code-aware recall/impact as model verbs. Zero extra deps.
{ "mcpServers": { "litectx": { "command": "litectx-mcp", "args": ["--root", "/path/to/repo"] } } }
// → tools: index · recall · impact · get · recent · promotions · remember · forget
```

**Claude Code integration** (`integrations/claude/`, opt-in): an LSP-free **pre-edit `impact()` hook** (see the blast radius before you change a symbol) and a SessionStart **index-warmer**. Nothing in the library depends on it.

## Recipes

**Mount litectx as a host's memory backend** — one line, the host code never changes:

```js
import { LiteCtx, liteCtxAsStore } from "litectx";
const store = liteCtxAsStore(new LiteCtx({ root, embeddings: true }));
// store now satisfies { store, search, get, delete } — ranked, graph-aware recall in place of a substring scan
```

**Budget-fit a transcript for the next model call** — pure, deterministic, cache-stable:

```js
import { assemble } from "litectx";
const { units, dropped, tokens } = await assemble(transcriptUnits, { budget: 8000, task });
// pinned units never drop; atomic (tool-call + result) kept-or-dropped whole; dropped[] accounts for every elision
```

## Validation — grounded, not asserted

Each claim is a committed bench, run as a local pre-push gate (corpora are local checkouts). Results in [`poc/RESULTS.md`](poc/RESULTS.md).

| Claim | Bench | Result |
|---|---|---|
| graph-aware recall beats plain FTS5/BM25 | `run.mjs` ablation (PRD §11) | **POC gate cleared** |
| recall lands the ground-truth file (E2E) | `bench-lib` | per-dataset **MRR floors** hold-or-beat |
| memory recalls by *meaning*, not just words | `memory-bench` | paraphrase MRR **0.000 → 0.574** (embeddings on); exact/morph held |
| impact never silently marks a used symbol "isolated" | `impact-bench` | **SAFETY = 0** invariant, exit-code gated |

> **What we don't claim.** litectx scaffolds *search*; it doesn't replace the model's own intelligence. Live A/B runs found in-run recall/impact gives a strong model no net build-speed win (its bottleneck is reasoning, not finding) and a weaker model a consistent **nudge, not a rescue**. The measured edge is **durable cross-session memory** and **impact's safety invariant**. Full findings, including the nulls, are in [`docs/01-product/benches-prd.md`](docs/01-product/benches-prd.md).

## Where litectx fits

litectx is the **context organ** — what an agent *knows* and how it's organized. It pairs with [baresuite](https://github.com/hamr0/bareagent) (`bareagent` + `bareguard`), the **runtime** — what an agent *does*, step by step, safely. They meet at one seam (a `{ store, search, get, delete }` interface); the dependency points one way.

| | baresuite | litectx |
|---|---|---|
| **is a** | runtime / harness | library |
| **owns** | loop, tools, gates, budgets | recall, impact, graph, memory, the context verbs |
| **made for** | lightweight **one-shot** automation | **persistent, long-running** loops |
| **LLM / loop** | yes | no — deterministic |
| **depends on** | imports litectx | nothing (standalone) |

> Capabilities marked ⊘ **CEDE** in the design docs are what litectx deliberately *doesn't* do because it belongs to baresuite (the agent loop, orchestration, the *decision* of when to compress). litectx owns the data and the mechanism; baresuite owns the control flow.

## Docs

| | |
|---|---|
| **Integration Guide** (`litectx.context.md`) | The complete adopter contract — every option, the full API, the graph schema, the refusals. *Hand it to your AI assistant.* Ships in the package. |
| **[PRD](docs/01-product/litectx-memory-prd.md)** | Locked decisions + *why*, the substrate/views model, the POC gate, the refusals. *(repo-only)* |
| **[Benches PRD](docs/01-product/benches-prd.md)** | The validation story in full — every bench, every finding, the nulls. *(repo-only)* |
| **[CHANGELOG](CHANGELOG.md)** | keep-a-changelog; an entry every release. |

## License

Apache 2.0. See [LICENSE](LICENSE).
