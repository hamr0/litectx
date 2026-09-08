---
type: reference
title: litectx PRD Overview
status: stable
sources: [docs/archive/litectx-prd.md]
---

## What litectx is

litectx is a lite, local-first library that indexes a codebase and its docs into a
**code+context graph** and ranks/relates that graph with ACT-R cognitive activation. The graph
itself is the product: **recall** ("what's most relevant to this?", ranked by BM25 + ACT-R
activation, embeddings optional) and **impact** ("if I change this, what breaks and how risky?",
via call/import edges → reference count → risk bucket) are two read-*views* over one substrate,
not separate features (litectx-prd.md:57-66,119-124). Because the typed node+edge graph is
exposed as public API, `codegraph`/`contextgraph` are additional views over the same data rather
than re-extractions — `contextgraph` already ships as the `observe()`/`trace` pipeline view
(litectx-prd.md:64-66,126-130).

Node `kind` is first-class from day one: v1 implements `code` and `doc` (md), with `fact`,
`episode`, and other doc formats reserved in the schema so the engine can grow into a general
short/long-term ACT-R memory without a migration (litectx-prd.md:67-69). v1 languages are
TypeScript, JavaScript, and Python, routed by file extension. The stack is Node, pure ESM JS +
JSDoc (no build step), `better-sqlite3` + FTS5, `web-tree-sitter`, and `ripgrep` — zero external
binaries required; embeddings are the one opt-in tier (litectx-prd.md:70-73). Edge/impact
resolution is tree-sitter + `ripgrep -w` only: **no LSP server, ever**
(litectx-prd.md:74).

The method is *borrow, don't port*: litectx reimplements AURORA's validated algorithms
(ACT-R activation, the edge graph, block-level git signals, tree-sitter chunking, code-aware
BM25) in clean ESM JS, carrying over calibration rather than code, and leaving behind AURORA's
LLM orchestration layer that a harness already supplies (litectx-prd.md:75,100-104).

The four context-engineering primitives — **Write** (`remember`/`forget`/scratchpad), **Select**
(recall + tool/quality signals), **Compress** (`assemble`/`compress`/`stash`/`trim`/
`summaryWindow`), **Isolate** (scope/`peek`) — ride on the same graph as Part 2 of the PRD, with a
deterministic core and every LLM step ceded or opt-in. This is what makes litectx a comprehensive,
long-running CE library rather than just a code index (litectx-prd.md:76-80).

## Why this exists

AI coding agents re-discover the same codebase every session — grep, read, lose the thread,
forget last turn — and edit blindly without knowing what calls what. litectx gives an agent a
persistent, ranked, relationship-aware memory of the code and a blast-radius signal before it
edits, computed locally, with no service and no required ML (litectx-prd.md:94-98).

## Scope — one substrate, two views (DECIDED)

The core deliverable is a code+context graph with:

- **Nodes** — typed context units: code chunks (function/method/class with name/signature/
  docstring/line-range) and doc chunks (md sections) in v1.
- **Edges** — typed relationships: `calls`, `imports`, `depends_on` (extensible).
- **Per-node signals** — git (block-level commits/recency), activation (access count/recency),
  AST complexity (litectx-prd.md:110-117).

| View | Question it answers | Primary inputs |
|---|---|---|
| recall | what's most relevant to *this*? | FTS5/BM25 + ACT-R activation (+ optional embeddings) |
| impact | if I change *this*, what breaks and how risky? | call/import edges → reference count → risk bucket |

(litectx-prd.md:119-124)

### Module architecture

The engine decomposes into small ESM modules with a strict, acyclic dependency DAG: `store`
(SQLite/FTS5, all SQL, `getNode`/`related`), `indexer` (pass orchestration), `langdef`
(per-language registry), `chunker` (file → tree-sitter/section chunks), `gitsig` (file-level git
signals, displayed not scored), `edges` (import edges + 1-hop additive spreading; `calls` computed
on-demand by `impact`, never persisted), `tokenize` (code-aware BM25 body), `activation` (ACT-R
pure functions, deferred to the access-log tier), `recall` (kind-scoped FTS gate + BM25 +
spreading), `impact` (callees via tree-sitter walk + callers via `rg -w`→confirm, risk bucket),
`embeddings` (semantic tier, off by default), and the `LiteCtx` facade (litectx-prd.md:138-152).

Seam rules: `store` persists FTS content but never builds it (that's `tokenize`'s job); there is
one `langdef` registry shared by chunking/edges/complexity; `activation` stays pure so the bench
can ablate each term; `recall` is its own module, not folded into the facade
(litectx-prd.md:153-165).

## Tiers & defaults (DECIDED)

| Capability | Default | Tier (opt-in) | Rationale |
|---|---|---|---|
| BM25 + ACT-R recall | on | — | the lite core; zero ML |
| Block-level git signals | on | — | cheap, high-value |
| tree-sitter + ripgrep edges | on | — | zero external binaries; sole edge resolver |
| Embeddings (semantic) + MMR | off | `@xenova/transformers` (ONNX); vectors = float32 BLOB in the one file | +10% quality; cost is +ML dep + index-time embedding |

