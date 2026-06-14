# litectx — Integration Guide

The complete adopter contract: every config option, the full public API, the
scope boundaries, and the sharp edges. The README is the pitch; this is the file
you point an integrating agent at. For the design rationale behind the refusals,
the repo-only PRD (`docs/01-product/litectx-memory-prd.md`) is the authority —
but everything you need to *use* litectx is here.

> **Status (important — read first).** litectx is in **active early build**. This
> document describes the contract **as actually shipped** (slices 0–11: incremental
> indexing, symbol chunking, kind-scoped recall, import edges + spreading, git
> grounding, the `impact` view incl. the slice-5b barrel/alias mitigation, the
> opt-in **embeddings** tier incl. written-kind **KNN union** (paraphrase recall),
> the **write path** — `remember`/`forget` for facts/episodes/direct docs —
> chunk-granular recall, `get(id)` body
> access, and the two consumption surfaces: the **CLI** and the stdio **MCP server**). Where the eventual surface (ACT-R base-level activation
> weighting, persisted `call` edges) is **not yet available**, it is marked
> **🚧 roadmap** — do not wire against it yet. What is documented without that mark works
> today and is covered by tests and the multi-repo benchmark.

---

## What this is

litectx is a local, searchable **memory across kinds** for AI agents, in one
**SQLite** file. Content enters two ways — **`index()`** reads a repository
(code + markdown) from disk, and **`remember()`** writes knowledge that isn't a
file (facts, episodes, runtime docs/FAQs). Over that one store it serves ranked
**recall** (search, kind-scoped) and **impact** (called-by/calling →
blast-radius + risk bucket). It is an `import`-able library that runs **in your
process** against a file on disk — no daemon, no service, no network, no
telemetry. The views read **one** graph built by a single `index()` pass —
`impact()` is computed on demand and never re-extracts, so a symbol you
surface with `recall()` is the same node `impact()` assesses (pinned by
`test/composing.test.js`). The graph is built to grow further (ACT-R-style
activation signals scored on the recall log) under that same one-graph contract.

**The entry path decides the available kinds:** files via `index()` →
`code`/`doc` (by extension — you cannot index a file *as* a fact; distilling a
doc into facts is your extraction, then `remember`). Direct writes via
`remember()` → `fact`/`episode`/`doc`. `doc` is the one kind both produce.
`index()` is **never mandatory** — a litectx used only as a fact/episode store
(no repo, no `index()` call) is a fully supported mode.

## What litectx is and is not

- **Is:** a lite, local-first, in-process memory over your code, docs, and written
  knowledge (facts/episodes), exposing ranked recall, a called-by/calling impact
  view, and a `remember`/`forget` write path. The graph is the substrate and is
  intended to be public API.
