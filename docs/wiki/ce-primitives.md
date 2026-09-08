---
type: reference
title: CE Primitives — Write, Select, Compress, Isolate
status: stable
sources: [docs/archive/litectx-prd.md]
---

litectx's Part 2 specs the four **context-engineering (CE) primitives** — Write, Select,
Compress, Isolate — built on top of the code+context graph that Part 1 (the memory engine)
already provides. Part 2 does not re-spec the graph; it references it and adds what's new
(litectx-prd.md:2138-2145).

## How to read a requirement

Each requirement carries an **ID**, **primitive**, **what** (1–2 lines), **derives-from** (the
prior-art leader it borrows from), **surface** (the litectx API shape), **determinism** (🟢
deterministic core / 🟡 deterministic scaffold + ⊘ ceded LLM step / ⊘ fully ceded), **precedent**
(aurora ledger or net-new), and **delta** vs Part 1 (litectx-prd.md:2113-2116).

Two binding constraints apply to every requirement:

- **The Lite line:** no service/daemon, no external graph DB, no LLM-on-write/index, single-file
  SQLite, embeddings and any LLM step are opt-in tiers, one production-dependency bar
  (`better-sqlite3`). A requirement that can't be met within this line is **⊘ ceded, not bent**
  (litectx-prd.md:2118-2122).
- **Standalone, copy-don't-depend:** litectx is standalone — baresuite consumes litectx, never
  the reverse. Anything lifted from bareagent/bareguard is copied/adapted into litectx's own
  implementation, never a runtime dependency; when litectx runs inside baresuite it composes
  with the originals (litectx-prd.md:2124-2130).

## 1. Foundation — the context graph as data structure

Part 1 already provides (🧩 CORE, referenced not re-specced here): the code+context graph
(typed nodes + `calls`/`imports`/`depends_on` edges), `recall` (BM25 + ACT-R activation + 1-hop
spreading), `impact` (blast-radius/risk bucket), incremental git-aware indexing, the
`kind`/`format` schema (`code`/`doc` live; `fact`/`episode` shipped), embeddings as the one
opt-in tier, and single-file SQLite/FTS5 storage (litectx-prd.md:2138-2145).

Part 2 adds the **context-graph primitives** the four CE verbs ride on (promoting
`barecontext-prd.md` §4.2 from seed to requirement) (litectx-prd.md:2147-2150):

- **R-G1 Node** ✅ shipped — typed unit of context (`kind`: code/doc/fact/episode) via
  `getNode(id)`; written memory is a zero-chunk/zero-edge node, path-keyed
  (litectx-prd.md:2154).
- **R-G2 Edge** ✅ shipped (import) — `related(id,{edge,dir,hops})`, BFS over persisted `import`
  edges (hops capped at 3, deduped); `calls` stays `impact()`'s job by design (it over-counts);
  `edge` is generic so reserved types (`supersedes`/`derived_from`/`references`/`belongs_to`)
  slot in later with no migration, but none is built yet (litectx-prd.md:2155).
- **R-G3 Provenance** — every node knows its source (tool/doc/sub-agent/session) plus a trust
  label; the label is litectx's, the content-verdict is ceded to bareguard (litectx-prd.md:2156).
- **R-G4 Salience** — relevance-to-intent score generalizing ACT-R activation beyond code,
  surfaced in `recall().signals` (litectx-prd.md:2157).
- **R-G5 Freshness/supersession** ⊘ **dropped** — ruled duplicative of `forget(old)` +
  `remember(new)` upsert; auto-freshness is already `pruneStaleEpisodes` (litectx-prd.md:2158).
- **R-G6 Assembly (read path)** ✅ shipped (v1 = FIT) — `assemble(units, ctx)` →
  `{units, dropped, tokens}`, the CE headline API. FIT budget-fits a neutral unit array,
  recency-anchored and cache-stable, honoring `pinned`/`atomic`, with `dropped[]` handles (no
  silent loss). **SELECT (recall-inject) is killed** — agents already fetch their own code, no
  demand, ~75% noise. A COMPRESS budget tier recovers a would-be-dropped unit as its `compress()`
  signature before eviction when the signature both saves space and fits, validated across two
  POCs on real functions (signature retrieval 8/8 vs drop 0/8; mean real saving 81%, 51–97%);
  `assemble` is async (litectx-prd.md:2159).
- **R-G7 Eviction/decay (forget path)** — author-controlled `evict(policy)`
  (litectx-prd.md:2160).

Retention is **author-owned, never agent-authored**: the agent may request writes/evictions as
gated actions, but the policy that could drop a governing fact belongs to the operator
(litectx-prd.md:2162-2164).

## 2. WRITE — persist context outside the window