Embeddings are the only tier — there is no LSP tier. Default model is
`Xenova/all-MiniLM-L6-v2` (384-dim, ~90 MB, POC-proven), swappable via `embedModel`; a
code-specific `jina-embeddings-v2-base-code` candidate was noted as a pure config swap that would
need to beat MiniLM on the recall bench to earn the default (litectx-prd.md:1109-1126).

## Storage (DECIDED — closed question)

`better-sqlite3` + FTS5 in a single file, synchronous (no connection-pool tax), giving BM25
natively in SQL — settled as correct and final for a local-first library
(litectx-prd.md:1130-1134). Vectors (embeddings tier only) live as a `float32` BLOB column in the
same file; `sqlite-vec` was rejected because recall is BM25-gated so cosine only ever runs over
the candidate pool (sub-ms brute-force at any repo size), and a native extension would cut against
the one-dep doctrine — no second datastore (litectx-prd.md:1135-1138).

Tables (from AURORA, slimmed): `chunks`/`nodes` (with `kind`, `format`, `path`, `source`,
`provenance`, `occurred_at`), `relationships` (edges, indexed both ends), `activations` (reserved
— v1 has no scored access log), `file_index` (litectx-prd.md:1139-1142). The `source` column
(`file`/`direct`) discriminates indexed vs written rows so `index()` reconciles only file-sourced
rows against disk, letting indexed and written memory share one store
(litectx-prd.md:1143-1146). Every `recall()` hit appends an audit row to a recall log — the
genuine access log the activation/base-level tier will later score; v1 records but does not rank
on it, and it also feeds HITL promotion (litectx-prd.md:1147-1151).

## Relationship to the bare suite

```
   bareagent  ── agent loop runner ──┐
        │                            ├─ may use → litectx  (code-aware memory; THIS doc)
        ▼                            │
   bareguard  ── policy + audit (the governance floor)
```

litectx is orthogonal to bareguard: it never touches token budgets, allowlists, or
content-judgment (those are bareguard/harness concerns). It is a leaf-ish local library a runner
*uses* (litectx-prd.md:1157-1167).

## Non-goals (NON-GOAL)

- Any LSP/language-server integration — ripgrep + lang-def only; import-vs-usage separation and
  binding-precise dead-code are out of scope (a *candidate* dead-code signal via inverse impact
  still ships, just not LSP-grade).
- Token budgeting / context-window trimming / compaction — a runner/harness concern.
- Content guardrails (secret/PII/injection scanning, policy enforcement) — bareguard's job.
- LLM orchestration / task decomposition / agent spawning — AURORA's `soar`/`reasoning`.
- Multi-provider LLM clients / embeddings-as-default — provider-agnostic; ML is opt-in.
- PDF/DOCX extraction — originally deferred, but **SHIPPED** post-v0.16 via `ctx.ingest()` on the
  optional `pdfjs-dist`/`mammoth` tier as the unified file-ingest path (md/pdf/docx/plaintext →
  chunked; anything else → byte-exact blob). OCR for scanned PDFs remains a non-goal; body-search
  for off-allowlist types is opt-in only.
- A server/daemon/hosted service — local library only.
- Linting — mature per-language linters exist; litectx does not wrap them.
- Being "bare" — litectx is a real library, not a ≤150-LOC primitive.

(litectx-prd.md:1631-1648)

## Open questions (settled during build)

1. **Cold-start / git-seeded activation — CLOSED.** A Slice-4 Step-0 POC across two repos showed
   git-seeded base-level activation does not earn v1 ranking weight, even with decay+churn — it
   is net-positive on aurora but net-negative on gitdone at every tested weight, because v1 has no
   real access log to give base-level signal. Resolution: base-level activation moves to the
   access-log tier; git becomes passive, displayed-not-scored activity metadata; the v1 ranking
   lift comes from import-spreading, which held ≥ baseline on both repos
   (litectx-prd.md:1654-1665).
2. **MMR without embeddings** — deferred; MMR stays embeddings-tier only (litectx-prd.md:1666-1667).
3. **Edge types beyond `calls`/`imports`/`depends_on`** — leaning toward deferring
   `inherits`/`defines`; the three existing types cover impact (litectx-prd.md:1668-1669).
4. **Access-history write path — the access-log tier, SETTLED.** The governing rule: use can make
   a memory more *trusted/stable* (a property of the item) but must never make it rank higher
   globally. A `poc/access-bench.mjs` POC found edit-bind activation predicts next-edit well
   (AUC 0.79–0.97) but folding it into recall as a re-rank term is repo-dependent and pollutes —
   both flat and query-conditioned forms fail the every-corpus rule, so **edit→recall re-ranking
   ships at zero weight**. The tier instead ships as four safe parts: (1) search ranking stays
   untouched; (2) trust/stability surfaces as columns (`provenance`/`use`/`occurredAt`), never a
   score; (3) a separate "what was I working on" view over recent episodes + chunk-edits, free to
   use recency since it never touches search ranking; (4) an episode life-cycle ladder —
   `promotionCandidates(10)` flags hot episodes for an agent to distil into a fact, which then
   rides the existing `reviewCandidates(5)` human-validation path; episodes soft-decay after 30
   days (litectx-prd.md:1670-1817).