- **Is not:** a language server, a vector database, a hosted service, an agent
  framework, or a token-budget/guardrail layer. It has **no LSP tier — ever**
  (see *What's NOT in litectx*). Curation, thresholds, prompt assembly, and budget
  policy belong to the caller, not here.

## Status — what's shipped today

| Capability | State |
|---|---|
| Incremental, git-aware indexing into SQLite (code + md) | ✅ shipped |
| First-class `kind` / `format` per document | ✅ shipped |
| Ranked **recall** over FTS5 (BM25), file-granularity | ✅ shipped |
| Symbol-level `nodes` substrate (tree-sitter: TS/JS/Python + md sections) | ✅ shipped (slice 2) |
| **Kind-scoped recall** (code-over-md fix: kinds never share a ranking) + code-aware body | ✅ shipped (slice 3) |
| **Import edges** + 1-hop **spreading** recall (BM25 + additive boost, w=0.3) | ✅ shipped (slice 4) |
| **Git activity** metadata per hit (`git: { commits, lastCommit }`; grounding, not scored) | ✅ shipped (slice 4) |
| **impact** view (`impact(symbol)`: called-by/calling → risk bucket + complexity, on-demand) | ✅ shipped (slice 5a + 5b barrel/alias resolution) |
| `calls` edges (symbol blast radius) — computed on demand, not persisted (§7.1) | ✅ shipped (slice 5a; `type='call'` row stays reserved for a future persist optimization) |
| Anti-false-isolation for TS aliases / barrels (§7.2) | ✅ shipped (slice 5b — renamed barrel/path-alias re-exports resolved) |
| `getNode` / `related` graph accessors (R-G1/R-G2: describe a node + walk its `import` edges) | ✅ shipped (v0.9.0; API-only) |
| **Embeddings** (semantic tier) | ✅ shipped (slice 6). **ON by default on the CLI + MCP** (`--no-embeddings` for the BM25-only base); the raw `LiteCtx` lib default stays `embeddings: false` (explicit opt-in). `@huggingface/transformers` is an *optional **peer** dep* (**not** auto-installed — `npm i @huggingface/transformers` to enable; graceful BM25 fallback if absent). Near-essential for memory (paraphrase 0.000→0.574); +~0.2 MRR on natural-language code recall. Per-query ~0.7s first load / ~6ms warm (not the mis-borrowed "15–19s") |
| **Write path** — `remember`/`forget` for `fact`/`episode`/direct `doc`; provenance (`by`); recall audit log; `reviewCandidates` HITL query | ✅ shipped (slice 7) |
| **Stemmed fact/episode recall** (porter — inflection-tolerant; doc/code stay keyword-exact by measurement) | ✅ shipped (slice 7b) |
| **Chunk-granular recall** (`hit.chunk` — the matching function/section inside the file) + `log: false` | ✅ shipped (slice 8) |
| **`get(id)` body access** — fetch any item's full text by id (written memory verbatim, files from disk) | ✅ shipped (slice 9) |
| **`recall(q, {body:true})`** — inline each hit's content (verbatim memory / localized chunk / whole-file fallback); off by default | ✅ shipped (v0.10.0 — RT-3) |
| **`remember(id, text, {meta})`** — sealed opaque-metadata passthrough; verbatim round-trip via `get`/`recall`, never tokenized/searched/scored | ✅ shipped (v0.10.0 — RT-3) |
| **`liteCtxAsStore(lc)`** — mount litectx as a host `Store` (`{store,search,get,delete}`); drop-in for a substring-scan backend, ranked recall | ✅ shipped (v0.10.0 — RT-3) |
| **`compress(node, {level})`** — rank-tiered render (R-C7): `verbatim` / `signature` (header + doc, body elided) / `drop`; tree-sitter signature extraction, ~82% bytes saved with the doc kept | ✅ shipped (library API only, like `stash`/`peek`) |
| **`await assemble(units, ctx)`** — RT-1 budget-fit a neutral transcript to a token budget: recency-anchored, `pinned`/`atomic` invariants, `dropped[]`-with-handle, cache-stable order; a would-be-dropped `code`/`doc` unit is recovered as its `compress()` signature (COMPRESS tier) | ✅ shipped (FIT + COMPRESS; SELECT POC-killed; async) |
| **`await trim(units, policy)`** — R-C5 transcript-truncation: evict old turns by SIZE (`maxTokens`, delegates to `assemble`) or COUNT (`keepLastN`); returns the `harvest` worklist (dropped units, content intact) for harvest-before-evict | ✅ shipped (thin verb; `pinned`/`atomic`-safe; API-only) |
| **MCP server** (`litectx-mcp` bin — stdio, client-spawned, all public operations) + CLI write parity (`remember`/`forget`/`--embeddings`/`--no-log`) | ✅ shipped (slice 10) |
| **KNN union** — embeddings-tier paraphrase recall for `fact`/`episode` (cosine nominates, not just re-ranks) | ✅ shipped (slice 11 — bench: para 0.000→0.574, exact/morph held) |
| **`recentActivity()`** — "what was I working on": witnessed chunk-edits, recency-windowed, isolated from recall | ✅ shipped (slice 5a — access-log tier, view #3) |
| **`promotionCandidates()`** — episode promotion ladder: hot agent episodes → distil to facts; 30-day rolling window + auto-prune | ✅ shipped (slice 5b — access-log tier, view #4) |
| **Scope model** (`owner`/`session` config) — `fact` owner-scoped, `episode` owner+session; recall filters BM25 + KNN; opt-in, host-threaded identity | ✅ shipped (Isolate §4.4 — gate #1: own-run episodes buried 5/6 BM25, 9/10 emb without it) |
| **Write-gate emitter** (`writeGate`/`writeAudit` config; `toWriteAction`/`WriteAudit`/`WriteDeniedError` exports) — `remember()` emits a gate-able `memory.write` action + checks it before commit; deny blocks the write; `writeAudit` records a JSONL line per write **standalone (gate-independent)**; litectx states source + shape flag, never the content verdict | ✅ shipped (CE-PRD §10.1 — opt-in; POC 13/13 on the real bareguard `Gate`; gate demand-gated, no producer for `memory.inject`; audit usable now without a gate) |
| **contextgraph** (`observe`/`ContextGraph` exports; `trace` config; `PRIMITIVE`/`VERBS_BY_PRIMITIVE` taxonomy) — wrap a `LiteCtx` and every CE verb call is recorded into `ctx.trace`: a pipeline graph (`.json()` + agent-readable `.mermaid()`). The CE-**pipeline** view over the same data — sibling to `codegraph`'s content view (`getNode`/`related`/`impact`) | ✅ shipped (observability primitive; SVG + interactive renders in `examples/contextgraph`; setup in `docs/03-usage/graphs.md`) |
| Base-level **activation** as a recall *re-rank* (edit→search score) | ⊘ dropped (POC-falsified repo-dependent — the edit signal lives in `recentActivity`, never in ranking) |
| **Trust columns** on written-memory hits (`provenance`/`use`/`occurredAt`; surfaced, not scored) | ✅ shipped (slice 5c — access-log tier, view #2) |
| Trust/stability as a recall *tie-breaker* (use/churn/provenance → search order) | ⊘ dropped (POC-falsified — no-ops on exact ties, pollutes on any band, and buries fresh/better matches; trust ships as columns, ranking stays pure relevance — slice 5c) |
| **Claude Code integration** (optional, `integrations/claude/`) — LSP-free pre-edit `impact()` hook + SessionStart index-warmer; generic MCP server documented for any client | ✅ shipped (v0.4.0; opt-in, nothing in the library depends on it) |

> `recall` ranks by **BM25 + 1-hop additive import-spreading**, kind-scoped (a hit imported by /
> importing a strong hit is lifted, never taxed). This is the v1 default and the robust ceiling for
> graph-only recall — validated ≥ baseline on four repos (aurora/gitdone/aurora-mixed/multis);
> pushing the weight higher overfits one repo and sinks another, so further recall gains come from
> the deferred semantic/access-log tiers, not more graph tuning. `calls` edges are NOT used for
> recall (they don't help; Step-0 POC) — they're reserved for the impact view. Base-level (git-seeded)
> activation was tested and **does not earn ranking weight without a real access log**
> (POC: repo-dependent) — so git activity ships as *grounding metadata*, not a score. (The future
> access-log tier boosts what you actually *retrieve and use* — an "access" — which is distinct
> from git *edits* and from merely *appearing* in results; the latter would be degenerate feedback.)

## Minimal usage

```js
import { LiteCtx } from "litectx";

const ctx = new LiteCtx({ root: "/path/to/repo" });
await ctx.index();                                    // incremental, git-aware
const hits = await ctx.recall("where do we validate the auth token?", { kind: "code" });
// hits: [{ path, kind, format, score, git }, ...]  (score: higher = more relevant; git: activity, not scored)

// memory that isn't a file (slice 7): facts / episodes / runtime docs
await ctx.remember("fact:auth-uses-jwt", "Auth is JWT, verified in middleware.", { kind: "fact", by: "human" });
const facts = await ctx.recall("jwt auth", { kind: "fact" });
// fact/episode hits also carry provenance/use/occurredAt — surfaced for you to weigh, never scored
ctx.get("fact:auth-uses-jwt")?.text;                  // the body itself (recall returns ranked pointers)
ctx.forget("fact:auth-uses-jwt");                     // by key; or forget({ by: "agent" }) in bulk
ctx.close();
```

`index()`, `recall()`, and `remember()` are **async** (`index` parses with a WASM grammar
runtime; `recall`/`remember` embed when the tier is on). `get()`, `forget()`,
`reviewCandidates()`, `size()`, and `close()` are synchronous.

## All options — `LiteCtxConfig`

Passed to `new LiteCtx(config)`. Only `root` is required.

| Option | Type | Default | What it does |
|---|---|---|---|
| `root` | `string` | — (required) | Repository root to index. Throws if omitted. |
| `include` | `string[]` | `[".ts", ".js", ".mjs", ".cjs", ".py", ".md"]` | File extensions to index. Routing is by **extension only** — content is never sniffed. |
| `pathspecs` | `string[]` | unset | Optional git pathspecs to scope the index, e.g. `["app/**/*.js"]`. Applied via `git ls-files`. |
| `dbPath` | `string` | `<root>/.litectx/index.db` | SQLite file path. Use `":memory:"` for an ephemeral in-process index (the parent dir is created for file paths). |
| `embeddings` | `boolean` | `false` | Enable the opt-in **semantic tier**: `index()` embeds each file, `remember()` embeds the text, `recall()` fuses cosine into the ranking — and for `fact`/`episode` also *nominates* the nearest stored vectors into the pool (KNN union: paraphrase recall). Requires the optional peer dep `@huggingface/transformers` (`npm i @huggingface/transformers`). Off → the deterministic BM25 + spreading core, no model loaded. |
| `embedWeight` | `number` | `1.0` | Semantic fusion weight (higher = more semantic). POC-tuned default; held-out-validated, no overfitting cliff. |
| `embedModel` | `string` | `Xenova/all-MiniLM-L6-v2` | transformers.js model id for the tier. |
| `embedder` | `{ embed(text): Promise<Float32Array> }` | built-in | Advanced/testing — inject a custom embedding provider, bypassing the built-in model loading. |
| `owner` | `string` | unset (`null` = global) | **Scope key — the actor.** Scopes durable `fact`s to an actor in a shared store. Unset = unscoped: `recall` is owner-blind (sees & writes everything). Set it (a multi-tenant / shared-db host resolves it host-side — git email, OS user) and `recall` returns **own + global** facts only, never another actor's. `code`/`doc` are never scoped. |
| `session` | `string` | unset (`null` = durable) | **Scope key — the run.** Scopes volatile `episode`s to one run. Unset = unscoped: `recall` sees all sessions' episodes. Set it (a host running concurrent agents threads a run id) and a run's own episodes aren't **buried by more-relevant other sessions** (the measured failure — recency is not a ranking term). `fact`s ignore it (always cross-session). |
| `writeGate` | `{ check(action): Promise<{outcome,…}> }` | unset (no gate) | **Write-gate hook (§10.1).** When set, `remember()` emits a `memory.write` action and `await`s `writeGate.check(action)` **before** persisting; a `deny` outcome throws `WriteDeniedError` and the write does not commit (`allow`/`ask` proceed). Duck-typed — bareguard's `Gate` when embedded, any `.check`-shaped object standalone; litectx is not coupled to a gate version. Unset = byte-identical to a plain write. |
| `writeAudit` | `WriteAudit` | unset | **Standalone audit sink** — records one JSONL decision line per `remember()`. Fires whether or not a `writeGate` is wired: with a gate it logs the gate's decision; **without one it logs a synthetic `allow` (`reason: "no-gate"`)**, so a sink alone gives a complete write paper-trail. The sink (`opts.sink`) defaults to an in-memory `this.lines` array — the host wires a file/db writer. Ships **no** secret patterns: a host-supplied `redact(action)` scrubs (the §6 line — secret patterns are content judgment, the host's to supply). |
| `trace` | `boolean` | `false` | **contextgraph (observability).** When true, the instance is returned wrapped in `observe()` — every CE verb call is recorded into `ctx.trace` (a `ContextGraph`; `.json()` / `.mermaid()`). `ctx.tap(verb, fn)` folds in free-function verbs (`assemble`/`compress`/`summaryWindow`). Off = the bare instance, no proxy, zero overhead. Setup: `docs/03-usage/graphs.md`. |

There is **one** config object and no global state. No environment variables, no
config files — the adopter passes everything in.

> **Scope (§4.4) is opt-in and host-threaded.** Both keys default to unset, so the base behavior is
> byte-identical to an unscoped store: a missing scope reads as global/durable/visible. litectx **stores
> and filters** by these keys; it never resolves identity itself (no `git config` / OS calls in the
> constructor) — the host owns identity and threads `owner`/`session` in. The recall filter is
> `(:me IS NULL OR owner IS NULL OR owner = :me) AND (:sid IS NULL OR session IS NULL OR session = :sid)`
> on **both** the BM25 and the embeddings/KNN paths. Scope lives in a non-FTS sibling table (`mem_scope`)
> so adding it needed no migration of existing data.

## Public API

### `new LiteCtx(config)` → `LiteCtx`
Constructs an instance and opens (or creates) the SQLite store. Creates the
`dbPath` parent directory unless `dbPath === ":memory:"`.

### `await ctx.index(opts?)` → `Promise<IndexResult>`
Builds or **incrementally refreshes** the index over `root`.

- `opts.force?: boolean` — full rebuild (drop + reindex everything).
- `opts.paths?: string[]` — git pathspecs scoping this pass. A scoped pass
  **never deletes** files outside its scope.
- Default (no opts): re-reads only files whose content changed (fast skip on
  `(mtime, size)`, `content_hash` as the arbiter) and drops files that disappeared.

`IndexResult`:
```ts
{ files: number,      // total documents after the pass
  added: number,      // newly indexed
  updated: number,    // re-indexed (content changed)
  removed: number,    // dropped (no longer present)
  unchanged: number } // skipped (mtime/size or content unchanged)
```

### `await ctx.recall(query, opts?)` → `Promise<Hit[] | Record<kind, Hit[]>>`
Ranked recall over the index, **scoped by memory `kind`**. **Async** (since slice 6 — the
embeddings tier embeds the query at call time; with embeddings off the work is synchronous,
just wrapped in a resolved promise, no model touched). `await` it.

**Kinds never share a ranking.** Each kind is FTS-gated and ranked only against its own
kind, in a separate query — so prose volume can never bury code (no weights, no md
penalty). Within a kind, ranking is **BM25 + 1-hop additive import-spreading** (a hit
adjacent to a strong hit in the import graph is lifted; spreading never crosses kinds and
is a no-op for kinds without edges, e.g. `doc`). With the **embeddings tier on**, a wider
BM25-gated pool is additionally re-ranked by semantic cosine (`norm(dual) + embedWeight·norm(cosine)`)
— the gate bounds the cosine work to the candidate pool, never the corpus. For the **written
kinds** (`fact`/`episode`) the tier goes one step further (slice 11): up to 8 stored vectors
nearest the query are **unioned into the pool as nominees**, so a paraphrase sharing *no* words
with a fact can still reach it — nominees enter at the pool's score floor and rank on cosine
alone, so lexical hits keep their head start. `code`/`doc` stay strictly gate-then-rerank. The
return shape follows the `kind` argument:

| call | mode | returns | default `n` |
|---|---|---|---|
| `recall(q, { kind: "code" })` | single kind | flat `Hit[]` | `10` |
| `recall(q, { kind: ["code","fact"] })` | multiple | grouped `{ code:[…], fact:[…] }` | `5` each |
| `recall(q)` | omitted → all `KINDS` | grouped `{ code:[…], doc:[…], fact:[…], episode:[…] }` | `5` each |

- `opts.kind?: string | string[]` — one kind (flat list) or several (grouped). Omitted →
  grouped over **all four** known kinds (the safe CLI/agent default; never a flattened
  ranking). A kind with no content returns an empty array — honest, not an error.
- `opts.n?: number` — max hits **per kind**; raise to dig deeper. No hard cap, no
  pagination (a larger `n` is a larger context — your budget to manage).
- `opts.body?: boolean` (default `false`) — inline each hit's content as `hit.body`. Off by
  default: recall returns **pointers**, not payloads. Opt in to skip the follow-up `get()`s when
  mounting litectx as a memory store or feeding an assembler. Written memory comes back **verbatim**;
  a file hit returns its **localized chunk** (the indexed text that ranked — drift-free), or the
  whole file when nothing localized; `null` when the file is gone or the id is unknown.
- No usable query terms → `[]` (single kind) or all-empty groups.
- `opts.log?: boolean` (default `true`) — set `false` to skip the recall audit log. The log
  is a **demand signal**: queries from dashboards, CI checks, batch tooling, or a read-only
  db open aren't real demand and shouldn't pollute it.
- **Side effect (unless `log: false`):** every hit returned is appended to the **recall
  audit log** (slice 7) — the trail behind `reviewCandidates` and the future access-log
  activation tier. Each row records the hit's chunk symbol, so the future edit-bind can
  join "recalled" and "edited" at the same grain. Ranking is unaffected.

`Hit`:
```ts
{ path: string,    // repo-relative file path — or, for written memory, the caller's `id` key
  kind: string,    // "code" | "doc" | "fact" | "episode"
  format: string,  // "ts" | "js" | "py" | "md" | "text" | ...
  score: number,   // higher = more relevant (BM25 + additive import-spreading)
  git: { commits: number, lastCommit: number|null } | null,  // activity metadata; null = no history
  chunk: { symbol: string|null, nodeType: string,            // the best-matching chunk INSIDE the
           startLine: number, endLine: number } | null,      // hit — a function pointer, not just a file
  // written-memory grounding (slice 5c) — present on fact/episode hits, absent on indexed files:
  provenance?: "human" | "agent",  // validation status (signed-off vs the agent's own assertion)
  use?: number,                    // recall-demand count ('recall' rows only); a fresh memory reads 0
  occurredAt?: number|null,        // episode timestamp (epoch ms); null for facts
  body?: string | null,            // the hit's content — ONLY when called with { body: true } (see above)
  meta?: Record<string, unknown> } // opaque caller metadata (RT-3), verbatim; written memory only
```
> `git` is **grounding, not scored** — file-level commit count + last-commit unix-time (seconds),
> from one `git log` pass at index time. It never affects ranking; `null` means no commit history
> (a non-git tree, or a tracked-but-uncommitted file).
>
> `provenance` / `use` / `occurredAt` (slice 5c) are the **written-memory analog of `git` — surfaced,
> never scored.** Ranking stays pure relevance; these columns are for the *caller* to weigh. Two
> deliberate non-signals: `provenance` is a **validation** axis, not quality (an `agent` fact may be
> perfectly true, awaiting human review — it is not "worse" than a `human` one), and `use: 0` marks a
> fresh memory, **not** a demerit. Ranking on either would be a who-said-it / popularity prior, which
> the access-log POCs falsified (a trust/use tie-break can't reorder safely and buries better-matching
> or fresh answers). They're absent on indexed-file hits — a file is not a claim awaiting validation.
> `chunk` is **chunk-granular recall**: the function / method / md-section inside the file that
> best carries your query terms (0-based inclusive lines). It **localizes, never reorders** —
> ranking stays file-level and bench-identical. The most *specific* match wins: a class that
> merely contains the matching method never shadows it, and an anonymous arrow is labeled with
> its nearest named container. A symbol's chunk now **includes its own leading doc-comment**
> (JSDoc / `//` / `#` block immediately above it), so a query phrased in a function's
> *documentation* localizes to that function — not to the file preamble where the comment would
> otherwise orphan. `null` when nothing localizes: written memory has no chunks
> (the row IS the unit), and a match carried only by the filename names none.
> `body` rides only when you pass `{ body: true }` (see the option above); `meta` is the **sealed
> opaque metadata** (RT-3) a caller attached via `remember({ meta })` — returned verbatim but stored
> in no FTS table, so it is **never tokenized, searched, or scored** (a term that lives only in `meta`
> can't make the memory recallable). Both are written-memory concerns, absent on indexed files.
> 🚧 The richer roadmap shape (`{ id, signals: { bm25, activation, ... } }`)
> is not shipped yet.

### `ctx.get(id, opts?)` → `Item | null`
**Body access** (slice 9) — the read counterpart to `recall`: recall returns ranked
*pointers* (paths/ids), `get` returns the *thing itself*. Synchronous (no embedder
involved). Any id works:

- a **written-memory id** (`"fact:auth-uses-jwt"`) → the text **verbatim as remembered**
  (the FTS body is a processed searchable surface, never the deliverable);
- an **indexed file's repo-relative path** (`"src/auth.js"`) → the file **read fresh from
  disk** — the index stores the searchable surface, not a copy of your files, so you always
  see the current content (`text: null` only when the file has vanished since the last
  `index()`; the next pass sweeps the row).

```ts
Item = {
  id: string,                        // the written id, or the repo-relative path
  kind: string,                      // "code" | "doc" | "fact" | "episode"
  format: string,                    // "ts" | "js" | "py" | "md" | "text" | ...
  source: "file" | "direct",         // indexed from disk vs written via remember()
  provenance: "human"|"agent"|null,  // written memory only; null for files
  occurredAt: number | null,         // episode timestamp (epoch ms)
  text: string | null,               // the full body
  meta: Record<string, unknown>|null,// opaque caller metadata, verbatim; null for files / none
}
```

Unknown id → `null`. On the (pathological) collision of a written id with a real file
path, the written row wins — namespace your ids (`"fact:…"`) and it never comes up.

- `opts.log?: boolean` (default `true`) — each `get` appends an `action: 'fetch'` row to
  the audit log. A fetch is a **tagged weak signal, not demand**: you fetch what recall
  just returned, so counting fetches as demand would double-count every retrieval (the
  fetch-toll). `recallCount`/`reviewCandidates` read `action: 'recall'` rows only; nothing
  scores the fetch tag yet (it earns weight, if any, at the action-signal bench). Set
  `log: false` for non-demand consumers, same as `recall`.

### `await ctx.impact(symbol)` → `Promise<Impact | null>`
The **impact** view (§7): *if I change this symbol, what's the blast radius and how risky?*
**Computed on demand, not persisted** — callees by a tree-sitter walk of the symbol's body,
callers by an `rg -w` sweep confirmed with tree-sitter. No LSP, ever. Returns `null` when the
symbol isn't defined in the index (impact answers for *your* symbols). Async (it shells `rg`).

```ts
Impact = {
  symbol: string,
  defs: { path: string, startLine: number, endLine: number }[],  // every definition (over-count: all)
  refCount: number,     // max(confirmed, mentions) — the over-count-safe blast radius
  confirmed: number,    // tree-sitter-confirmed external call sites
  mentions: number,     // external `rg -w` word occurrences (the safety floor)
  risk: "low" | "medium" | "high",   // bucket on refCount: ≤2 / 3–10 / 11+
  complexity: number,   // cyclomatic-ish decision-point count (max over defs)
  callers: { path: string, line: number, symbol: string | null, alias?: string }[],  // confirmed call sites (incl. bare `@decorator` applications; `alias` set when reached via a renamed barrel re-export)
  callees: string[],    // intra-repo names this symbol calls (externals dropped)
  hedges: string[],     // §7.2 safety caveats — see below
}
```

**The safety model (§7.2) is the whole point.** Over-count is safe (over-cautious); under-count is
dangerous (a false "isolated → safe" breaks hidden consumers). So:
- `refCount` is `max(confirmed, mentions)` — the **looser** signal wins, never the smaller one.
  Resolution is by **name only** (no receiver typing — that's the LSP we don't have), so a common
  method name reads as higher-risk. That is intended: cautious, not precise (calibration borrowed
  from aurora's `lsp_tool`, thresholds ≤2/3–10/11+).
- **"isolated / low-risk" is never silent.** When `refCount` is 0 or all mentions are unconfirmed,
  `hedges` explains why — an unconfirmed mention is *counted, not dropped* ("unresolved ≠ absent"),
  and an exported/public name is flagged for invisible external consumers. A clean isolation verdict
  is never returned; it's always a hedged *review candidate*.
- **Renamed barrel / path-alias re-exports are resolved** (slice 5b). A symbol reached only as a
  renamed re-export — `export { default as Panel } from "./impl"`, imported via a tsconfig `paths`
  alias and called as `Panel()` — is invisible to a name-only sweep; `impact()` follows the barrel
  and tsconfig `paths` to find the real callers (tagged with `caller.alias`) and a hedge naming the
  alias, so it no longer reads as a false isolation. Single-hop barrels and JS/TS only — multi-hop
  barrel chains and Python `from x import y as z` re-export barrels are not yet followed.

### `ctx.getNode(id)` → `GraphNode | null`
The **graph substrate** (R-G1): describe one node's *structure* — the counterpart to `get`, which
returns its *body*. The graph is first-class public API; recall and impact are views over it, and so
is the example code-map (`examples/graph-view/`). **Kind-agnostic** — an indexed file's repo-relative
path returns a file node (its symbols as `chunks` + exact import-edge counts); a written-memory id
returns a zero-chunk, zero-edge node. Edge counts are over the **persisted `import` graph (exact)** —
call relationships are `impact()`'s on-demand job, never persisted as edges. Sync; `null` if unknown.

```ts
GraphNode = {
  id: string, kind: string, format: string,
  source: "file" | "direct",
  provenance?: "human" | "agent",        // written memory only
  git: { commits, lastCommit } | null,   // file activity (grounding, not scored); null for written memory
  chunks: { symbol: string|null, nodeType: string, startLine: number, endLine: number }[],  // [] for written memory
  edges: { imports: number, importedBy: number },  // EXACT persisted import-edge counts
}
```

### `ctx.related(id, opts?)` → `{ items: RelatedNode[], truncated: boolean }`
The **graph navigator** (R-G2): walk the persisted edge graph from `id`. BFS over `opts.edge` edges
(`"import"` is the only persisted type today — `call`/blast is `impact()`). `opts.dir`: `"out"` = what
`id` imports, `"in"` = what imports it, `"both"` = the neighbourhood (default). `opts.hops` = BFS depth
(default 1, **hard-capped at 3**; `truncated` flags when a larger request was clamped). Deduped,
nearest-hop-wins, excludes the seed. `edge` is a **generic type** so future non-code edges
(`derived_from`/`supersedes`) slot in unchanged once a producer emits them. Sync.

```ts
RelatedNode = { id: string, kind: string|null, format: string|null, hops: number, via: "out"|"in" }
```
Invariant: `getNode(id).edges.imports === related(id,{dir:"out",hops:1}).items.length` (and
`importedBy` ↔ `dir:"in"`). The exact import graph is the *map*; `impact()` is the fuzzy risk *readout*
laid over it — never drawn as edges (so a probabilistic signal can't masquerade as precise structure).

### `await ctx.remember(id, text, opts?)` → `Promise<void>`
Write one **directly-authored memory** — knowledge that isn't a file (slice 7). The write
counterpart to `index()`. **Upsert by `id`**: writing the same id again replaces the
content. The `id` is your handle for update/forget — namespace it (`"fact:auth-uses-jwt"`,
`"faq:refunds"`, `"ep:2026-06-09-deploy"`); it appears as the hit's `path` in recall.

- `opts.kind?: "fact" | "episode" | "doc"` — default `"fact"`.
  - **`fact`** — a durable, decontextualized assertion ("we use JWT"). No timestamp.
  - **`episode`** — a time-stamped event ("deploy rolled back on …"). `occurredAt` applies.
  - **`doc`** — a prose passage handed to you at runtime (an FAQ/KB entry with no file).
  - `code` is rejected — code enters via `index()` only.
- `opts.by?: "human" | "agent"` — **provenance** (who asserted it), default `"agent"`.
  The trust axis: human-asserted is durable/high-trust; agent-asserted is tentative until
  promoted (see `reviewCandidates`). Stored now; trust-*weighted ranking* is 🚧 roadmap.
- `opts.occurredAt?: number` — episode timestamp, epoch **ms**; defaults to write-time.
  Ignored for facts/docs (a durable assertion has no constitutive "when").
- `opts.format?: string` — defaults to `"md"` for docs, `"text"` otherwise. Metadata only
  for direct writes (nothing is chunked or parsed).
- `opts.meta?: Record<string, unknown>` — an **opaque caller dict** (RT-3), stored verbatim and
  returned untouched by `get`/`recall` (as `.meta`). It lives in **no FTS table** — never tokenized,
  searched, or scored — so it's the sealed passthrough that lets litectx stand in as a generic
  key-value memory store (see `liteCtxAsStore`). Keep it to **small structured tags** (`{ sessionId,
  tag, author }`); park large payloads in `stash`, not here. Re-`remember`ing without `meta` clears
  any prior meta (the latest write wins, like the text).
- `opts.injectionRisk?: "low" | "medium" | "high"` — an **optional guardrails shape flag** forwarded
  to a wired `writeGate` action. litectx core never computes it (the §6 line — content judgment is the
  guardrails tier's / gate's job); it only passes through what a caller sets. Ignored when no `writeGate`.

**Write-gate (§10.1, opt-in via `writeGate` config).** When a `writeGate` is wired, `remember()` first
builds a gate-able action `{ type: "memory.write", kind, provenance: by, text, id, meta?, injectionRisk? }`
(via the exported `toWriteAction`) and `await`s `writeGate.check(action)` **before any side effect**. A
`deny` outcome throws `WriteDeniedError` (carrying `.id` + `.decision`) and **nothing persists** — a denied
write is a true no-op (no embedding computed, no episode prune, no row written); `allow`/`ask` proceed to
the write. litectx states the **source** (`provenance`) + an optional `injectionRisk` flag; the gate
renders deny/ask — litectx never makes the content verdict. Default (no `writeGate`) is unchanged.

**Audit is decoupled from the gate.** A `writeAudit` records one decision line per `remember()` whenever
it is set — gate or not. With a gate it logs the gate's decision (and `deny` still blocks); **without a
gate every write is logged as a synthetic `allow` with `reason: "no-gate"`**, so you get a complete
write paper-trail from a sink alone (no need to stand up a permissive gate). Host `redact` scrubs in both
cases. This makes `WriteAudit` usable as the standalone paper-trail its name implies.

```js
import { LiteCtx, WriteAudit } from "litectx";
import fs from "node:fs";

const lc = new LiteCtx({
  root,
  writeAudit: new WriteAudit({
    sink:   (line)   => fs.appendFileSync("memory-audit.jsonl", JSON.stringify(line) + "\n"), // default: in-memory `audit.lines`
    redact: (action) => ({ ...action, text: scrub(action.text) }),  // litectx ships NO patterns — you supply them
  }),
  // writeGate: someGate,   // OPTIONAL — add only for deny/ask (e.g. bareguard); the audit works without it
});
// every remember() now appends one JSONL line — AND so does every liteCtxAsStore(lc).store(),
// since the adapter writes through remember() (below). Wire the sink once on `lc`; consumers stay transparent.
```

Content is stored **whole** — one searchable unit, no tree-sitter/section chunking. You
control granularity by how you split before writing (ten atomic facts beat one blob).
With the embeddings tier on, `remember` embeds the text at write time (hence async).

Written memory **coexists with the index in one store and survives every `index()`
pass** — structurally: `index()` reconciles deletions only against files it has itself
indexed, and written rows are never in that set. This includes `index({ force: true })`:
a force pass clears and re-reads **file-sourced data only** — written memory, its raw
text/embeddings, and the audit log are never touched (nothing about them is re-derivable
from disk).

### `ctx.forget(idOrQuery)` → `number`
Delete directly-written memory. Returns the number of rows removed.

- `forget("fact:auth-uses-jwt")` — drop one item by key.
- `forget({ kind: "fact", by: "agent" })` — **bulk invalidation** by query: every
  agent-asserted fact. At least one of `kind` / `by` is required — `forget({})` throws, enforced
  at both the public wrapper and the store layer, so an empty selector can never wipe all memory.

**`forget` can never touch indexed files** — it operates only on written
(`remember`-created) rows. To remove an indexed file from the store, delete the file and
re-`index()`. **`forget` is memory-only** — it does **not** reach the stash table; clean parked
payloads with `evict` (below).

### `ctx.stash(id, text)` → `void`
Park a payload in the **keyed agent-context store** — the durable half of *restorable compression*
(R-C4). Drop a large payload (a tool result, a fetched page, a file dump) out of your context window,
keep only the cheap `id`; `get(id)` rehydrates the full text on demand and `evict(id)` drops it.

- A stash is **not memory.** It lives in no FTS table, so `recall` **never** surfaces it — on any
  kind — and it is **never auto-pruned** (unlike episodes), so a restore always works. Reachable only
  by exact `id`.
- Upsert by `id` (also the rehydrate/evict handle — namespace it, e.g. `"stash:toolresult-42"`).
- Sync, and never embedded (a stash isn't meaning-searchable — that's the point).

*Library API only, by design — not a CLI or MCP tool. Parking a payload is a runtime mechanic the
host loop performs, not a call a reasoning model makes; the MCP surface stays the model's verbs
(recall/remember/impact).*

### `ctx.peek(id)` → `{ id, bytes, head, tail, createdAt, truncated } | null`
The **read-half of `stash`** — *handle / lazy-load* (R-I3). A cheap **head+tail** preview of a parked
blob *without* rehydrating it: where `get(id)` pays the whole payload's tokens back, `peek` returns only
the handle — `head` (a fixed-length prefix), `tail` (a fixed-length suffix — the *conclusion*: exit
code, failing frame, closing structure), `bytes` (the true octet size), `createdAt` (parked-at, ms), and
`truncated` (whether a middle span is elided). Reason over the handle; call `get(id)` to load the full
body **only if you decide you need it**. `null` for an unknown id.

- **Head+tail, not head-only.** For the payloads stash holds — logs, traces, tool results — the verdict
  is at the END, so a head-only preview would miss it. `tail` is empty when `head` already holds the
  whole payload (no middle to elide).
- **Bounded result, not bounded compute.** Only ~head+tail bytes return to the caller regardless of
  payload size — the blob stays out of your context/token budget (the point of a lazy-load handle).
  This is *not* a DB-time win: SQLite reads the column to `substr`/`length` it, so peek's local compute
  scales with payload (measured comparable to `get`, slower past a few MB — `get` directly if you'll
  load it anyway). An O(1) peek would need the byte size stored at write time (a deferred column).
- **Truncation is signalled, never lossy.** `truncated` + `bytes` tell you the preview omits a span; the
  untruncated body is always one `get(id)` away. `peek` is a read-only view.
- **Stash-only.** `recall` owns ranked retrieval over memory; a stash is a dumb keyed blob, so `peek`
  carries no weights and no ranking. `peek` on a memory id or a file path returns `null`.
- Library API only, same rationale as `stash`.

### `ctx.evict(idOrPolicy)` → `number`
The **cleanup-half of `stash`** (R-C4 / R-G7) — the runtime's stash deleter. Returns the count removed.

- **`evict(id)`** drops one parked payload; **`evict({ olderThan })`** drops anything parked before an
  epoch-ms floor; **`evict({ maxCount })`** keeps only the newest N by parked-at and drops the rest. Pass
  both `olderThan` and `maxCount` to apply them in turn (age first, then count). An empty policy throws.
- **Stash-only, by construction.** Unlike `forget` (which invalidates durable memory), `evict` touches
  **only** the `stash` table — a bulk age/size sweep can **never** reach a `fact`/`episode`. That safety
  is why the two are separate verbs (not one overloaded `forget`).
- **The runtime owns the policy; litectx owns the delete.** *Which* stashes are stale and *when* to sweep
  is the orchestration loop's call (e.g. bareagent); `evict` is the mechanism it calls.
- Library API only, same rationale as `stash` (orchestration plumbing, never a model-facing verb).

### `ctx.reviewCandidates(threshold = 5)` → `{ path, hits }[]`
The **human-in-the-loop promotion query** (review earned by use): agent-asserted facts
whose recall-hit count has crossed `threshold`, most-recalled first. The intended loop is
**yours, not litectx's**: show each candidate to a human, who either **validates** it —
`remember(id, text, { by: "human" })`, flipping provenance to durable/high-trust — or
**invalidates** it — `forget(id)`. Acting on a candidate removes it from the set (no
"reviewed" flag exists or is needed). The hit count gates *review*, never *ranking* —
frequently-recalled facts do not rank higher (that would be a feedback loop; ranking
weight is the 🚧 access-log tier, validated separately).

### `ctx.promotionCandidates(threshold = 10)` → `{ path, hits }[]`
The **episode promotion query** — the agent-side first rung of the ladder (`reviewCandidates`
is the human-side second rung). Returns **agent-written `episode`s** recalled at least
`threshold` times within the **30-day rolling active window**, most-recalled first. Episodes are
the agent's *ephemeral scratchpad* (its own synthesized gotchas); they graduate by **use** into
durable facts. The intended loop is **yours**: read each candidate (`get(id)`), then write a
distilled `fact` — `remember(id, text, { kind: "fact", by: "agent" })` — which then rides the
`reviewCandidates(5)` → human-validate path above. **litectx flags, never summarizes** (no
extraction LLM): it gives the trigger; your agent writes the fact.

The count gates **distillation, never ranking** — a hot episode does not rank higher (the
feedback loop §4 forbids). Threshold defaults higher than facts' review (**10 vs 5**) because
episodes are noisier and more numerous. Two ephemerality rules keep the scratchpad bounded:
- **Soft-decay:** an episode older than 30 days drops out of this candidate set (the window gate).
- **Auto-prune:** each new episode `remember()` hard-deletes episodes past the 30-day window
  (cascading their text/embedding/recall-log) — self-bounding, no cron. Anything that mattered was
  already distilled into a fact, and **facts never prune**, so nothing earned is lost.

Unlike `reviewCandidates`, distilling does **not** remove the episode (there's no provenance to
flip) — it ages out of the window, or you `forget(id)` it after distilling. Re-distilling is
harmless: your fact `id` is a stable handle, so a second pass upserts the same fact.

### `ctx.recentActivity(opts?)` → `{ id, symbol, kind, lastEditedAt, edits }[]`
**"What was I working on"** — the code/doc chunks litectx most recently *witnessed* being
edited, newest first, within a recency window. `opts`: `days` (lookback, default 7),
`since` (epoch-ms window floor, overrides `days`), `limit` (default 20). Each row is a chunk:
`id` is its file path (feed it to `get`), `symbol` localizes within the file (`null` for a
file's anonymous chunks, which collapse to a single per-file row), `lastEditedAt` is the most
recent observed edit (epoch ms), and `edits` is how many index passes (sessions) changed it
in the window.

The edit stream is built **at index time**: each incremental `index()` diffs every new chunk
body against the stored `nodes` and logs the new/modified ones. A **cold first build or
`force` rebuild records nothing** (mass-loading isn't editing), so this stays empty until real
edits are observed — it reflects what litectx watched, not history before it was watching.

This is a **deliberately isolated read**: it never touches recall ranking. The witnessed-edit
signal's home is here (next-use / "where was I"), *not* in search scores — folding edit
activation into recall was POC-falsified as repo-dependent (it floats the same hot chunks for
every query), so the edit→recall re-rank ships at zero. `recentActivity` also writes nothing
to the recall audit log — it is not a demand signal.

### `ctx.size()` → `number`
Indexed document count (file-granularity).

### `ctx.close()` → `void`
Closes the SQLite connection. Call it when done (especially for file-backed DBs).

### `await compress(node, opts?)` → `Promise<string>`
The **rank-tiered render** primitive (R-C7) — a free function, not a `ctx` method (`import { compress } from "litectx"`).
Given a graph node and a `level`, return its text at one of three fidelities:
- `node`: `{ text, format?, symbol? }` — `text` is the symbol's source (a chunk body); `format`
  (`"js"|"ts"|"py"|…`) is needed for `signature`/`drop`; `symbol` improves the `drop` marker. To get
  `text` from a `recall` hit: take `hit.chunk.{startLine,endLine}` and slice `get(hit.path).text` to
  that 0-based inclusive range; `format` is `hit.format`. (`recall`/`nodesForPath` give the line range,
  not the text — slice the file body yourself.)
- `opts.level`: `"verbatim"` → the body unchanged · `"signature"` (default) → the declaration header
  **with its doc**, implementation body elided · `"drop"` → a `"name …"` marker.
- The **signature** tier is tree-sitter-extracted (cut at the def's `body` field), so it keeps
  `export`/`async`/decorators/generics/multiline params, prepends a JS/TS JSDoc, re-attaches a Python
  docstring, and wraps a bare **method** chunk so methods compress too. **~82% byte savings with the doc
  kept** on real code. Unparseable content (markdown, a preamble chunk, an unknown `format`) falls back
  **losslessly to verbatim**.
- A **pure view**: no DB, no ranking, no weights — it composes with `recall` (which ranks the nodes)
  but owns none of its logic. Library API only (a render mechanic the host loop runs, like `stash`/`peek`
  — not an MCP verb). `COMPRESS_LEVELS` exports the level vocabulary.

### `await assemble(units, ctx?)` → `Promise<{ units, dropped, tokens }>`
The **budget-fit** primitive (RT-1) — a free function (`import { assemble } from "litectx"`), the CE
read-path keystone. A host loop hands litectx a neutral **unit** array (its messages, grammar-stripped)
plus a token budget; litectx returns the fitted **view** for the next model call. litectx owns *content
+ relevance*, never the provider's transcript grammar — so `role` is opaque to it, and two flags carry
the contract:
- `unit`: `{ id, role, content, kind?, format?, symbol?, pinned?, atomic?, tokensApprox? }` — `pinned`
  units are never dropped or reordered (system prompt, current task); `atomic` units sharing a group id
  (a tool-call + its result) are kept-or-dropped **whole**, never split (broken grammar is unrepresentable,
  not caught). `tokensApprox` is the caller's estimate (falls back to `chars/4`). `format`/`symbol` on an
  injected `kind:"code"|"doc"` unit enable the COMPRESS tier (below).
- `ctx`: `{ budget?, task? }` — `budget` in tokens (omitted → keep all); `task` is reserved (the SELECT
  slice was POC-killed — see Scope) and unused by the fit.
- **Returns** `{ units, dropped, tokens }`: `units` is the kept view in **original order** (cache-stable —
  pinned in place, no reordering); a unit down-tiered by COMPRESS carries `compressed: true` and its
  `content` is the signature (full body recoverable by `id`, like a drop). `dropped` is `[{ id, reason }]`
  accounting for **every** elided unit (no silent loss — restorable by `id` from the host's canonical
  transcript); `tokens` is the view size (best-effort ≤ budget; pinned that alone exceed budget are still
  kept — never a hard cap).
- The fit is **recency-anchored** — the constraint the budget-fit POC pinned (`poc/assemble-fit-*.mjs`):
  re-reads are recency-bound, not topic-bound, so it keeps the newest un-pinned units and never reorders.
  Deterministic & cache-stable (no DB, no model, no clock); **async** because the COMPRESS tier awaits the
  tree-sitter render (a pure parse — still reproducible).
- **COMPRESS budget tier (shipped):** when the fit would **drop** a parseable `code`/`doc` unit, it is
  instead recovered as its `compress()` **signature** (header + doc, body elided) — rank/recency-driven
  (reuses the fit's order, *not* a positional rule), fires only when the signature both saves bytes and
  fits. Validated on real functions through this verb: signature retrieval **8/8** vs drop **0/8**, mean
  saving **81%** (`poc/assemble-compress-seam-poc.mjs`).
- **Scope:** ships **FIT + COMPRESS**. **SELECT** (recall-inject new graph context) is *not* here —
  auto-SELECT on in-window signal was POC-killed (`poc/assemble-select-poc.mjs`); fetch your own code with
  `recall`/`get`/`impact` and pass injected `code`/`doc` units in explicitly (COMPRESS then tiers them).
  Library API only (a host-loop mechanic, like `compress` — not an MCP verb).

### `await summaryWindow(units, ctx?)` → `Promise<{ units, dropped, tokens }>`
The **rolling-summary** read-path verb (R-C6) — a free function (`import { summaryWindow } from "litectx"`)
that composes `assemble`. Under budget pressure it keeps the **last-N** transcript turns verbatim and rolls
everything **older** into one rolling summary, then budget-fits via `assemble`. litectx owns the *policy*;
the **host owns the model** — litectx never calls one.
- `ctx`: the same as `assemble` plus — `summarize` (**required to engage**): a host-supplied
  `(messages: {role,content}[]) => Promise<string>`; `summaryKeep` = N recent turns kept verbatim (default
  8); `summaryRole` = role for the summary unit (default `"system"`; role is the consumer's grammar, so the
  host names it); `summaryId` = its id (default derived from the folded range).
- **Engages only under budget pressure.** No `summarize`, or everything already fits the budget, or fewer
  than 2 older turns to fold → it is a plain `assemble` (no model call, no summary). So it is **never worse
  than FIT**.
- **The summary unit** carries `summary: true` and `summarizes: [ids]` (the turns it folded) and is placed
  as the **freshest** content — a cache-stable dynamic suffix, so the verbatim prefix stays byte-identical
  for prefix caching. Each folded turn is reported in `dropped` with **`reason: "summarized"`** (restorable
  by `id`, like a drop). If even the summary can't fit, it is dropped like any unit (**never an overflow**),
  and its folded turns degrade to `reason: "budget"`.
- Excludes `pinned`/`atomic`/`code`/`doc` from folding (pinned never elides; tool-call pairs never become
  prose; code/doc are the COMPRESS tier's job inside `assemble`). Library API only.
- Validated end-to-end with a live model (`poc/rc6-summarywindow-poc.mjs`): at equal budget, summaryWindow
  retained the dropped-turn answers FIT-drop lost (**3/3 vs 0/3**). Integration with bareagent's real
  `summarize()` seam is pending its §23 build; the verb works today with any host-supplied summarizer.

### `await trim(units, policy?)` → `Promise<{ units, dropped, harvest }>`
The **transcript-truncation** verb (R-C5) — a free function (`import { trim } from "litectx"`). Where
`assemble` produces a non-destructive per-step **view** (your canonical transcript is preserved), `trim`'s
intent is **eviction**: drop old turns by a recency heuristic and hand back exactly what was dropped so you
can **harvest-before-evict** (persist, then discard). A **thin verb** — it never reimplements the fit math.
- `policy`: **`maxTokens`** (SIZE) — delegates wholesale to `assemble`'s recency-anchored fit (incl. the
  COMPRESS rescue tier); or **`keepLastN`** (COUNT) — keep the N most-recent un-pinned **items** (an
  `atomic` group counts as one item). `maxTokens` wins if both are given; neither set → no-op (keep all).
- Both policies preserve the invariants: **`pinned` never drops**, **`atomic` groups are kept/dropped
  whole** (an atomic group with any pinned member is force-kept).
- **The eviction contract:** `harvest` is the array of dropped units **with content intact** (same ids as
  `dropped`) — the worklist to persist *before* you remove those turns from your canonical transcript. A
  unit `assemble` down-tiered to a COMPRESS signature stays in `units` (still present) → never harvested.
- COUNT is genuinely distinct from a budget: no `maxTokens` reproduces "keep the last N turns" once turn
  sizes vary (`poc/rc5-trim-poc.mjs`, C2a). Library API only.
- Typical interlock: `const { units, harvest } = await trim(msgs, { keepLastN: 12 }); for (const u of
  harvest) await lc.remember(u.id, u.content, { kind: "episode" }); /* then drop the dropped ids */`.

### `liteCtxAsStore(lc, opts?)` → a host `Store`
Mount an indexed `LiteCtx` as a host's swappable memory backend — the four-method `Store` shape
(`{ store, search, get, delete }`) a runtime like bareagent's `Memory` expects — so a substring-scan
`JsonFileStore` can be swapped for litectx in **one line**, host code unchanged, gaining ranked,
graph-aware recall. A free function (`import { liteCtxAsStore } from "litectx"`); it **copies** the
host's shape, no import of the host.

```js
const memory = new Memory({ store: liteCtxAsStore(lc) });   // lc: a LiteCtx (its own dbPath = isolation)
const id = await memory.store("Auth uses JWT", { tag: "auth" });  // → minted id; ranked, not substring
const hits = await memory.search("how does auth work");           // [{ id, content, metadata, score }]
```

- **`store(content, metadata?)` → `Promise<id>`** — mints a namespaced id (`"<kind>:<uuid>"`) and
  `remember`s. `metadata.kind` (default `"fact"`) and `metadata.by` drive the write; **every other key
  rides the sealed `meta` passthrough** and round-trips verbatim. The adapter is the store, so *it* owns
  the id — the host never supplies one.
  - **Adapter writes are gated + audited.** Because `store()` calls `lc.remember()`, any `writeGate` /
    `writeAudit` wired on `lc` applies to writes made through the adapter too — the consumer (e.g.
    bareagent's `Memory`) stays transparent; you wire the gate/sink **once on `lc`**, not per consumer.
- **`search(query, options?)` → `Promise<[{ id, content, metadata, score }]>`** — ranked recall with
  `{ body: true }` (content inlined). Targets **one kind** (`options.kind`, default `"fact"`) so scores
  stay comparable; `options.limit` caps results. `metadata` comes back whole (kind/by reassembled +
  the passthrough).
- **`get(id)` → `{ id, content, metadata } | null`** · **`delete(id)`** → `forget(id)`.
- `opts.kind` sets the default write/search kind. `store`/`search` are **async** (litectx embeds /
  ranks); `get`/`delete` are sync. Give each sub-agent its **own `dbPath`** for isolation — separate
  files, zero shared state.

### Named exports (advanced / extension)
- `compress(node, { level })` / `COMPRESS_LEVELS` — the R-C7 render primitive above.
- `assemble(units, { budget, task })` — RT-1 budget-fit a neutral transcript to a token budget (the section above).
- `summaryWindow(units, { budget, summarize, summaryKeep, summaryRole, summaryId })` — R-C6 rolling-summary read-path over `assemble` (the section above).
- `trim(units, { maxTokens, keepLastN })` — R-C5 transcript-truncation: evict old turns + return the `harvest` worklist (the section above).
- `liteCtxAsStore(lc, { kind })` — mount litectx as a host `Store` (the section just above).
- `toWriteAction(id, text, { kind, provenance, meta, injectionRisk })` → the pure write-gate emitter
  (the `{ type: "memory.write", … }` action shape); `WriteAudit` → standalone JSONL audit sink (ships no
  secret patterns; takes a host `redact`); `WriteDeniedError` → thrown when a wired `writeGate` denies a
  write (carries `.id` + `.decision`). See the `writeGate` config + `remember` write-gate note above (§10.1).
- `observe(ctx)` → wrap a `LiteCtx` so every CE verb call is recorded into `ctx.trace` (the **contextgraph**
  pipeline view); `ctx.tap(verb, fn)` folds in free-function verbs; or just set `trace: true` on the config.
  `ContextGraph` → the recorder (`.json()` + agent-readable `.mermaid()`); `PRIMITIVES`/`VERBS_BY_PRIMITIVE`/
  `PRIMITIVE` → the Write/Select/Compress/Isolate verb taxonomy. Renders + full setup: `docs/03-usage/graphs.md`.
- `KINDS: string[]` — the canonical memory-kind vocabulary a bare `recall(query)` groups
  over: `["code", "doc", "fact", "episode"]`. `code`/`doc` enter via `index()` (files,
  routed by extension); `fact`/`episode`/`doc` via `remember()` (direct writes).
- `Store` — the SQLite/FTS5 store class (used internally by `LiteCtx`; exposed for
  tooling and tests). Notable read methods: `count()`, `nodeCount()`,
  `nodesForPath(path)` → `{ symbol, node_type, start_line, end_line }[]`.
- `splitIdent(s)` / `keywords(query)` / `ftsMatch(query)` — the code-aware
  tokenizer primitives (identifier splitting, keyword extraction, FTS5 MATCH
  building). Useful if you build queries by hand.

> `ctx.store` is reachable but is **not a stability promise** pre-1.0 — the
> `nodes` schema is the substrate for in-progress slices and may change. Treat
> `index` / `recall` / `size` / `close` as the stable surface.

## Consumption surfaces — CLI & MCP (slice 10)

The library is the core; two **thin adapters** ship in the same package, both wrapping the
public API above exactly as an external consumer would (nothing in the library knows they
exist — importing `litectx` as a lib loads zero surface code). Use whichever fits the caller;
mixing them over one `.litectx/index.db` is fine.

### `litectx` (CLI)

```
# embeddings (semantic recall) are ON by default; pass --no-embeddings for the BM25-only base
litectx index [root] [--force] [--no-embeddings]
litectx recall <query...> [--kind code|doc|fact|episode] [-n <n>] [--no-embeddings] [--no-log]
litectx get <id> [--no-log]                    # metadata → stderr, body → stdout (pipes clean)
litectx recent [--since <days>] [-n <n>]       # "what was I working on" — recent chunk-edits
litectx promotions [--threshold <n>]           # hot agent episodes to distil into facts (default 10)
litectx impact <symbol>
litectx remember <id> [text...] [--kind fact|episode|doc] [--by human|agent] [--no-embeddings]
litectx forget <id>            # or bulk: litectx forget --kind <k> / --by <b>
litectx help | --help | -h     # usage + the output-column legend (exit 0); also shown bare
```
All commands take `--root <dir>` (default: cwd). `remember` reads its body from the arguments
or, when absent, from piped stdin (`git log -1 --format=%s | litectx remember ep:release
--kind episode`). Exit 1: unknown id (`get`), nothing matched (`forget`), unknown symbol
(`impact`), and any bad invocation (prints usage to stderr); `help`/`--help`/`-h`/no command
print usage to stdout and exit 0. `--no-log` is the demand-signal opt-out (see Gotchas) — use
it for dashboards, CI, and batch scripts.

Output is **tab-separated** (composable with `awk`/`cut`; `help` prints this legend):
`recall` → `score  kind/format  path  → chunk-symbol:start-end  git:Ncommits/age(m|h|d)` (memory
hits append `provenance use:N`); `recent` → `age(m|h|d)  edits×  kind  path  › symbol`.

### `litectx-mcp` (MCP server)

A hand-rolled **stdio** MCP server — newline-delimited JSON-RPC 2.0, spawned and owned by the
MCP client, **not a daemon** (exits when the client hangs up; the no-service rule holds). Zero
dependencies beyond litectx itself. Client config:

```json
{ "mcpServers": { "litectx": { "command": "litectx-mcp", "args": ["--root", "/path/to/repo"] } } }
```

The spawned instance runs the **semantic tier ON by default**; pass `--no-embeddings` for BM25-only. The tools are the public
operations: `index`, `recall`, `impact`, `get`, `recent`, `promotions`, `remember`, `forget` — recall
returns scored *pointers*, `get` fetches a body, `recent` lists witnessed chunk-edits, `promotions`
lists hot episodes to distil, same contract as the lib. Tool failures come back
in-band (`isError` results an agent can read and self-correct); protocol errors are reserved
for malformed JSON-RPC. **No `log: false` is exposed over MCP** — an MCP client is a live
agent, which is precisely the demand the audit log exists to capture; non-demand consumers
belong on the lib or the CLI's `--no-log`.

**The surfaces expose the core options, not every lib option — deliberately.** Lib-only
(use `import { LiteCtx }` if you need them): pathspec-scoped indexing (`index({ paths })`),
multi-kind recall arrays (`kind: ["code", "doc"]`), `remember`'s `format` override and
`occurredAt` backdating (a surface writes an episode as happening *now* — backdating is an
ingestion concern), and the embeddings fusion knobs (`embedWeight`, `embedModel`,
`embedder`). Both surfaces stay thin adapters; anything beyond their flags/arguments is the
library's job, not a surface re-export.

## The `nodes` substrate (slice 2)

Indexing now also splits each file into **symbol/section chunks** with line
ranges, stored in a `nodes` table:

- **Code** (TS, JS, Python) → one chunk per function / method / class, plus a
  "preamble" chunk for top-level lines (imports, module constants/docstring).
  Parsing uses **tree-sitter** (vendored WebAssembly grammars). Over-counting
  (e.g. nested arrows) is acceptable by design — the eventual output is a risk
  *bucket*, not a precise reference list.
- **Markdown** → one chunk per heading section.
- **Anything else / parse failure** → a single file-level chunk (never throws).

These chunks are **additive**: recall still gates on the file-level FTS index, so
adding them does not change ranking yet. They exist to feed block-level git
signals, graph edges, and the impact view in later slices.

## Architecture

One SQLite file holds two FTS5 tables — `docs` (code + all docs, keyword-exact;
indexed files and direct-written docs share it, discriminated by a `source`
column) and `mem` (facts + episodes, porter-stemmed) — plus a `file_index` table
for incremental change detection, a `nodes` table for the symbol substrate,
`edges` (imports → spreading; impact), `git_sig` (activity metadata),
`file_embeddings` (the opt-in tier), `recall_log` (the slice-7 audit/access
log), and two **non-FTS sidecars** for written memory — `mem_text` (verbatim
text) and `mem_meta` (the sealed opaque-metadata passthrough, RT-3): both live
outside every FTS table by design, so they're returned but never searched. A `kind` routes to exactly one FTS table, and kinds never share a ranking,
so BM25 scores never merge across the two. Indexing is **routed by file
extension** (never by content) and
prefers `git ls-files` (tracked files, respects `.gitignore`), falling back to a
filesystem walk that skips the usual noise directories. The whole thing runs
synchronously against the file except parsing, which uses an async WASM runtime.

## What's NOT in litectx, and why

- **No LSP / language server — ever.** Edge resolution is `ripgrep -w` + tree-sitter
  queries only; accuracy comes from per-language config. litectx is near-perfect at
  *detecting* call/import syntax and deliberately *imprecise at resolving bindings* —
  it **over-counts by design** (PRD §7). **Where the imprecision is risk-free vs. where
  the safety contract bites:** in **recall** (shipped — import-spreading), an edge only
  nudges a rank, so over- *or* under-counting is harmless; recall makes no isolation
  claim and carries none of the risk. The contract applies to the **impact** view
  (roadmap), where "isolated → safe to change" *is* load-bearing: **over-counting
  connectivity is safe (errs cautious); under-counting is dangerous** (a false
  "isolated" breaks hidden consumers). So when impact lands, a high/connected result is
  a normal claim, but **"isolated / unused / low-risk" is only ever a hedged review
  candidate, never a guarantee** — and dead-code is "likely-unused, review," never
  "safe to delete." Precise import-vs-usage binding is a non-goal. Closed decision.
- **No embeddings by default.** The semantic tier ships (slice 6) but is the single
  **opt-in**, off by default: dual-hybrid (BM25 + spreading) ≈ 85% vs tri-hybrid ≈ 95%,
  and embeddings add cold-start model-load latency + an ML dependency not worth
  defaulting on. Turn it on with `embeddings: true` + `npm i @huggingface/transformers`.
- **No service / daemon / network / telemetry.** It runs in your process against a
  file on disk.
- **No alternative store.** SQLite + FTS5, single file. BM25 is native in SQL;
  vectors (embeddings tier) would live in the same file. Closed question.
- **No token-budget / guardrail / prompt-assembly concerns.** That is the
  caller's (harness) layer. litectx returns ranked results; what you do with them
  is policy.
- **No extraction LLM, no trust funnel, no consolidation.** `remember()` stores what you
  hand it — litectx never runs a model to distill docs into facts, decide what's worth
  remembering, merge near-duplicates, or run the human-review loop. It supplies the
  *mechanism* (write, recall, the `reviewCandidates` trigger, promote/forget actions);
  *what* becomes a fact and *which* facts get promoted is consumer policy. litectx is the
  low-write-bar retrieval store (write freely; only relevant items surface) — curating a
  high-bar "hot" always-injected memory on top of it is your layer.
- **No content sniffing.** Language is decided by extension only.

## Gotchas

- **`index()` and `recall()` are async; `size()`/`close()` are sync.** `await` index and
  recall; don't `await` size/close.
- **Recall is BM25 + spreading** (kind-scoped), plus **semantic cosine** when the embeddings
  tier is on. **recency** effects (base-level activation) remain the access-log tier and
  won't appear from git history alone — the POC showed git-seeded recency is repo-dependent,
  so git ships as grounding metadata, not ranking weight.
- **Same-mtime + same-size content swap.** Change detection fast-skips on
  `(mtime, size)`; an edit that lands within one filesystem mtime tick *and* keeps
  the exact byte length can be missed. Use `index({ force: true })` to be certain.
- **Scoped passes don't delete.** `index({ paths })` never removes files outside
  the given pathspecs — by design. A full `index()` reconciles deletions.
- **`git ls-files` is preferred.** In a git repo, only tracked files are indexed
  (untracked files need `git add` or a non-git fallback). Outside a git repo, a
  filesystem walk is used instead.
- **`.tsx` / `.jsx` are best-effort.** v1 grammars are TS, JS, Python; JSX-heavy
  files may fall back to a file-level chunk. They are not in the default `include`.
- **`recall()` and `get()` write — unless you opt out.** Since slice 7, every recall appends
  its hits to the `recall_log` audit table, and since slice 9 every `get` appends a fetch row
  (tagged `action: 'fetch'`, kept apart from recall's demand signal) — so by default both need
  a writable db, and the log grows with use (append-only; small rows, but unbounded — pruning
  policy is yours until the access-log tier defines one). Pass `{ log: false }` for read-only
  opens and for any consumer whose queries aren't real demand (dashboards, CI, batch tooling)
  — the log is a demand signal, and non-demand traffic pollutes it.
- **`get()` on a file reads disk, not the index.** The store keeps a processed *searchable
  surface*, not a copy of your files — so `get("src/auth.js").text` is the file as it is
  *now*, even if it changed since the last `index()` (and `null` if it was deleted; the
  next `index()` sweeps the row). Written memory (`fact`/`episode`/direct `doc`) is the
  exception: it has no file behind it, so its raw text is stored and returned verbatim.
- **Facts/episodes recall across word forms; docs and code stay keyword-exact — deliberately.**
  `fact`/`episode` recall is porter-stemmed: *"refund policy"* finds a fact stored as
  *"refunds are honored…"* (inflection — plurals, -ed/-ing — is covered; derivational shifts
  like "deployment"→"deploys" and compounds like "rollback"→"rolled back" are not). `doc` and
  `code` are **not** stemmed: in code, word-forms are distinct symbols (`token`/`tokens`/
  `tokenize`), and stemming measurably hurt code ranking — so an FAQ written via `remember`
  still needs exact words (or key terms repeated in its `id`, which is indexed). Pure
  paraphrase ("money back" → "refunds") matches nothing lexically for any kind. **With the
  embeddings tier on, `fact`/`episode` close that hole (slice 11 — KNN union):** cosine
  *nominates* up to 8 stored vectors nearest the query into the pool, so "money back" reaches
  the refunds fact with zero shared words (bench: para MRR 0.000 → 0.574, top-3 83%, with exact
  and morph held). Two honest limits: it needs the tier **on at write time** (a fact written with
  the tier off has no vector and never nominates — re-`remember` it to embed it), and an
  off-topic query may still surface weakly-similar facts ranked low (only zero/negative
  similarity is never nominated). `doc`/`code` remain strictly BM25-gated — there the tier only
  re-ranks the lexical pool, so with the tier **off** (the default), *write facts in the words
  you'll query* is still the rule.
- **`forget` only forgets written memory.** It cannot remove an indexed file (delete the
  file + re-`index()` for that), and `remember` cannot overwrite an indexed file's row —
  the two populations share the store but are write-isolated by design.
- **The embeddings tier loads a remote model file (optional dep only).** Turning it on pulls
  `@huggingface/transformers`, which fetches the default `Xenova/all-MiniLM-L6-v2` model once from
  the HuggingFace Hub on first use and parses an ONNX **model file** — so only load models from a
  source you trust. (The optional dep's transitive chain is `npm audit`-clean as of the
  `@huggingface/transformers` v4 migration; the older `@xenova/transformers` chain carried
  `protobufjs` advisories.) The deterministic BM25 core — the library default — pulls none of this
  and runs fully offline.
- **Upgrading over an old index db is safe — the store self-heals on open.** A db created
  by ≤ 0.1.0 (its `docs` table predates the write-path columns) is detected and rebuilt on
  the next open — it can only contain re-indexable files, never written memory, so nothing
  is lost; run `index()` once to repopulate. Newer column-additive deltas are applied with
  `ALTER`, preserving data. You never need to delete `.litectx/` by hand.
- **`close()` matters for file DBs.** The store uses WAL; close to flush cleanly.
- **`impact()` requires `ripgrep` (`rg`) on `PATH`.** The caller sweep shells out to
  `rg -w`; it is **not** bundled. If `rg` is missing the sweep returns nothing and
  `impact()` reports **0 callers** — i.e. a symbol can read as isolated purely because
  the tool is absent (a §7.2 false-isolation, the one dangerous error). Install
  ripgrep on any host (CI, container, dev box) that calls `impact()`. `recall()` and
  `index()` do **not** need it.

## Constraints

- **Runtime:** Node **≥ 18**, ESM only (`"type": "module"`). **`ripgrep` (`rg`) on
  `PATH`** is required for `impact()` (not for `recall`/`index`) — see Gotchas.
- **Dependencies (shipped):** `better-sqlite3` (native SQLite) and
  `web-tree-sitter` (WASM parser runtime, pinned). The 3 grammars (Python, JS, TS)
  are **vendored** in the package (~3.4 MB unpacked) — no extra grammar download.
- **Indexed languages (v1):** TS, JS, Python (code) + Markdown (docs). Adding a
  language is tree-sitter queries + edge config, not a core change.
- **One index = one SQLite file.** Rebuildable from source at any time.
