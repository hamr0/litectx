# Changelog

All notable changes to this project are documented here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`summaryWindow(units, ctx)` — the R-C6 rolling-summary read-path verb.** Under budget pressure it keeps
  the last-N transcript turns **verbatim** and rolls everything **older** into one rolling summary, then
  budget-fits the result via `assemble`. litectx owns the policy (trigger — engaged only when the transcript
  exceeds budget; N — `ctx.summaryKeep`, default 8; the splice); the **host owns the model** (`ctx.summarize`,
  a provider-bound `(messages) => Promise<string>` — litectx never calls a model itself). The summary is a
  synthetic unit placed as the freshest content (a cache-stable dynamic suffix; the verbatim prefix stays
  byte-identical for prefix caching) and is **restorable** — folded turns are reported in `dropped` with
  reason `"summarized"` and listed on the summary unit's `summarizes`, recoverable by id. Never overflows
  (the summary fits via `assemble`, or is dropped like any unit) and **never worse than FIT** (falls back to
  a plain `assemble` when unwired, when everything already fits, or when there are < 2 older turns to fold).
  POC-gated (`poc/rc6-summarywindow-poc.mjs`): at equal budget, summaryWindow retained the dropped-turn
  answers FIT-drop lost (discriminator 3/3 vs 0/3 on a live model). Integration with bareagent's real
  `summarize()` seam is pending its §23 build; this verb stands alone with any host-supplied summarizer.

## [0.13.0] — 2026-06-14

### Added
- **Write-gate emitter (CE-PRD §10.1).** `remember()` gains an opt-in `writeGate` hook: when a
  `LiteCtxConfig.writeGate` (any object with a `.check(action)`) is wired, a write is first emitted as a
  gate-able action `{ type: "memory.write", kind, provenance, text, id, meta?, injectionRisk? }` and
  checked **before it commits** — a `deny` outcome throws `WriteDeniedError` and the write does **not**
  persist; `allow`/`ask` proceed. litectx states the **source** (`provenance`) plus an optional
  guardrails-set `injectionRisk` shape flag, and never makes the content judgment (the §6 line —
  bareguard, or any gate, renders deny/ask). New exports: `toWriteAction` (the pure emitter),
  `WriteAudit` (a standalone JSONL audit sink that ships **no** secret patterns — a host-supplied
  `redact` scrubs), and `WriteDeniedError`. Default unset = no gate, **byte-identical** to prior writes.
  Grounded end-to-end on the **real bareguard `Gate`** (`poc/write-gate-emitter-poc.mjs`, 13/13): the
  emitted shape is load-bearing (strip `provenance`/`injectionRisk` → the decision flips back to allow)
  and floor supremacy holds (`injectionRisk:"high"` denies **through** an allowlist). Demand-gated — no
  consumer emits gate actions yet; `memory.inject` is reserved in the type but has no producer.
- **`assemble()` COMPRESS budget tier (Build B).** When the budget-fit would drop a parseable code/doc
  unit, it is now recovered as its `compress()` **signature** (header + doc, body elided) before being
  evicted — marked `compressed: true` on the kept unit, full body still recoverable by id like a drop.
  The tier is **rank/recency-driven** (reuses FIT's existing order; *not* a positional middle rule —
  lost-in-the-middle was refuted at realistic scale) and fires only when the signature both **saves**
  bytes and **fits** the remaining budget. Grounded in two POCs: `poc/compress-middle-poc.mjs` (the
  rendering decision — signature 6/6 vs drop 0/6 for structural content, 0 hallucination) and
  **`poc/assemble-compress-seam-poc.mjs` — the integration, on REAL functions through the SHIPPED verb
  with a live model**: seam mechanic 8/8, **PARAMS retrieval signature 8/8 vs drop 0/8** (the signature
  preserves the API that eviction loses, even for doc-less bare-header functions), mean real byte saving
  **81%** (51–97%).
- SELECT (recall-inject) is **deliberately not** part of `assemble()` — auto-SELECT on in-window signal
  was POC-killed (`assemble-select-poc.mjs`); the path-fetch case is served by `get`/`impact` and the
  never-read mode needs its own POC. `ctx.task` stays reserved.

### Changed
- **`assemble()` is now `async`** (returns `Promise<AssembleResult>`). The only await is `compress()`,
  a pure tree-sitter render — the verb stays deterministic and cache-stable. **Signature change, but
  compatible with the one live consumer:** bareagent's adapter already `await`s the assembler
  (`bareagent/src/context-units.js:217`, typed `(units, ctx) => any | Promise<any>`), so awaiting a now-
  async return is transparent. Consumers pinning `litectx ^0.11.0` (bareagent does) need a minor-version
  bump to receive COMPRESS — additive, no code change. The FIT path is byte-identical post-change
  (verified 19% @25% / 3.8% @50% on 1059 real deps, `poc/assemble-verify-shipped.mjs`).
- **Docs consolidation (repo-only — no package, API, or behavior change).** The `docs/` set was merged
  into fewer canonical homes, with every inbound reference repointed and **zero dangling links** (incl.
  the cross-repo bareagent PRD citation):
  - `02-engineering/` (5 → 2): `bare-suite-buildable-now.md` + `litectx-for-baresuite.md` →
    **`baresuite-litectx-prd.md`** (the litectx↔baresuite integration contract; §4.1/§4.4 anchors kept
    for cross-repo citations); `aurora-borrow-ledger.md` + `copy-pattern-studies.md` +
    `ce-eval-harness-scenario.md` → **`build-studies.md`** (Parts A–C, internal section numbers kept).
  - `00-context/`: `ce-flow.md` + `ctx-ifra.md` → `build-studies.md` (Parts D–E); `ce-tree.md` →
    **`litectx-ce-prd.md` Appendix CE-T** (headers namespaced `CE-T.*` so `§N` citations still resolve).
    `00-context/README.md` rewritten as the CE doc-set index/map.
  - `barecontext-prd.md` (superseded SEED) → `docs/archive/`.

## [0.12.0] — 2026-06-13

The Isolate scope model — written memory scopes to its actor (`owner`) and run (`session`), so a
long-running / multi-agent host can keep contexts from bleeding.