5. **Consumption surfaces & graph-view packaging — RESOLVED.** The core is the library. A thin CLI
   ships in-repo from v1. MCP ships as a second bin in the same package (`bin/litectx-mcp.js`)
   rather than a separate package — a POC proved a hand-rolled stdio JSON-RPC server needs no SDK
   and zero new deps, and stdio client-spawned is not a service. Both surfaces are thin adapters
   over the public API; nothing in `src/` knows about them (litectx-prd.md:1818-1833).
6. **`fact`/`episode` kinds — RESOLVED.** Written via `remember(id, text, {kind})` by the
   consumer; litectx ships no extraction LLM. They don't share code's decay map: `fact` is durable
   (slow), `episode` is recency-fast (fast), no schema change. No edges/spreading; ranked by
   BM25(+embeddings). Access-log behavior follows the §14 #4 design, not reinforcement-on-retrieval
   (litectx-prd.md:1834-1843).
7. **Retrieval-confidence label — CLOSED, POC-falsified.** A per-query "this retrieval is too weak
   to act on" label was tested three ways (activation distribution — never shipped into recall;
   raw BM25 magnitude — a forbidden repo-dependent prior; top embeddings cosine — separates
   answerable/unanswerable in aggregate at AUC 0.92 but has no usable per-query threshold, since
   paraphrase/morph answers score in the same band as genuinely unanswerable queries). Not built
   (litectx-prd.md:1844-1862).

## Status (memory engine)

**Shipped (slices 0–11, v0.3.0):** read surface + write path + chunk-granular recall + `get(id)`
body access + MCP/CLI surfaces + KNN union, with the access-log tier complete (`recentActivity`,
`promotionCandidates`, trust columns). v0.4.0 added the access-log tier as a release plus an
optional Claude Code integration; v0.5.0 made embeddings semantic-by-default on CLI/MCP with a
BM25 fallback, driven by a recall-litmus POC showing ~+0.2 MRR on natural-language code recall
(litectx-prd.md:1866-1879).

A 2026-06-11 security audit found the memory surface clean (parameterized SQL, `execFileSync`
array-args, alnum-stripped FTS keywords, id-only `get(id)` reads, stdio-only MCP); one hardening
shipped (`Store.forgetMemory` refuses an empty selector) and one prior issue was resolved by
migrating the optional embeddings dependency to `@huggingface/transformers` v4, closing a
`protobufjs` CVE chain while holding paraphrase recall at 0.574 via pinned `dtype: "q8"`
(litectx-prd.md:1884-1900). `stash(id, text)` shipped as a restorable, non-indexed agent-context
store, structurally separate from searchable memory (litectx-prd.md:1902-1911).

The build methodology, name, stack, storage, edges-are-ripgrep-only, tiers, v1 languages,
`kind`-from-day-one, and the code-over-md fix (kind-scoping, not weights) are all DECIDED
(litectx-prd.md:1913-1925). Four competitor-inspired remainders were surveyed and explicitly
**not** built ahead of their triggers: persisting call edges (bloat until `impact()` latency
actually hurts), an edge-confidence field (ride along with a future schema-touching slice), the
`jina-embeddings-v2-base-code` swap (likely mis-aimed — the embeddings tier's KNN nomination
serves fact/episode, not code), and ergonomic graph accessors (wait for a real consumer to shape
the query pattern) (litectx-prd.md:2048-2081).

## Doc relationship, companions & build-order discipline

litectx ships as one library documented by a single PRD in two parts: **Part 1** is the memory
engine (recall, impact, graph, ACT-R, kinds, indexing, storage); **Part 2** is the CE primitives
built on top, referencing Part 1 rather than re-specifying it. Each part keeps its own non-goals.
The two parts were merged from formerly separate `litectx-memory-prd.md` and `litectx-ce-prd.md`
documents on 2026-06-23, and together supersede the archived `barecontext-prd.md`
(litectx-prd.md:2417-2425).

Engineering companions carry the requirements' evidence rather than the requirements themselves:
build-studies Part A (memory signals + SOAR/CE borrows, file:line) and Part B (LlamaIndex/ADK/
Manus API surface + adaptation deltas), plus the validation bench suite in
`benches-prd.md` (litectx-prd.md:2427-2431).

**Standing build-order discipline:** CE slices come after the memory engine's recall/impact
slices graduate, and every new signal is re-validated on both benchmark repos via the `poc/`
bench gate before it earns any ranking weight (litectx-prd.md:2433-2435).