WRITE covers durability: the single-file SQLite store across turns/sessions (R-W1, already had
via Part 1 §9); `fact`/`episode` kinds as queryable nodes (R-W2, promoting a Part 1 reserved
kind to built); a schema'd, versioned per-session state object (R-W3, net-new); a durable
notes/scratchpad store surviving compaction (R-W4, net-new); cross-session fact
store/retrieve/supersede via `remember(fact,{source})` (R-W5 — the store is deterministic, but
LLM fact-extraction from prose is ceded); procedural-memory rule serving via
`recall(kind:doc)` (R-W6, already had); and usefulness feedback boosting activation of nodes
that contributed to a successful answer (R-W7 `recordUseful(ids,weight)` — the boost mechanic is
litectx's, the success verdict itself is ceded) (litectx-prd.md:2168-2179).

**Ceded (⊘):** the agent's decision of *when* to write/recite (agent-loop policy → bareagent);
the LLM that extracts a fact from prose (→ harness, opt-in); the verdict that an answer succeeded
(R-W7's input) → harness/bareagent (litectx-prd.md:2180-2182).

## 3. SELECT — pull the right context in

SELECT is ranked/filtered retrieval: BM25 + ACT-R + 1-hop spreading (R-S1, already had); kind-aware
hybrid score fusion (R-S2, already had); an opt-in embeddings re-rank tier, off by default since
dual-hybrid already reaches ≈85% (R-S3, already had); agentic/iterative retrieval — recall as a
re-entrant loop with a cursor rather than one-shot (R-S4, thin net-new); memory-type-aware select
via `recall({kind})` (R-S5, follows R-W2); semantic tool selection over tool definitions (R-S6,
net-new candidate, citing RAG-MCP's 13.6→43.1% lift); and serving both a frontloaded index and
JIT on-demand retrieval (R-S7, already-had pattern) (litectx-prd.md:2186-2196).

- **R-S8 Retrieval-quality signal** ⊘ **dropped** — the design (aurora SOAR Phase 4, never
  built) would have had `recall()` return a NONE/WEAK/GOOD trust label off the activation
  distribution. Dropped because the premise was falsified: shipped `recall` carries no activation
  scores, and cosine-confidence has no usable per-query threshold (AUC 0.92 in aggregate only)
  (litectx-prd.md:2197).

**Ceded (⊘):** which tools the agent ultimately invokes (agent-loop); tool execution
(litectx-prd.md:2199).

## 4. COMPRESS — keep only the tokens that matter

COMPRESS is the token-discipline primitive: coherent chunk-and-rerank before context reaches the
model (R-C1, already had); token-budgeted assembly returning the highest-salience subset — *the*
flagship lite-Compress primitive, `assemble({budget})` = R-G6 (R-C2, net-new); tool-result
clearing that drops raw payloads already acted on and keeps a one-line stub (R-C3, net-new); and
restorable compression — drop a payload but keep a cheap handle to restore on demand (R-C4)
(litectx-prd.md:2203-2210).

- **R-C4 Restorable compression** ✅ shipped (v0.6.0) — a dedicated non-FTS5 `stash` table
  (never indexed → recall-invisible, never pruned → restore always works), via
  `stash(id,text)` + `peek(id)` + `get(id)` + `evict(...)`. **API-only** (an orchestration
  mechanic, not a model-reasoning verb — no CLI/MCP). Deletion is `evict` (R-G7), the stash-only
  deleter; `forget` is memory-only and never reaches the stash table (litectx-prd.md:2210).
- **R-C5 Trim/prune (heuristic)** ✅ shipped — `trim(units, policy)` →
  `{units, dropped, harvest}`, the transcript-truncation seam. SIZE (`maxTokens`) delegates
  wholesale to `assemble`'s fit logic (proven unit-for-unit identical by POC); COUNT
  (`keepLastN`) is the net-new turn-granular policy; both preserve `pinned`/`atomic`. The
  net-new value is COUNT plus the eviction-contract `harvest` (dropped units with content
  intact — a harvest-before-evict worklist). API-only (litectx-prd.md:2211).
- **R-C6 Running-summary scaffold** — `summaryWindow(n)` + hook: litectx decides *what/when* to
  keep verbatim vs summarize; the LLM writes the prose (🟡 scaffold, ⊘ ceded LLM step), net-new
  (litectx-prd.md:2212).
- **R-C7 Rank-tiered render** ✅ shipped — `compress(node,{level})` → `verbatim` | `signature`
  (header + doc, body elided) | `drop`, via tree-sitter signature extraction, saving ~82% bytes
  with the doc kept (measured on 627 real symbols). A pure library export (no DB/ranking) that
  de-risks `assemble()`'s render half; `assemble()` tiers by rank on top of it
  (litectx-prd.md:2213).

**Ceded (⊘):** the LLM that writes the summary (auto-compaction prose); perplexity/LLM token
compression (e.g. LLMLingua) — an opt-in tier behind the embeddings line
(litectx-prd.md:2215-2216).

## 5. ISOLATE — split context across windows

- **R-I1 Namespacing/scope** ✅ shipped — `owner`/`session` on `LiteCtx` (kind-aware), a scope
  key so contexts don't bleed across agents/sessions/users, net-new but built
  (litectx-prd.md:2224).
- **R-I2 State partitioning** — `state.view(fields)` exposes one field of state to the model
  and isolates the rest; follows R-W3 (litectx-prd.md:2225).
- **R-I3 Handle/lazy-load** ✅ shipped (stash-only) — `peek(id)` returns
  `{id,bytes,head,tail,createdAt,truncated}` via SQL first-N/last-N `substr` and octet
  `length`; `get(id)` is the full load. The win is a **bounded result** (only head+tail bytes
  reach the caller's context/token budget) — **not bounded compute**: measured peek wall-time
  scales with payload much like `get` past a few MB, since SQLite still reads the column to
  slice it; a true O(1) peek would need a byte-size column stored at write time (deferred).
  Head+tail (not head-only) matters because the conclusion of a log/trace (exit code, failing
  frame, closing structure) lives at the end. `summary`/`scope` columns stay deferred — head+tail
  already covers logs/traces/text/code; an opaque-blob summary column is added only when a real
  caller supplies one (litectx-prd.md:2226).

**Ceded (⊘):** sub-agent orchestration (fork/lifecycle) and sandboxes → bareagent, which owns
spawning; litectx supplies each child's scoped store. Phase control / human-in-the-loop gating →
harness (litectx-prd.md:2228-2230).

## 6. Cross-cutting — assembly ordering & trust

Four requirements govern how `assemble()` orders and labels its output, independent of any one
primitive:

- **R-X1 Cache-stable ordering** — emit assembled context stable-first / dynamic-last,
  append-only, deterministic serialization; a cross-vendor consensus rule, net-new
  (litectx-prd.md:2238).
- **R-X2 Provenance + credibility** — source plus salience/credibility; supersession retires
  stale/refuted facts; floor supremacy on writes. Shape-verdict and floor are a bareguard lift;
  content-verdict is the litectx/guardrails tier (litectx-prd.md:2239).
- **R-X3 Explicit, testable assembly pipeline** — context built by named, ordered internal
  `processors[]`, not string concatenation, so it's observable and testable
  (litectx-prd.md:2240).
- **R-X4 Authority/precedence ordering** — order and label assembled blocks by a trust/authority
  class (procedural rule > fresh fact > episode > history) so the model resolves conflicts
  predictably. This is the **Context-Clash fix**, distinct from cache-order (R-X1) and freshness
  (R-X2) (litectx-prd.md:2241).

**How X1/X2/X4 compose:** they are three ordering axes, not contradictions. R-X1 fixes the
prefix/suffix split for KV-cache (stable-first, append-only). R-X4 ranks blocks by authority —
but authoritative content (rules) is also the most stable, so it naturally lands in the R-X1
prefix; within the dynamic suffix, blocks order by authority then salience. R-X2 decides which
blocks are even eligible (retiring stale/refuted ones). Positioning-wise (lost-in-the-middle),
highest-salience content goes at the edges — head = rules (R-W6), tail = most-salient/recited
(R-W4) — which is mostly emergent from R-W6 + R-W4 + R-X1; the only net-new sliver is ordering
the dynamic selected block by salience, most-salient at the tail, built as an `assemble()`
heuristic rather than a separate requirement (litectx-prd.md:2243-2251).

## 7. Non-goals (⊘) — CE-scope

Part 2's non-goals are complementary to, not merged with, Part 1 §13's memory-engine non-goals —
a reader wanting the full list of what litectx refuses reads both. litectx is the substrate;
these belong to the harness / bareagent / bareguard (litectx-prd.md:2257-2259):

- **Sub-agent orchestration, agent loop, sandboxes, phase control** → bareagent / harness.
- **The LLM step** in fact-extraction, summarization, auto-compaction, perplexity compression →
  opt-in tier / harness (litectx feeds it deterministically, never requires it).
- **Tool masking / KV-cache logit control** → inference runtime.
- **Prompt authoring** ("right altitude") → user / harness.
- **Content-trust judgment** (is this fact safe / a secret / an injection?) → bareguard; litectx
  carries the provenance label, bareguard renders the verdict.
- **Visual/GUI substrate** (screenshots as tokens, CUA) → out of scope.
- Plus all Part 1 §13 carry-overs: no LSP, no token *budgeting policy* (litectx does
  budget-aware assembly, not budget enforcement), no multi-provider LLM clients as default
  (litectx-prd.md:2261-2270).