### Added
- **`owner` / `session` scope keys — the Isolate scope model (§4.4; gate #1 cleared on real data).**
  Two optional `LiteCtxConfig` keys that scope written memory so a long-running / multi-agent host can
  keep contexts from bleeding. `owner` = the actor that owns durable `fact`s; `session` = the run that
  owns volatile `episode`s. **Kind-aware at write:** a `fact` is owner-scoped (durable, cross-session),
  an `episode` is owner + session (volatile, own-run); `code`/`doc` are never scoped (they are the
  per-worktree file index, not shared memory). **`recall` filters both ranking paths** (BM25 *and* the
  embeddings/KNN nominator): `(:me IS NULL OR owner IS NULL OR owner = :me) AND (:sid IS NULL OR session
  IS NULL OR session = :sid)` — an **unset** reader sees everything (single-tenant default, byte-
  identical to pre-scope behavior), a **set** reader sees its own + global (`NULL`) memory only. Stored
  in a new non-FTS sibling table `mem_scope` (mirrors `mem_meta`: a `CREATE TABLE IF NOT EXISTS`, no
  backfill — old DBs read as fully unscoped/visible; the `mem` FTS5 table takes no new columns).
  `forget` and the episode-prune drop the scope row, so a reused id never inherits a ghost scope.
  **Load-bearing, not bloat:** gate #1 (`poc/scope-session-poc.mjs`, 12 real Claude Code session
  transcripts) showed a run's own episodes get **buried by more-relevant older sessions** — rank-1
  stolen 5/6 (BM25) / 9/10 (embeddings) — because recency is not a ranking term; only an explicit
  `session` filter recovers them (`poc/RESULTS.md` §4.5 gate #1). Identity is the host's to resolve and
  thread (git email / OS user / run id); litectx stores + filters, never sniffs. (Tests
  `test/scope.test.js`, 6.)

## [0.11.0] — 2026-06-13

The assemble read-path keystone — litectx now budget-fits a neutral transcript for the next model call.

### Added
- **`assemble(units, ctx) → { units, dropped, tokens }` — the RT-1 budget-fit verb (CE read-path
  keystone).** A pure free function: a host loop hands litectx a neutral **unit** array (its messages,
  grammar-stripped — `{ id, role, content, kind?, pinned?, atomic?, tokensApprox? }`) plus a token
  `budget`, and gets back the fitted **view** for the next model call. litectx owns content + relevance,
  never the provider's grammar — two flags carry the contract: **`pinned`** units never drop or reorder
  (system prompt, current task; budget is the un-pinned room), and **`atomic`** units (a tool-call + its
  result) are kept-or-dropped **whole**, so broken grammar is unrepresentable, not caught. The fit is
  **recency-anchored** — the one constraint the budget-fit POC pinned (re-reads are recency-bound, not
  topic-bound; semantic re-rank of the transcript does not help) — so it keeps the newest un-pinned units
  and never reorders (**cache-stable**, deterministic). `dropped[]` accounts for every elided unit (no
  silent loss; restorable by `id` from the host's canonical transcript). Best-effort, never a hard cap.
  **v1 ships FIT only**; SELECT (recall-inject) + COMPRESS (signature-tier) are the next slice (COMPRESS
  needs a `format` only recall-injected units carry). POC evidence: `poc/assemble-fit-poc.mjs` (structural)
  + `poc/assemble-verify-shipped.mjs` (the **shipped** verb: 3.8% silent-loss @50% over 1059 real deps —
  budget-honest; the POC's inline 1.8% was an atomic-overflow artifact, corrected) + `poc/assemble-fit-model-poc.mjs`
  (live model, 8/8 present vs 0/8 absent), `poc/RESULTS.md`. (Tests `test/assemble.test.js`, 12.)

## [0.10.0] — 2026-06-12

The memory socket — litectx now drops in as a host's swappable memory backend (RT-3), with content and
opaque metadata that travel with a hit.

### Added
- **`recall(query, { body: true })` — inline-body flag.** Off by default (recall returns ranked
  *pointers*, not payloads); opt in to get each hit's content as `hit.body` and skip the follow-up
  `get()`s. litectx owns the routing because *where the body lives is kind-dependent*: written memory
  comes back **verbatim**; a file hit returns its **localized chunk** (the indexed text that ranked —
  drift-free, served from the index, survives the file leaving disk) via the new internal
  `store.chunkBodyAt`; when nothing localized, the whole file is read fresh from disk; `null` when the
  file is gone or the id is unknown. Body-fill is part of `recall`, not a `get`, so it never logs a
  fetch / pollutes the demand signal. Pure read-path — no migration. (Tests `test/recall-body.test.js`.)
- **`remember(id, text, { meta })` — sealed opaque-metadata passthrough.** An arbitrary caller dict
  (`{ sessionId, tag, … }`) stored verbatim and returned untouched by `get`/`recall` (as `.meta`),
  so litectx can stand in as a generic key-value memory store. Stored in a **new non-FTS sibling table
  `mem_meta`**, so it is **sealed by construction** — in no FTS table, hence never tokenized, searched,
  or scored (a term living only in `meta` can't make the memory recallable). The first memory-tier
  migration, and the most additive kind: a `CREATE TABLE IF NOT EXISTS` (old DBs gain an empty table,
  no backfill). Re-`remember`ing without `meta` clears any prior; `forget`/episode-prune drop it.
  Guidance: small structured tags, not payloads — park large blobs in `stash`. (Tests
  `test/recall-meta.test.js`, including the seal and the embeddings-tier ranking path.)
- **`liteCtxAsStore(lc)` — mount litectx as a host `Store`.** A free function adapting a `LiteCtx` to
  the four-method `{ store, search, get, delete }` shape a runtime (e.g. bareagent's `Memory`) mounts,
  projecting to `[{ id, content, metadata, score }]` — so swapping a substring-scan backend for litectx
  is a one-line change, host code unchanged, gaining ranked graph-aware recall. Copies the host shape
  (no host import). The adapter mints a namespaced id, searches **one kind** for comparable scores
  (default `fact`), inlines content via the body flag, and round-trips the full metadata dict through
  the sealed passthrough. Give each sub-agent its own `dbPath` for isolation. (Tests
  `test/memory-store.test.js`.)

### Fixed
- **A raw NUL byte in `src/store.js`** (the `chunkKey` separator was authored as a literal `\0` instead
  of the escape) made the entire file read as **binary** — `grep`/`ripgrep` silently skipped it and
  `git diff` reported "Binary files differ". Shipped that way since 0.8.0. Replaced with the two-char
  `\0` escape (runtime-identical); guarded by `test/source-hygiene.test.js` (scans `src/*.js` for raw
  NUL).

## [0.9.0] — 2026-06-12

The graph becomes directly addressable — recall and impact were always *views*; now the substrate has accessors.

### Added
- **`getNode(id)` + `related(id, opts)` — the graph-substrate accessors (R-G1 / R-G2).** The graph is
  first-class public API; recall and impact are *views* over it, and now there's a direct accessor.
  `getNode` describes a node's *structure* (its `chunks`/symbols + **exact** import-edge counts) — the
  counterpart to `get`, which returns the body; kind-agnostic (written memory = a zero-chunk, zero-edge
  node). `related` walks the persisted `import` graph by `dir` (`out`/`in`/`both`) and `hops` (default
  1, capped at 3) — deduped, nearest-hop-wins, `via`-tagged. `edge` is a **generic type** so future
  non-code edges (`derived_from`/`supersedes`, for a contextgraph view) slot in with no migration.
  Tested seam invariant: `getNode.edges.imports === related(out,1).length`. **API-only** (§10.5).
  (POC `poc/graph-substrate-poc.mjs`; tests `test/graph.test.js`; example consumer
  `examples/graph-view/` — a zero-dep human code-map. Design:
  `docs/plans/2026-06-12-graph-substrate-design.md`.)

## [0.8.0] — 2026-06-12

The stash-cleanup verb, and a clean memory/scratch seam.

### Added
- **`evict(id | { olderThan, maxCount })` — the stash-cleanup verb (R-C4 / R-G7).** The runtime's
  deleter for parked payloads: `evict(id)` drops one; `{ olderThan }` (epoch-ms floor) drops anything
  parked before it; `{ maxCount }` keeps only the newest N and drops the rest (both policies compose —
  age first, then count). **API-only** (§10.5, like `stash`/`peek`) and **stash-only by construction** —
  it touches only the `stash` table, so a bulk age/size sweep can never reach a durable `fact`/`episode`.
  The runtime owns the *policy* (which/when); litectx owns the *delete*. (POC `poc/evict-poc.mjs`; tests
  assert the *evict-never-touches-memory* and *forget-can't-reach-stash* invariants.)

### Changed (BREAKING)
- **`forget` is now memory-only.** Previously `forget(id)` would also delete a same-id `stash`; that
  fallthrough is removed — stash deletion moved to the dedicated `evict` verb above. This keeps the
  model-facing "drop knowledge" verb (`forget`) and the runtime-only "reclaim scratch" verb (`evict`) on
  opposite sides of the §10.5 surface line, and makes "a bulk sweep can never harm a durable fact"
  structural. **Migration:** replace any `forget(stashId)` with `evict(stashId)`. (Blast radius ~zero —
  `stash`/`evict` are library-only orchestration plumbing with no live consumer yet.)

## [0.7.0] — 2026-06-12

The context-primitive release. Adds the first two CE *render* verbs — `compress()` (R-C7 rank-tiered
render: verbatim / signature / drop) and `peek()` (R-I3 head+tail preview, the read-half of `stash()`) —
and settles the consumption-surface question for all three (library/orchestration verbs, not MCP). No new
dependencies; the deterministic BM25 core and every quality gate are unchanged.

### Added
- **`compress(node, { level })` — the R-C7 rank-tiered render primitive.** Given a graph node (a code
  chunk `{ text, format, symbol? }`) and a level, returns its text at one of three fidelities:
  `verbatim` (the full body), `signature` (the declaration header + its doc, implementation body
  elided), or `drop` (a `name …` marker). A caller — or a future `assemble()` — picks the level by
  rank: top-N verbatim, the next tier signature, the long tail dropped. A **pure render view** over the
  chunk text: no DB, no ranking, no weights (exported from the library, `import { compress }`; not an
  MCP verb — a render mechanic the host loop performs, like `stash`/`peek`). The signature tier extracts
  via **tree-sitter** (cut at the def's `body` field), which keeps `export`/`async`/decorators/generics/
  multiline params where a naive line-slice mangled them (99% vs 32% on 303 real defs); it preserves a
  JS/TS JSDoc above the header and re-attaches a Python docstring below it, and **wraps a bare method
  chunk in a synthetic class** so methods — ≈38% of real symbols, which don't parse standalone —
  compress too. **Measured on 627 real symbols (litectx JS + OpenSpec TS + aurora PY): signature saves
  ~82% of bytes with the doc kept, 0 unparseable.** Unparseable content (markdown, a preamble chunk)
  falls back losslessly to verbatim. 16 tests; design validated in `poc/rc7-compress-sig-poc.mjs`.
- **`peek(id)` — a head+tail preview of a stashed payload, without rehydrating it (R-I3 handle /
  lazy-load).** Where `get(id)` returns the whole parked blob, `peek` returns only
  `{ id, bytes, head, tail, createdAt, truncated }`: a fixed-length prefix *and* suffix (the conclusion
  — exit code, failing frame, closing structure — lives at the end), the true octet size, the parked-at
  time, and whether a middle span is elided. The agent reasons over the handle and `get`s the full body
  only if it decides it needs it. Head+tail borrows the structural half of SmartCrusher's start+end
  split (not the full-scan anomaly-keep, which stays an R-C7 concern). **Stash-only** — `recall` owns
  ranked retrieval over memory; `peek` carries no weights. The win is the **bounded result** (only
  ~head+tail bytes reach the caller, so the payload stays out of the context/token budget) — *not* a
  DB-time win: SQLite reads the column to slice it, so peek's compute scales with payload size (measured
  ≈`get`, slower past a few MB). 6 integration tests; design validated in `poc/ri3-handle-poc.mjs`.

### Changed
- **`stash()` / `peek()` are library-API only, by design** (clarifying 0.6.0's "not yet wired to
  CLI/MCP"). Parking and previewing a payload are runtime mechanics the host loop performs, not calls a
  reasoning model makes; the MCP surface stays the model's verbs (recall/remember/impact). Documented in
  `litectx.context.md` and the CE PRD §10.5 (consumption surface — `import` vs MCP).
- **A symbol's chunk now carries its own leading doc-comment.** The chunker previously let a JS/TS
  JSDoc block (a sibling node *above* the `function`/`class`) orphan into the file `preamble`,
  dissociating a symbol from its own documentation; Python docstrings (inside the body) were unaffected.
  Each def chunk now extends upward over an immediately-adjacent comment block (a blank line breaks the
  association). **This exists to unblock the R-C7 `compress()` signature+docstring render tier** — for
  JS/TS the JSDoc must ride in the chunk body to render the signature tier — and that is its *only*
  justification. **It does not improve recall.** *Lexical:* 0/3 on real OpenSpec TS (the earlier
  "0/2→2/2" came from a crafted bench with doc-exclusive sentinel queries; real queries share vocabulary
  with the code body, and the named-chunk-over-preamble tie-break already localizes correctly). *Semantic:*
  also a wash — the embeddings tier indexes the raw whole file (file-level, so this is a no-op there); at
  symbol granularity the doc adds **−0.003 MRR** on fair name-derived queries (`poc/rc7-doc-embed-poc.mjs`,
  229 real symbols), the +0.248 MRR upper bound being an artifact of doc-derived queries. **File-level
  ranking byte-identical** (aurora 0.552 / gitdone 0.425 unchanged). Evidence: `poc/rc7-compress-real-poc.mjs`,
  `poc/rc7-doc-embed-poc.mjs`; 2 new regression tests.

## [0.6.1] — 2026-06-11

Clears the optional-tier CVE chain flagged in 0.6.0's known issues. No change to the deterministic
BM25 core, the public API, or any quality gate — embeddings recall is byte-identical (the model is
pinned to the same int8 quantization the tier was calibrated against).

### Changed
- **Optional embeddings dependency migrated `@xenova/transformers` → `@huggingface/transformers`
  (v4).** The successor package's `onnxruntime` drops the abandoned `onnx-proto` pin, and its
  `protobufjs` floats to a patched release — **`npm audit` is now clean (was 1 critical + 3 high, all
  in the optional tier)**. The embed call pins `dtype: "q8"`: transformers.js v3+ changed its default
  from int8-quantized to fp32, which silently regressed paraphrase recall (bench para MRR 0.574→0.532,
  under the floor) and quadrupled the model download; `q8` reproduces the calibrated model exactly
  (para **0.574** held, morph 0.889, exact 1.000 — 0 gate failures) and the documented ~23 MB
  footprint. Install string is now `npm i @huggingface/transformers`; the `pipeline("feature-extraction")`
  API is otherwise unchanged.

## [0.6.0] — 2026-06-11

The restorable-compression release. Adds `stash()` — a keyed agent-context store separate from the
searchable memory core — plus security hardening and review-driven cleanups. No new dependencies; the
deterministic BM25 core and every quality gate are unchanged.

### Added
- **`stash(id, text)` — a keyed agent-context store (R-C4 restorable compression).** Park a large
  payload (a tool result, a fetched page, a file dump) out of the context window keeping only the
  cheap `id` handle; `get(id)` rehydrates it verbatim and `forget(id)` evicts it. A stash is **not
  memory**: it lives in no FTS table, so `recall` never surfaces it (on any kind), it is **never
  auto-pruned** (a restore always works), and it's reached only by exact id. The first citizen of the
  "agent context" domain, kept structurally separate from the searchable memory core. Library API for
  now (not yet wired to the CLI/MCP surfaces). 6 integration tests.

### Changed
- **Internal cleanup (no API or behavior change).** Removed dead `Embedder` members (`embedMany`,
  `dim` — uncalled/unread, not part of the injectable-embedder contract). De-duplicated the
  written-kind nominee path: `Store.knnCandidates` now reads each candidate's vector from its
  existing `file_embeddings` join instead of issuing a second query, with the BLOB→Float32Array
  decode shared via one `blobToVec` helper. Results byte-identical (KNN-union tests unchanged).

### Security
- **`Store.forgetMemory` now refuses an empty selector** (defense in depth). A selector-less bulk
  forget degraded to `DELETE … WHERE 1=1` and wiped **all** written memory; the public `forget()`
  wrapper already guarded this, and the store layer now enforces it too, so the destructive default
  is unexpressible regardless of caller (the only "delete everything" is the explicit `reset()`).
  Regression test added. Found in a security audit of the memory surface (2026-06-11); the path was
  unreachable via the public API, so this hardens the lower layer rather than closing a live hole.

### Known issues
- The **optional** embeddings dependency `@xenova/transformers` pulls a transitive chain
  (`onnxruntime-web` → `onnx-proto` → `protobufjs`) carrying known advisories (1 critical + 3 high,
  all `protobufjs`), reachable only when the tier parses an ONNX **model file**. The deterministic
  BM25 core — the library default, with graceful fallback everywhere — pulls none of it. Planned
  fix: migrate the optional dep to the maintained `@huggingface/transformers` (v4), whose newer
  `onnxruntime` drops that chain, and pin the model revision.

## [0.5.0] — 2026-06-11

The semantic-by-default release. Embeddings now ship **ON by default on the CLI and MCP surfaces**
(the ways agents actually use litectx), with graceful BM25 fallback when the model dep is absent.
Validated by `poc/recall-litmus*` across litectx/aurora/gitdone: embeddings lift natural-language
code recall ~+0.2 MRR and are near-essential for memory (paraphrase 0.000→0.574). The deterministic
BM25 + spreading core is unchanged — every quality gate is byte-identical.

### Added
- **Embeddings ON by default on the CLI and MCP** (`bin/litectx.js`, `bin/litectx-mcp.js`); pass
  `--no-embeddings` for the BM25-only base. The **library `LiteCtx` default stays `false`** (explicit
  opt-in for embedders), so lib consumers, tests, and the BM25 gates are unchanged. `@xenova/transformers`
  moved `peerDependency` → `optionalDependency` so `npm i litectx` auto-installs it best-effort (that's
  what makes default-on real) without failing the install if the native build can't.
- **Graceful embeddings fallback.** If `@xenova/transformers` can't load (absent / build failure), litectx
  disables the tier for that instance, warns once to stderr, and continues on BM25 — so neither a bare
  install nor CI (which runs without the optional dep) ever crashes. Covers all three embed sites
  (index, recall query, `remember`).
- **CLI `help` / `--help` / `-h` and a bare `litectx`** now print usage to **stdout and exit 0**
  (previously the only way to see usage was to trigger an error, which printed to stderr and exited
  1). Bad invocations still print usage to stderr and exit 1.
- **Output-column legend in the usage text.** `recall`/`recent` rows are terse tab-separated columns
  (`score  kind/format  path  → chunk-symbol:start-end  git:Ncommits/age`, etc.); the legend explains
  them without touching the data rows, so `| awk`/`cut` pipelines stay clean. Documentation only — no
  table rendering or dependency (presentation for the agent surface stays at the agent, not the tool).

### Changed (docs)
- **Corrected the embeddings cost figures and reframed the default.** The "15–19s cold latency" in
  CLAUDE.md / PRD §3.3 + §8 was aurora's **torch** cold-start, mis-borrowed — measured transformers.js/ONNX
  is **~2.1s first-ever download · ~0.72s cached load · ~6ms warm**, and the model is **~23 MB** (not 90 MB).
  Embeddings is now framed as **off-by-default only for a lean/offline base install, but strongly
  recommended — and near-essential for the memory primitive** (paraphrase recall 0.000→0.574); the real
  opt-in cost is the dependency + index-time embedding, not query latency. Validated by `poc/recall-litmus*`
  on litectx/aurora/gitdone (embeddings +~0.2 MRR on natural-language code queries; free LLM query-expansion
  recovers ~90–95% and erases misses). Added embedding-model candidates to the aurora borrow-ledger
  (`jina-embeddings-v2-base-code` realistic; `nomic-embed-code` not adoptable for a JS lib — too large,
  the competitor only ships it by compiling into a static binary).

## [0.4.0] — 2026-06-11

The access-log tier release. `recentActivity()`, `promotionCandidates()`, and trust columns ship as
a version, and an **optional Claude Code integration** lands in-repo (`integrations/claude/`): an
LSP-free pre-edit `impact()` hook and a SessionStart index-warmer, with the generic stdio MCP server
documented for any client. Library ranking is byte-identical to v0.3.0 — these are read views and
tooling, not new scoring.

### Added
- **Claude Code integration (optional, `integrations/claude/`).** Opt-in, Claude-Code-specific hooks
  plus a note on the generic MCP server. `pre-edit-impact.mjs` is a `PreToolUse:Edit` hook that, for
  the enclosing symbol of an edit, surfaces litectx `impact()` — callers, reference count, low/med/high
  risk bucket — as `additionalContext`: the LSP-free replacement for a language-server pre-edit check.
  It resolves the enclosing symbol by indentation/block scope (a one-line local can't shadow the real
  function; a method isn't lost to its class), is best-effort, and **never blocks the edit**.
  `warm-index.sh` is a `SessionStart` hook that incrementally re-indexes the current repo so recall
  stays fresh (silent, non-fatal). The `README.md` documents registering the **generic** stdio MCP
  server (`bin/litectx-mcp.js`, any MCP client) globally so it auto-scopes to the working repo.
  Nothing in the library depends on any of this; it ships in `files` so adopters can wire it up.
- **Slice 5c — trust columns on written-memory recall hits (access-log tier, view #2).** Fact/episode
  hits now carry `provenance` (`human`/`agent`), `use` (`'recall'` demand count, fetches excluded), and
  `occurredAt` (episode timestamp) — the written-memory analog of the `git` grounding field:
  **surfaced for the caller to weigh, never scored.** Ranking stays pure relevance (BM25 + spreading),
  byte-identical on every bench. The original plan — a trust/stability *tie-breaker* — was **falsified
  by two POCs** and re-scoped to exposure: `poc/trust-tiebreak-poc.mjs` showed code-side stability
  no-ops on exact ties (code files almost never tie) and pollutes repo-dependently on any band (aurora
  0.552→0.222), and `poc/trust-facts-poc.mjs` showed facts don't tie either *and* that forcing
  trust-first buries a better-worded answer (a stronger-BM25 `agent` fact rightly outranks a `human`
  one). The reframe: `provenance` is a **validation** axis, not quality (an agent fact may be true,
  awaiting HITL), and a fresh effective memory has `use: 0` — ranking on either is a who-said-it /
  popularity prior. So litectx hands the agent the columns and never editorialises via rank;
  recall-count still drives `reviewCandidates`/`promotionCandidates`, never search order. Exposed on
  all three surfaces (hit fields · `litectx recall` trailing column · MCP `recall` hits + tool-desc).
  The per-chunk churn signal stays in `recentActivity` (5a), not on recall. 5 integration tests
  (columns present/correct, `use` counts recall-only, the never-reorder guarantee, episode
  `occurredAt`, code carries nothing), mutation-checked. **The access-log tier (5a/5b/5c) is now
  complete.**
- **Slice 5b — `promotionCandidates()`: the episode promotion ladder (access-log tier).** Episodes
  are the agent's ephemeral scratchpad (its own synthesized gotchas); they graduate by **use** into
  durable facts. `promotionCandidates(threshold = 10)` returns agent-written `episode`s recalled at
  least `threshold` times within a **30-day rolling window**, most-recalled first — the agent-side
  first rung. The consumer's agent reads each (`get`), distils a `fact` via `remember(kind:'fact')`,
  which then rides the existing `reviewCandidates(5)` → human-validate path (litectx **flags, never
  summarizes** — no extraction LLM). The count gates **distillation, never ranking** (a hot episode
  never rank-boosts — the §4 feedback loop stays forbidden; mirrors `reviewCandidates`, with a higher
  default threshold since episodes are noisier). Two ephemerality rules keep the scratchpad bounded:
  episodes >30 days **soft-decay** out of the candidate set, and each new episode `remember()`
  **auto-prunes** (hard-deletes, cascading text/embedding/recall-log) episodes past the window —
  self-bounding, no cron. Anything that mattered became a fact, and facts never prune, so nothing
  earned is lost. Pruning runs *before* the write so an explicitly-authored (even backdated) episode
  is always honored. Exposed on all three surfaces: `ctx.promotionCandidates()`, `litectx promotions
  [--threshold <n>]`, and the MCP `promotions` tool. POC-first validated the ladder composes through
  the real API (`poc/promotion-ladder-poc.mjs`); 5 integration tests (gate + 3 exclusions, threshold
  asymmetry, self-prune cascade, full ladder, ranking isolation).
- **Slice 5a — `recentActivity()`: the "what was I working on" view (access-log tier).** A new
  isolated read returning the code/doc chunks litectx most recently *witnessed* edited, newest
  first, within a recency window (`days` default 7, or an explicit `since`; `limit` default 20).
  Each row is a chunk — `{ id (file path), symbol, kind, lastEditedAt, edits }` — where `edits`
  counts the distinct index passes (sessions) that changed it; a file's anonymous chunks collapse
  to one per-file row. The edit stream is built **at index time**: each incremental `index()` diffs
  every new chunk body against the stored `nodes` and logs the new/modified ones to a new
  `chunk_edits` table. A **cold first build or `force` rebuild records nothing** (mass-loading isn't
  editing), so the view reflects only what litectx watched. Exposed on all three surfaces:
  `ctx.recentActivity(opts)`, `litectx recent [--since <days>] [-n <n>]`, and the MCP `recent` tool.
- **The witnessed-edit signal ships here, and *only* here.** Folding edit-activation into recall as
  a re-rank weight was **POC-falsified as repo-dependent** (`poc/access-bench.mjs`: lifts aurora,
  pollutes litectx — base-level activation is topic-blind, floating the same hot chunks for every
  query), so the edit→recall re-rank ships at zero. `recentActivity` reads the `chunk_edits` log and
  never the ranking path, and writes nothing to the recall audit log (it is not a demand signal).
  Validated end-to-end on three real repos (`poc/recent-activity-eyeball.mjs`): clean tree-sitter
  symbol-grain rows, distinct from git's coarse hunk-context.

## [0.3.0] — 2026-06-11

The paraphrase release. A single, focused recall improvement on the opt-in **embeddings tier**:
for written memory (`fact`/`episode`), cosine similarity now **nominates** candidates instead of
only re-ranking what the lexical gate already found — so a zero-shared-term paraphrase ("money
back" → a refunds fact) is reachable at all. This closes the documented hole the 0.2.0 release E2E
grounded (the tier could re-rank the FTS pool but never reach outside it). The default deterministic
**BM25 + spreading** core is byte-for-byte unchanged — all three code gates are identical to the
0.2.0 baseline, and `code`/`doc` recall is untouched (the union is written-kinds-only). No new
production dependencies. Pre-1.0: the API may still evolve.

### Added
- **Slice 11 — KNN union: paraphrase recall for written memory (embeddings tier).** For
  `fact`/`episode` with the tier on, cosine now **nominates** candidates instead of only
  re-ranking what the lexical gate found: up to 8 stored vectors nearest the query
  (`Store.knnCandidates`) are unioned into the BM25 pool before fusion, entering at the pool's
  score floor so lexical hits keep their head start. This closes the documented hole the 0.2.0
  release E2E grounded — a zero-shared-term paraphrase ("money back" → a refunds fact) was
  unreachable even with embeddings on, because cosine could only re-rank the FTS-matched pool.
  **POC-swept before building** (`poc/knn-union-poc.mjs`, real model, K × threshold grid):
  K=8 with **no admission threshold** is the data's pick — true-paraphrase cosines run low, so
  any threshold only kills true answers (T=0.25 already halves para MRR), while the k-cap +
  fusion keep weak nominees down; the one boundary kept is *strictly positive* cosine (zero or
  negative similarity is no evidence — verified live: off-topic queries score negative against
  unrelated facts and return empty). **Bench (memory-facts, tier on): para MRR 0.000 → 0.574
  (top-3 83%), morph 0.722 → 0.889 (the two stemmer-resistant morphs now nominate
  semantically), exact holds 1.000.** The bench's `--embeddings` pass graduates from
  informative to **gated when it runs** (`embFloors`: exact 0.8 / morph 0.85 / para 0.55,
  mutation-checked; still skipped when the optional model dep is absent, same discipline as the
  repo corpora). `code`/`doc` stay strictly gate-then-rerank — their recall path is unchanged
  (all three code gates byte-identical) and the scan cost stays bounded to written memory
  (linear by design at lite scale; `sqlite-vec` remains the named escalation). Limits,
  documented: nomination requires the vector to exist (a fact written with the tier off never
  nominates until re-remembered with it on), and an off-topic query may surface weakly-similar
  facts ranked low. 8 integration tests (synonym-stub embedder; 113 total — 1 pre-existing
  missing-dep test now self-skips where the model is locally installed); `tsc` clean.

## [0.2.0] — 2026-06-10

The write release. litectx graduates from a read-only code/doc index to a **write-capable memory
across kinds with its consumption surfaces in the box**: the `remember`/`forget` write path
(facts, episodes, direct docs — provenance, audit log, HITL `reviewCandidates`), porter-stemmed
written-memory recall, **chunk-granular recall** (every hit carries the matching
function/section pointer), **`get(id)` body access** (written memory verbatim, files fresh from
disk), the opt-in **embeddings tier**, and two thin adapters over the same public API — the
**CLI** (now write-capable) and a zero-dependency stdio **MCP server** (`litectx-mcp`). Also
fixes a 0.1.0-era `index({ force: true })` bug that destroyed written memory (unreachable in
published 0.1.0, which shipped the read surface only). No new production dependencies —
the MCP server is hand-rolled stdio JSON-RPC. Pre-1.0: the API may still evolve.

### Added
- **Slice 10 — MCP surface + CLI write parity.** litectx now ships **two thin adapters over the
  same public API** — the consumption surfaces that make the memory usable without writing a line
  of integration code, while the library stays cleanly importable (nothing in `src/` knows either
  surface exists; `import { LiteCtx } from "litectx"` loads zero surface code).
  - **`litectx-mcp`** (second bin): a **hand-rolled stdio MCP server** — newline-delimited
    JSON-RPC 2.0, client-spawned, NOT a daemon (the "no service tier" rule holds), **zero new
    dependencies** (no SDK: the protocol loop is under 100 lines, below the external-dependency
    bar). Exposes the six public operations: `index` / `recall` / `impact` / `get` /
    `remember` / `forget` (the core options each — advanced lib options like pathspec-scoped
    indexing, kind arrays, and `occurredAt` backdating stay lib-only; the surfaces are thin
    adapters, not option re-exports). Tool failures return `isError` results (in-band, the agent
    self-corrects), protocol errors are reserved for malformed JSON-RPC, stdout is protocol-pure,
    and responses may legally return out of order (clients match by id). The audit-log defaults
    stand over MCP with **no opt-out exposed**: an MCP client is a live agent — exactly the demand
    the log exists to capture; dashboards and batch tooling should use the lib or CLI instead.
    POC-validated against a real client (Claude Code via `--mcp-config`) before building; the
    shipped bin re-verified the same way (full write loop, verbatim round-trip).
  - **CLI write parity**: `litectx remember <id> [text...] [--kind fact|episode|doc]
    [--by human|agent]` (body from arguments or piped stdin — `git log -1 | litectx remember
    ep:release`), `litectx forget <id>` (or bulk via `--kind` / `--by`; exits 1 when nothing
    matched), `--embeddings` on `index`/`recall`/`remember` (the opt-in semantic tier from the
    command line), and `--no-log` on `recall`/`get` (the demand-signal opt-out, closing slice 9's
    known item 2).
  - 7 integration tests that spawn the real server binary and speak JSON-RPC over stdio
    (105 total); `tsc` clean; all three bench gates unchanged (no `src/` change this slice).
- **Slice 9 — `get(id)` body access + tagged fetch logging.** `ctx.get(id)` fetches one stored item's full record by id — the read counterpart to `recall` (recall returns ranked *pointers*; `get` returns the *thing itself*), and the prerequisite for MCP (a recall tool returning fact ids with no way to read their text is useless — PRD §15). **Any id works:** a written-memory id returns the text **verbatim as remembered** — backed by the new `mem_text` table, because the FTS body is a processed *searchable surface* (`indexBody` folds path tokens + camel parts) and a written row has no file behind it to re-read; an indexed file's repo-relative path returns the file **read fresh from disk** (the index is not a file cache; `text: null` only when the file vanished since the last `index()`). Returns `{ id, kind, format, source, provenance, occurredAt, text }`, `null` for unknown ids; sync (no embedder involved). **Fetch logging is a tagged weak signal, never demand** (the demoted fetch-toll, PRD §14 #4): `recall_log` gained an `action` column (`'recall'` | `'fetch'`); each `get` logs `action: 'fetch'`, and the demand readers (`recallCount`, `reviewCandidates`) now filter to `action = 'recall'` — you fetch what recall just returned, so counting fetches as demand would double-count every retrieval. Nothing scores the tag yet; it earns weight (if any) at the action-signal bench. `get(id, { log: false })` opts out, same contract as `recall`. `remember` upserts the raw text alongside the row; `forget` drops it (no orphans). **Schema self-heal extended** (additive, data preserved): a pre-slice-9 db gains the `action` column via `ALTER` (pre-existing rows were all real recalls, so the `'recall'` default is the true value), and a pre-slice-9 written row with no `mem_text` degrades to its stored FTS body — never `null`, never dropped. CLI: `litectx get <id>` (metadata → stderr, body → stdout, so it pipes clean). All gates byte-identical (aurora 0.552 / gitdone 0.425 / memory 1.000·0.722·0.000-pinned / impact 0+0); 98 tests (+10 here, +1 with the fix below), `tsc` clean.

### Fixed
- **`index({ force: true })` no longer destroys written memory** (caught by the slice-9 validation round — a live probe, the same way slice 8's bugs were found). A force pass used to call `Store.reset()` — scorched earth — silently deleting every fact/episode/direct doc, their raw text, their embeddings, and the whole recall log. That contradicted the documented reconcile-seam contract ("written memory survives every `index()` pass — structurally") and the store's own self-heal rule ("only ever drop re-indexable data"): written memory is precisely the data with no file behind it to rebuild from. `force` now calls the new `Store.clearIndexed()` — it drops only file-sourced data (file `docs` rows, `file_index`, `nodes`, `edges`, `git_sig`, and file embeddings scoped by `file_index` keys) and preserves written memory (`mem`, `mem_text`, direct `docs` rows, written embeddings) and `recall_log` (append-only demand history). `reset()` remains for the ≤0.1.0 self-heal, where it is correct — such a db predates the write path and can hold nothing unrecoverable. Regression test pins survival of the row, raw text, embedding, and demand history across a force pass.
- **Slice 8 — chunk-granular recall (`hit.chunk`) + the `log: false` demand-signal opt-out.** Every recall hit now carries a **`chunk` pointer** — the function / class / md-section *inside* the file that best carries the query terms (`{ symbol, nodeType, startLine, endLine } | null`): a function pointer beats a file pointer (PRD §14 #4 — quality motivation only, explicitly NOT capture). **Ranking is untouched by construction:** the pointer is attached *after* ranking, only to the final returned hits (≤ `n` per kind, never the pool), and **localizes, never reorders** — both recall gates byte-identical (aurora 0.552 / gitdone 0.425), memory + impact gates unchanged. Localization is structural, no weights (store.`attachChunks`): both sides identifier-split the same way as indexing (`splitIdent`), score = distinct query terms present in the chunk (symbol + body) — plus the one non-obvious rule, **caught by a live probe on litectx itself**: chunks nest (file/preamble ⊃ class ⊃ method ⊃ arrow), and a container's term set is a superset of its children's, so naive max-count *always* returned the whole class (a 455-line `Store` pointer instead of the 41-line `attachChunks` method — the file-pointer problem again at class scale). Shipped rule: **the winner may not strictly contain another scoring chunk** (a container still wins when the match genuinely lives in container-level code); ties prefer named over anonymous, then smaller span; an anonymous winner (arrow/lambda) is labeled with its nearest named container. `chunk: null` is honest: written memory has no chunks (the row IS the unit — facts/episodes/direct docs), and a match carried only by filename/path tokens names no chunk. The CLI prints the pointer as a `→ symbol:start-end` column. **`recall_log` now records each hit's chunk `symbol`** (nullable column; schema-on-create, table is unreleased) — recalled-and-edited can now join at the **same grain** once the access-log tier's edit-bind lands (§14 #4: file hash = trigger, chunk diff = attribution). **`recall(q, { log: false })`** closes the flagged open decision: the recall log is a **demand signal**, so consumers whose queries aren't real demand — dashboards, CI checks, batch tooling, read-only db opens — opt out instead of polluting the future activation fuel (default `true`; both flat and grouped modes). **Schema self-heal on open** (found when the stale pre-slice-7 dev db crashed `index()` with *"table docs has no column named source"* — the exact crash every 0.1.0 adopter would hit on upgrade, since `CREATE IF NOT EXISTS` leaves stale tables in place): the `Store` constructor now inspects the live schema — a `docs` table without `source` predates the write path, **cannot contain written memory**, only re-indexable files → rebuilt; a `recall_log` without `symbol` is column-additive → `ALTER`, log preserved. The rule: an upgrade that can preserve data does; one that can't only ever drops re-indexable data. +8 tests (code chunk = the *second* function in a file, md section by heading, filename-only match → `null`, **class never beats its own method by aggregation**, written memory → `null`, `log:false` skips both modes, the log records the symbol, **pre-0.2 db self-heals instead of crashing**) — **87 total**; typecheck clean.
- **Slice 7b — written-memory stemming (PRD §5.1): facts/episodes get their own porter-stemmed FTS table.** Closes the gap the new `bench:memory` gate measured: FTS5 has no stemming, so a fact stored as *"refunds…"* was **never** found by *"refund policy"* (morph MRR 0.000 — total, since the FTS gate is lexical and a zero-match item never reaches ranking). **Measured before decided:** porter on the one shared `docs` table lifted morph to 0.722 but **broke the aurora code gate** (0.552→0.530), regressed multis (0.457→0.431) and collapsed gitdone P@1 (25%→15%) — in code, word-forms are distinct *symbols* (`token`/`tokens`/`tokenize`), so stemming dilutes identifier precision; rejected by the every-repo rule. (Aurora grounding: aurora ships porter on everything, but only as a *stage-1 gate* re-scored by a separate ranker; litectx's FTS table is gate **and** ranker — "stem the gate, rank exact" is the documented future option for code, not built.) **The shipped design:** a second FTS table `mem` (`tokenize='porter unicode61'`) holds `fact`/`episode` rows, routed by kind in `search()`/`writeMemory()`; `code`/`doc` — including *direct-written* docs, so one kind stays one ranking domain — remain on the unstemmed `docs` table, and since kinds never share a ranking, no BM25 score ever merges across tables. `forgetMemory` covers both homes; `reviewCandidates` reads `mem`; `count()`/`size()` = both tables (observable behavior unchanged). **Result: morph 0.000 → 0.722** (all inflectional cases fixed; the 2 residual misses are derivational/compounding, beyond a stemmer), exact holds 1.000, para stays 0 (embeddings-tier territory), **code/doc recall byte-identical** (aurora 0.552 / gitdone 0.425). The bench's `expected` pin tripped on the move as designed and morph **graduated to a floor (≥0.7)**. +2 tests (stemmed fact/episode round-trip across inflection; the deliberate doc-stays-exact boundary) — 79 total; typecheck clean.
- **`bench:memory` — the written-memory recall QUALITY gate (§11.3).** Slice 7's tests prove round-trip *survival*; this proves *ranking*. Committed corpus **in the dataset** (24 facts + 5 episodes, `poc/datasets/memory-facts.mjs` — no local checkout needed; pure-memory mode, no `index()`), 32 queries labeled **exact / morph / para**, per-category MRR/P@1/P@3, floors + honesty pins (`expected` — a category that *moves* fails until consciously updated), and a mechanical **label audit** (exact must share ≥1 keyword with the target's indexed text; morph/para must share 0 — mislabels fail the run). Mutation-checked three ways (mislabel → audit fails; impossible floor → fails; stale `expected` → fails). First run: exact 1.000 / morph 0.000 / para 0.000 — the morph zero being the finding that drove slice 7b. Optional `--embeddings` pass (informative, never gated). Porter probe + the porter-everywhere four-repo run recorded in `poc/RESULTS.md`.
- **Slice 7 — the write path (`remember` / `forget`): facts, episodes, and direct docs (PRD §3.2).** litectx becomes a write-capable **memory across kinds**, not just a code/doc index. Knowledge that isn't a file enters via **`await ctx.remember(id, text, { kind, format?, by?, occurredAt? })`** — `kind ∈ {fact, episode, doc}` (a FAQ with no file on disk is a first-class `doc`); `id` is the caller's key (upsert + forget handle; namespacing like `"fact:auth-uses-jwt"` recommended); content is stored **whole** (never chunked — the caller controls granularity). **`ctx.forget(id)`** deletes by key; **`ctx.forget({ kind?, by? })`** bulk-invalidates by query (e.g. drop every agent-asserted fact). **Three orthogonal axes, never conflated:** `kind` (memory type → retrieval semantics), `format` (content form), and two who/how fields — `source` = HOW it entered (`file` via `index()` | `direct` via `remember()`; internal, the caller never passes it) and **`by`** = WHO asserted it (`"human"` | `"agent"`, default agent — the trust axis, stored as `provenance`). `occurredAt` (epoch ms, default now) is **constitutive for episodes only**; facts ignore it (a durable assertion has no "when"). **The reconcile seam is structural, not guarded:** written rows never enter `file_index`, and `index()` computes its deletes solely from `file_index` keys — so written memory provably survives any scoped, full, or real-sweep `index()` pass. `forget` is scoped to `source='direct'`, so it can never touch an indexed file. **Recall works across all kinds for free** (the engine is kind-agnostic; BM25, + cosine when the embeddings tier is on — `remember` embeds on write) — but **no spreading** (facts/episodes have no import edges) and **no recency/decay scoring yet** (that is the access-log tier; the fact 0.02 / episode 0.40 decay rates are PRD §4 calibration, deliberately not dead code). **Every `recall()` hit is now logged** to a new `recall_log` table — an audit trail (what agents lean on; where a wrong belief came from) and the genuine **access log** the base-level tier will later score (real retrieval events, not git's edit-proxy). **HITL promotion (review earned by use):** **`ctx.reviewCandidates(threshold = 5)`** returns agent-asserted facts whose recall count crossed the threshold — the consumer shows each to a human who validates (re-`remember(..., { by: "human" })` → durable) or invalidates (`forget(id)`); acting removes it from the set, no "reviewed" flag needed. The count gates *review*, not *ranking* — explicitly not a rich-get-richer feedback loop. litectx ships the mechanism only: **no extraction LLM, no trust funnel, no consolidation** — what becomes a fact and what goes "hot" is consumer policy (litectx is the low-write-bar cold/warm store; an always-injected `MEMORY.md` is the opposite, high-bar regime). Schema delta, no migration: `source`/`provenance`/`occurred_at` columns on `docs`, the `recall_log` table, `fact`+`episode` activated in `KINDS`. **13 integration tests** (`test/memory.test.js`): write→recall round-trip in pure-memory mode (no `index()` ever), the seam (survives scoped + full + real-sweep passes), forget by id/query, indexed-files-untouched, upsert-by-id, the audit log, embeddings-on write (vector stored + tri-hybrid recall, stub embedder), `occurredAt` defaulting (episode→now, fact→null), forget side-table cleanup (no orphan vector/log rows), and `reviewCandidates` (threshold + promotion clears the set). Recall bench **byte-identical** (aurora 0.552 / gitdone 0.425; logging doesn't move ranking); impact gates untouched; typecheck clean.
- **Slice 6 — the embeddings tier (opt-in semantic recall).** The first and only opt-in tier: with `new LiteCtx({ embeddings: true })`, `index()` embeds each file and `recall()` fuses semantic cosine into the BM25 + spreading ranking. **Off by default** — the deterministic core is byte-for-byte untouched (recall gates hold 0.552 / 0.425). Validated end-to-end through the shipped path: gitdone **dual 0.425 → tri 0.647** at w=1.0, exactly reproducing the POC (poc/RESULTS.md). **Design, every choice POC-validated:** **storage** — one float32 vector per file as a `BLOB` in the *same* SQLite db, **no sqlite-vec** (recall is BM25-gated, so cosine only runs over the candidate pool, never the corpus → brute-force is O(pool), sub-ms at any repo size); **representation** — head-truncated file text (a distilled symbol/signature string was a *wash* vs head, so the simpler head ships — the claim didn't pan out); **weight** — 1.0 default, with the held-out repo (multis) confirming **no overfitting cliff** (conservative because the bench is natural-language-only); **model** — `Xenova/all-MiniLM-L6-v2` via transformers.js as an **optional peer dependency**, lazy-loaded (the core install stays one-prod-dep; a missing dep fails loudly, never silently); **incremental** — only changed files are re-embedded, deletes drop the vector, and the query embedding is LRU-cached. New `src/embedder.js` (`Embedder`, `cosine`, both exported); `LiteCtx` config gains `{ embeddings, embedWeight, embedModel, embedder }` (`embedder` injects a custom/stub provider). 9 hermetic tests with an injected stub embedder (storage round-trip, incremental re-embed, delete, fused re-rank, off-path invariant, query cache, missing-dep guard). 64/64 `node --test`; typecheck clean; recall + impact gates green.

### Changed
- **BREAKING (pre-1.0): `recall()` is now async** — it returns a `Promise`, so call sites must `await ctx.recall(...)`. The embeddings tier embeds the query at call time; with embeddings off the work is still synchronous (just wrapped in a resolved promise, no model touched). This makes the public API uniformly async (`index` / `recall` / `impact`). Next release is **0.2.0**.
- **Behavior (pre-1.0): a bare/grouped `recall()` now groups over FOUR kinds.** `KINDS` grew from `["code","doc"]` to `["code","doc","fact","episode"]` (slice 7), so `recall(q)` with no `kind` returns `{ code, doc, fact, episode }` — empty arrays for kinds with no content. Callers that `deepEqual` or iterate the grouped shape see two new (possibly empty) keys; single-kind calls are unchanged.
- **Behavior (pre-1.0): `recall()` is no longer side-effect-free** — every hit appends a row to the `recall_log` audit table (slice 7: the audit trail + future access log). Ranking is unaffected (bench byte-identical) and the write is in the same SQLite file/process, but a recall now performs a small write: relevant if you open the db read-only, or if you diff db bytes between calls. ~~A `log: false` opt-out is **not yet shipped** — flagged as an open decision.~~ Shipped in slice 8: `recall(q, { log: false })`.

## [0.1.0] — 2026-06-09

First functional release — **published to npm** via the OIDC trusted-publishing workflow (`publish.yml` ran green end-to-end on `workflow_dispatch`, finally exercising the publish path; `npm view litectx version` → `0.1.0` confirmed). `0.0.1` was a name-reservation placeholder; **0.1.0 ships the real v1 read surface** — **recall** (kind-scoped BM25 + 1-hop import-spreading) and **impact** (called-by/calling → risk bucket, on-demand, no LSP) over **one shared graph** (TS/JS/Python + Markdown), built on SQLite + FTS5 + tree-sitter + ripgrep. Deterministic core, one production dependency (`better-sqlite3`); embeddings and base-level activation remain opt-in/roadmap tiers. Pre-1.0: the surface is built and CI-gated, but the API may still evolve and the broader context-engineering primitives (write/compress/isolate) are not yet in scope.

### Added
- **README now reflects the shipped v1 surface (was target-shape).** The status moves from *"design / POC stage — not yet shipped"* to **"v1 surface built, pre-release"** (POC gate cleared; recall + impact over one graph, 55 tests, CI-gated; `0.0.1` still a name-reservation placeholder until the first tagged release). The quick-start + result-shape examples are corrected to the **actual** API: dropped the non-existent `embeddings:` config option and `ctx.graph.*` accessors (the substrate is queried via the exported `Store`; ergonomic accessors are 🚧 roadmap), `impact()` shown **async** returning the real `{ symbol, risk, refCount, confirmed, mentions, callers, callees, complexity, defs, hedges } | null`, recall hits carrying `score` + `git` (not a roadmap `activation` field), and the incremental check described accurately (`git ls-files` → `(mtime, size)` fast-skip → content-hash). Roadmap signals (`recency`/`frequency`/`churn`/`activation`) are explicitly marked as the base-level-activation tier.
- **CI + asserted bench thresholds — the foundation hardened before any post-v1 tier (PRD §11.3, LIBRARY_CONVENTIONS §5):** the gates now **fail**, they don't just print, and the convention-mandated CI that was missing now exists. **CI:** `.github/workflows/ci.yml` (push/PR → `npm ci` → `typecheck` → `build:types` → `test`; no lint, per §5 — `tsc` with `checkJs`+`strictNullChecks` already catches the bug class that matters) and `.github/workflows/publish.yml` (manual `workflow_dispatch`, **OIDC trusted publishing** — no `NPM_TOKEN`, idempotent: skips if the version is on the registry and verifies end-state rather than trusting the exit code; `prepublishOnly` builds the types into the tarball). This closes the standing convention requirement *"CI runs `tsc --noEmit` on every push/PR."* **Recall gate graduated:** `poc/bench-lib.mjs` now asserts a committed **ALL-MRR floor** per dataset — a *small epsilon* below the shipped number (aurora ≥ 0.55 vs 0.552; gitdone ≥ 0.42 vs 0.425) — and a regression sets a non-zero exit (mutation-checked: raising the floor above the live MRR flips the gate to exit 1). The corpora are **local checkouts**, so an absent repo is *skipped, never failed* — reported explicitly ("enforced NOTHING" when nothing is present), which is why these stay a **local pre-push gate, not a CI step** (the §5 merge gate is typecheck+build:types+test only). **Impact gate was already asserted** (`impact-bench.mjs` exit-codes on the §7.2 invariants — silent isolations = 0, ISOLATION-accuracy misses = 0); its caller-recall QUALITY stays deliberately un-gated (over/under-count in the caller LIST is informative, not a safety failure) — left untouched. No `src/` change; typecheck clean; 55/55 tests; both benches green (aurora 0.552 / gitdone 0.425; impact 100% recall, 0/0 failures). *One-time setup before the first publish: configure the trusted publisher for `litectx` at npmjs.com.* **Surfaced by the first CI run:** `impact()` has a hard runtime dependency on **`ripgrep` (`rg`)** — absent `rg`, the caller sweep returns nothing and a symbol reads as **0 callers** (a §7.2 false-isolation). Both workflows now install ripgrep before `npm test`, and it's documented as an adopter prerequisite in `README.md` (Install) + `litectx.context.md` (Gotchas + Constraints) — `recall`/`index` don't need it. **Validated end-to-end:** CI was watched **green on a clean runner** (the ripgrep finding was the literal red→green proof; actions pinned to `@v5` ahead of the Node-20 runner deprecation), the recall floor is mutation-checked (raise it above the live MRR → exit 1), and `publish.yml`'s idempotency guard is grounded against the real registry (`npm view litectx@0.0.1` resolves → the publish step correctly *skips*). The **OIDC publish step itself is unproven until the first real release** — it needs the one-time npmjs trusted-publisher config + a version bump; its gates (typecheck/test) and idempotency are proven, the `npm publish` handshake is not (inherently untestable short of publishing).
- **Composing-scenario test — the v1 surface over one graph (`test/composing.test.js`):** pins the doctrine claim the per-view suites don't (CLAUDE.md — "views over the same data, not re-extractions"): `index()` runs **once**, then both views read that single graph. A small app with a real import chain (`handler → auth → crypto`) is indexed once; `recall("…validate session token")` ranks the defining file first, and `impact("validateToken")` on the **same `ctx`, no re-index** reports its def at the very file recall surfaced (cross-view node identity), its callee (`verifySignature`) and both confirmed callers (`handleLogin`/`handleRefresh`). The graph is shown navigable **both directions** — `impact("verifySignature")` links back to `validateToken` as a caller — and every symbol either view names is in the one shared node set (`store.allSymbolNames()`). The closing invariant proves the views are **reads, not re-extractions**: doc / node / edge counts are byte-for-byte unchanged after all the recalls and impacts. A second test pins the realistic handoff (recall a concept → hand the discovered symbol to `impact`). 2 added `node --test` tests (55 total); typecheck clean; recall/impact benches untouched (test-only).
- **Slice 5b — barrel / path-alias anti-false-isolation (PRD §7.2):** closes the one dangerous under-count a name-only caller sweep can't see. A symbol reached only under a **renamed re-export** — `export { default as Panel } from "./widget-impl"`, imported via a tsconfig path alias (`import { Panel } from "@ui"`) — has its definition name appear nowhere outside its def line, so `rg -w` finds **zero** references → a **false isolation** (the §7.2 cardinal sin). `impact()` now resolves it **on demand, still no LSP**: new tree-sitter extractors `chunker.reExportsOf` (barrel `export { local as exported } from`) and `chunker.importBindingsOf`, plus a new `src/tsalias.js` (best-effort `tsconfig.json` `paths`/`baseUrl` loader + `specResolvesTo`) — kept **deliberately separate from `edges.js`** so recall's import resolution and its frozen benchmark are untouched. The resolver chains three hops: def → barrel alias (a rename, or the file's `default`) → consumer files that **actually `import {alias}` from that barrel** (path-alias-scoped, so an unrelated same-named symbol is **never** miscredited) → tree-sitter-confirmed call sites, each tagged with the alias it travelled under (`caller.alias`). Adds callers only (over-count safe, §7.2); JS/TS defs only (Python `from x import y as z` barrels are a noted single-hop gap). **#1 — the TS gate that gives 5b teeth:** a committed fixture `poc/fixtures/ts-barrel` (real barrel + `@ui` alias + a renamed default export + a renamed named export + a name-reachable sanity symbol + an unrelated-`Panel` decoy) with a hand-audited `poc/datasets/impact-ts.mjs`. `poc/impact-bench.mjs` gains an **ISOLATION-accuracy** check — `(refCount===0) === label.isolated` — alongside a sharpened **SAFETY** invariant (never a *silent* isolation: `refCount>0 || hedged`). Grounded **red before the fix**: the `barrel-default-alias` label read a false isolation (exit 1) while SAFETY stayed `ok` (hedged); **green after** (refCount 0→2, both real callers named, decoy excluded). 6 added `node --test` tests (`test/impact-alias.test.js`: renamed-default + renamed-named resolution, alias attribution, **scoped exclusion** of the decoy and of a same-named symbol imported from elsewhere, the hedge that surfaces the rename, and unit coverage of `specResolvesTo`/`loadTsPaths`). Mutation-checked: dropping the `specResolvesTo` scoping miscredits the decoy → the scoped-attribution test fails, proving the path-alias resolution is load-bearing. **Recall bench byte-identical (aurora 0.552 / gitdone 0.425); aurora/mcprune impact gates still 100% recall, 0 false-isolations** — 5b is impact-only.
- **Slice 5a — impact bench gate + decorator confirmation (PRD §11.3):** the impact view now has its own **end-to-end quality gate**, the impact analogue of the recall bench. `poc/impact-bench.mjs` (`npm run bench:impact`) indexes a stable repo through the real `LiteCtx`, runs hand-audited symbols through `impact()`, and scores the §7.2 **pair**: **SAFETY** (a used symbol must never read isolated — `refCount > 0`; target **zero** false-isolations) and **QUALITY** (confirmed-caller-FILE recall); over-count/precision is deliberately *not* gated. Two audited label sets — `impact-aurora` (Py) + `impact-mcprune` (JS, archived) — at **100% confirmed-caller recall, 0 false-isolations**. The gate paid for itself on first run: (1) it drove a **tool fix** — a bare `@decorator` application (e.g. `@handle_errors`, not a `call` node) is now a **confirmed caller**, not merely a mention floor (`langdef.decoratorTypes` + the `chunker.callSitesOf` decorator branch, which skips the `@x()` call form to avoid double-counting); and (2) it **caught an over-inclusive label** of mine (a `@handle_errors` *inside* `handle_errors`'s own def — a self-application, correctly excluded like recursion). +1 regression test (bare decorator is confirmed, not just mentioned) and a mutation check (disabling decorator confirmation kills both the test and the gate metric while SAFETY holds — proving the mention floor is independent). Recall bench unchanged.
- **Slice 5a — the impact view (`impact(symbol)`, §7):** the LSP-replacement bet, shipped and tested. `ctx.impact(symbol)` answers *"if I change this, what's the blast radius and how risky?"* — **computed on demand, never persisted** (§7.1): **callees** by a tree-sitter walk of the symbol's body, **callers** by an `rg -w` sweep confirmed back through tree-sitter (carrying the enclosing caller symbol), plus **complexity** (cyclomatic-ish branch count) and a **risk bucket**. No LSP, ever (§7) — the `type='call'` edge row stays *reserved* (on-demand matches §7.1's query-time mechanisms and avoids persisting a noisy, fast-moving call graph). Risk calibration is **borrowed from aurora's `lsp_tool`** (carry the numbers, not the LSP): `risk = bucket(max(confirmed, mentions))` at thresholds **≤2 low · 3–10 medium · 11+ high**. The view is built around the **§7.2 asymmetry** — over-count is safe (over-cautious), under-count is dangerous (a false "isolated → safe" breaks hidden consumers): `refCount` takes the **looser** of the two signals (resolution is **by name only** — no receiver typing, the LSP we don't have — so a common method name reads cautiously high, by design), and **"isolated / low-risk" is never a silent verdict** — an unconfirmed mention is *counted, not dropped* ("unresolved ≠ absent"), an exported/public name is hedged for invisible external consumers, and a zero-ref symbol is always a *hedged review candidate*. New `src/impact.js`; `langdef` gains `callTypes`/`branchTypes`; `chunker` gains `analyzeBody` (callees + complexity) and `callSitesOf` (the ts-confirm step); `store` gains `symbolDefs`/`allSymbolNames`; new CLI `impact <symbol>`. 9 added `node --test` tests (caller/callee resolution with enclosing symbols, the `max()` over-count rule, complexity, the aurora thresholds, every §7.2 hedge path). **Validated on aurora** (497 py): hubs bucket `high` with correct fan-in — `SQLiteStore` 235 refs/109 callers/complexity 107, `BaseLevelActivation` 47/36, `main` 132 refs/105 callees — at ~0.1–0.9s/symbol; recall bench **byte-identical** (aurora 0.552 / gitdone 0.425), since `calls` don't touch recall (Step-0 POC).
  - **Deferred to slice 5b (§7.2, gated on a TS bench fixture — POC-first):** the **alias / barrel** re-export anti-false-isolation mitigations. v1 has **zero TS** in the bench, so building those blind is forbidden; the export-root, reflection (unconfirmed-mention) and public-name hedges plus the universal *unresolved ≠ absent* net ship now and cover the residual. Recall makes no isolation claim and carries none of this risk — impact is where "isolated → safe" is load-bearing.
- **Slice 4 — git activity metadata (`gitsig`, §4.1):** every recall `Hit` now carries `git: { commits, lastCommit } | null` — file-level commit count + most-recent-commit unix time, collected in a **single `git log` pass** at index time (scoped by the index pathspecs), stored in a `git_sig` table, and attached to hits on recall. **Grounding, never scored** — the Step-0 POC rejected git as a ranking prior (it gives *edit* frequency, not *access* frequency), so the bench is byte-identical (aurora 0.552 / gitdone 0.425) and the metadata is displayed for the caller to weigh. No per-block blame (file granularity only — that and base-level activation are the access-log tier). `git: null` is the honest signal for *no commit history* — a non-git tree (graceful: `git log` failure → empty) or a tracked-but-uncommitted file alike. 5 added `node --test` tests (accurate counts vs a real repo, ordering-unaffected, the `null` contract, non-git fallback, **incremental refresh on a new commit**). Adversarially validated: counts cross-checked against raw `git log` on **two** repos (aurora + gitdone, exact match incl. a 68-commit file), the no-reorder claim *proven* (ranking byte-identical with vs. without `git_sig` populated), and incremental refresh confirmed (1→2→3 commits across re-indexes).
- **Slice 4 — import edges + spreading recall (the next ranking win, §4/§11.2):** `recall` now ranks by **BM25 + 1-hop import-spreading** — the two zero-ML v1 signals. A new `edges` module resolves import specifiers — extracted in the **same tree-sitter parse** as the slice-2 chunks (no double parse; Python `import`/`from` absolute+relative, ES `import`, CJS `require()`) — to **intra-repo** target files only (a miss → no edge; recall makes no isolation claim, so over/under-count are both tolerable for ranking). New directed `edges(type, src_path, dst_path)` table (`type` reserved for `calls`, slice 5), incrementally refreshed per-importer and dropped from both ends on delete. **Spreading is an additive boost** `own + w·spread` (best-neighbour normalised BM25), **w=0.3** — chosen over the convex `(1−w)·own + w·spread` form after the convex "tax" was diagnosed as the cause of two named regression modes (*collateral dilution*: a strong hit with mediocre neighbours out-risen by better-connected peers; *weak-neighbour demotion*: a correct answer whose imports point to low-relevance files, leapfrogged by well-connected distractors). **Validated on FOUR repos** (added `poc/datasets/multis.mjs`, a 3rd independent CJS repo): additive@0.3 is the **only** setting positive on every repo — aurora 0.525→0.552 (+0.027), gitdone 0.415→0.425 (+0.010), aurora-mixed 0.545→0.553 (+0.008), multis 0.443→0.457 (+0.014) — with the fewest regressions (multis 2→**0**, aurora/mixed 3→2). The four-repo sweep makes the **overfitting cliff** explicit: additive@0.7 scores best on aurora alone (+0.044) yet drives multis **below baseline** (−0.024); the two non-tuning repos (gitdone, multis) both peak low. 6 added `node --test` tests (per-language extraction/resolution, intra-repo-only, incremental refresh/drop, the spreading value-behaviour, a `resolveImports` unit); a mutation check (disabling resolution) fails 5/6, confirming the tests have teeth.
  - **Limit — diminishing returns reached for graph-only recall (§4):** the four-repo weight sweep is the ceiling evidence. Fixing the fusion (convex→additive) recovered ~0.008–0.014 and erased regressions, but past additive@0.3 every knob is a *seesaw* (aurora gains trade directly against multis/gitdone losses), and one regression mode is **irreducible**: a genuinely poorly-connected true answer (gitdone `classifier`) is demoted by *any* graph prior under *every* fusion/weight — it is the intrinsic cost of trusting the graph, not a tunable. **Conclusion: 1-hop import-spreading is at its robust optimum.** Further recall gains do not come from graph tuning (more hops dilute; call edges don't help recall, Step-0 POC); they come from the **deferred tiers** — embeddings/semantic (the dual≈85%→tri≈95% step) and access-log base-level activation. Those are separate tiers, not more squeezing of this signal.
- **Slice 3 — kind-scoped recall (the code-over-md fix, §5):** `recall` is now scoped by memory `kind`, and **kinds never share a ranking** — each kind is FTS-gated and BM25-ranked only against its own kind, in a separate query, so high-volume prose can never bury code. Three modes: a single `kind:"code"` → flat `Hit[]` (default `n=10`); multiple `kind:["code","doc"]` or omitted → grouped `{ code, doc }` per kind (default `n=5` each, the safe CLI/agent default); `n` caps per kind, raise to dig deeper. New `KINDS` export is the canonical vocabulary. **This replaces AURORA's per-kind hybrid *weights*** — those need ≥2 signals to be principled and degenerate to a forbidden md-penalty constant under BM25 alone; the structural fix needs no weights, no calibration, and can't drift with a repo's doc/code ratio (AURORA's ~26k lines of md overpowered code). Also lands the **code-aware FTS body** (`tokenize.indexBody`: identifier-split camelCase supplement + symbol names folded in; body-text construction moved out of `store` per seam rule 1). 6 added `node --test` tests pin the three modes, the per-kind `n` depth, and the core invariant (a `kind:"code"` result can never contain a doc). New `poc/datasets/aurora-mixed.mjs` gate: indexing aurora's 497 `.py` **with** its 196 `.md` docs and recalling `kind:"code"` **holds the py-only baseline** (MRR 0.525 → 0.545) where a shared ranking dropped it to 0.480 with 12/22 queries prose-buried. The single-language benches stay within noise of the slice-2 baseline (aurora 0.523→0.525; gitdone 0.416→0.415).
- **`litectx.context.md` — adopter contract** (LIBRARY_CONVENTIONS §3): the complete integration reference — every `LiteCtxConfig` option, the full public API (`index`/`recall`/`size`/`close` + `Store`/tokenizer exports), the `nodes` substrate, the "what's NOT in litectx and why" refusals, gotchas, and constraints. Grounded in what's **actually shipped** (slices 0–2) with the roadmap surface (`impact`, activation, edges, embeddings) explicitly marked 🚧. Ships in the tarball (closes the prior `files[]` whitelist gap — 20 → 21 files).
- **Slice 2 — tree-sitter symbol chunking (dual-grain):** code files split into function/method/class chunks (`langdef` registry + `chunker`, tree-sitter WASM) and markdown into heading sections, persisted to a new `nodes` table with line ranges. **Dual-grain, not a replacement** — the POC showed pure chunk-BM25 *regressed* the file-target gate (aurora MRR 0.523→0.434; every pooling lost), so the file-level FTS index stays the recall gate (bench holds **exactly**: aurora 0.523/64%, gitdone 0.416/45%) and the symbol chunks land alongside as the substrate slices 4–5 ride on. Binding: `web-tree-sitter` pinned `0.22.6` with the 3 grammars **vendored** under `src/grammars/` (~3.4 MB, Unlicense) — native tree-sitter was ~3× slower for this walk-heavy workload, identical output. `index()` is now **async**. +1 prod dep (`web-tree-sitter`, 292 KB). 6 added `node --test` integration tests (python/md chunking, fallbacks, `nodes` population, incremental replace/delete).
- **Slice 1 — incremental indexing + hardened schema:** `index()` is now incremental and git-aware — it re-reads only files whose content changed (fast skip on `(mtime, size)`, `content_hash` as the arbiter via a new `file_index` table) and drops files that disappeared; returns `{ files, added, updated, removed, unchanged }`. `index({ force })` rebuilds; `index({ paths })` scopes a pass without deleting outside it. `kind`/`format` are first-class columns on every row (format routed by extension: ts/js/py/md); recall hits carry both. CLI `index` reports the change breakdown and takes `--force`. 8 added `node --test` integration tests (incremental, deletion, size-guard, force, kind/format). Recall path unchanged — bench holds the slice-0 baseline exactly on both repos.
- **Slice 0 — walking skeleton:** `src/` library (`LiteCtx` index/recall, FTS5 `Store`, extension-routed git-aware indexer, code-aware tokenizer) + thin CLI `bin/litectx.js`. File-granularity, plain BM25. Pure ESM + JSDoc→`.d.ts` (typecheck clean); one prod dep (`better-sqlite3`); 6 `node --test` integration tests.
- Integration gate `poc/bench-lib.mjs` (`npm run bench`) — runs the real library on both repos so lib and gate can't drift. Slice-0 baseline: aurora MRR 0.523 / gitdone MRR 0.416.
- POC gate harness (`poc/`, throwaway) — dataset-driven recall benchmark over two repos (aurora Py / gitdone JS), four ablation rankers, MRR/P@k reporting. Results in `poc/RESULTS.md`.
- `CLAUDE.md` build doctrine pointing at `.claude/memory/{AGENT_RULES,LIBRARY_CONVENTIONS}.md`.

### Decided
- **Slice-4 Step-0 POC reshaped the remaining slices** (PRD §4/§11.2/§14 #1, `poc/RESULTS.md`). Two throwaway harnesses (`poc/activation-poc.mjs`, `poc/spreading-poc.mjs`), run before building, settled what earns ranking weight:
  - **Base-level (git-seeded) activation does NOT earn v1 ranking weight — not even with decay+churn.** The "missing half" (type-decay + churn) failed to rescue it; it made gitdone *worse* (churn penalizes *stale* high-churn files, but the failure mode is *recently*-churned ones). Root cause: base-level needs a real **access log**, which v1 lacks — git gives *edit* frequency, not *access* frequency. **Deferred to the access-log tier** (litectx's long-running-memory differentiator; `activations` table schema-reserved). It re-derives aurora's own structure (git seeds activation + is displayed raw; the scored term rides a real access log).
  - **Git → passive activity metadata** (commit count + last-modified, file-level `git log`, no per-block blame) shown alongside hits as grounding, **not a scored term**.
  - **Spreading is the v1 ranking win** (+0.028 aurora / +0.021 gitdone, holds on both) — **promoted to the next ranking slice**, and it rides **import** edges. **Call edges do not help recall** (repo-dependent: great aurora, −gitdone) under a noisy proxy — they keep their job in the **impact** view, not recall (re-test calls-in-recall only with the precise extractor).
  - **v1 default ranking = BM25 + spreading(imports).** Semantic = embeddings tier (opt-in; semantic and embeddings are the same thing). Context-boost folds into BM25 (symbol names already indexed in slice 3).
- **Impact-view safety contract + LSP/ripgrep carve-out** (PRD §7, governing): litectx replaces the *questions* you'd ask an LSP (calling / called-by / imports-connectivity / refs→risk / complexity / dead-code), not the LSP — `get_definition`/`hover`/`lint`/precise-binding are out. Detection (tree-sitter) is ~99%; resolution is the gap and is biased to **over-count by design**. The governing invariant: **over-counting connectivity is safe (errs cautious), under-counting is dangerous** (a false "isolated" breaks hidden consumers) — so litectx may overstate connectivity but never understates it silently, and "isolated / unused / low-risk" only ships as a hedged review candidate. Anti-false-isolation mitigations sorted by danger×incidence×testability (gate repos exercise only reflection): entry/export roots + reflection flag + string-literal mention check = build now; barrel transitivity deferred; tsconfig path-aliases specced but gated on adding a TS fixture (POC-first). Universal net: unresolved refs are recorded `unresolved`, never `absent`.
- **Build methodology** (PRD §11.1): walking skeleton + vertical slices, integrated as they land; the multi-repo harness is the always-green integration gate; aurora is a second opinion, not an oracle.
- **Packaging** (PRD §14 #5): core library + in-repo CLI; MCP and graph-views are separate downstream consumers.

### Next
- **Slice 5 is complete** (5a impact view + bench gate; 5b barrel/alias false-isolation + the TS gate), the **composing-scenario test** pins recall + impact sharing one graph, and the foundation is now **hardened**: CI exists (`ci.yml`/`publish.yml`) and both view gates are asserted (recall MRR floor; impact §7.2 exit codes). The recall + impact views over one graph are the v1 surface, now CI-gated. Candidate next steps (none yet sequenced): expanding the audited impact label sets; or opening the **post-v1 tiers** (opt-in embeddings; the access-log base-level activation differentiator). Multi-hop barrel transitivity and Python re-export (`from x import y as z`) barrels remain noted single-hop gaps in 5b.

## [0.0.1] — 2026-06-04

### Added
- Initial placeholder release to reserve the `litectx` name on npm.
