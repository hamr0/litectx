# litectx — Product Requirements Document (PRD, DRAFT)

> A standalone, **lite, local-first code-aware memory engine** for AI coding agents:
> it indexes a repository (code + docs) into a queryable **code+context graph** and serves
> two read-views over it — **recall** (ranked search) and **impact** (blast-radius / risk).
> Published as an importable **npm library** (Node; pure ESM JS + JSDoc). It is the realization of
> the "context economy" axis sketched in [`barecontext-prd.md`](barecontext-prd.md),
> rebuilt from the lessons of the AURORA engine (`~/PycharmProjects/aurora`).
>
> **Not part of the "bare" suite.** litectx is a real ~3–4k-LOC library, not a ≤150-LOC
> primitive — so it does not wear the "bare" mark. It is a standalone library the bare
> suite *consumes* (§10). Its discipline is *lite / local-first / no-service /
> deterministic-core / optional-tiers*.
>
> **New home (DECIDED):** this PRD and [`barecontext-prd.md`](barecontext-prd.md) both
> **move to the new `litectx` repo once settled.** They incubate here only until then; the
> bareguard repo retains only the boundary reference it needs (bareguard ↔ litectx, §10).
>
> **Governing rules:** `.claude/memory/AGENT_RULES.md` — POC-first, dependency hierarchy
> (vanilla → stdlib → external), lightweight-over-complex, open-source-only, every line
> earns its place, Testing Trophy. **Language: pure ESM JS + JSDoc, no build step**
> (`LIBRARY_CONVENTIONS.md` §1); TypeScript is dev-only — `tsc` checks JSDoc and *generates*
> the shipped `.d.ts`. Any "TypeScript source" phrasing is stale and overridden.
>
> **Single source of truth (DECIDED).** This PRD is the one authority for the **memory engine**
> (the aurora-borrowed code+context memory: index · recall · impact · graph). Every decision,
> scope line, and build-order call lives here or is *referenced* from here. The companions are
> subordinate, never competing authorities:
>
> | Doc | Role |
> |---|---|
> | **`litectx-memory-prd.md`** (this) | the authority — decisions, scope, build order, module map (§2.1) |
> | `docs/02-engineering/aurora-borrow-ledger.md` | calibration **appendix** — exact constants + aurora `file:line`; referenced, not duplicated |
> | `docs/01-product/litectx-ce-prd.md` | the **other half** (CE primitives) — a *separate, still-forming* track, **not** part of this memory-engine build |
> | `barecontext-prd.md` | **superseded** — folded into this line of work |
> | `.claude/stash/*`, `CLAUDE.md` | session history / doctrine — never source of truth |
>
> When this PRD and a companion disagree about the memory engine, **this PRD wins**; fix the
> companion. (CE scope is governed separately until it graduates into a build.)
>
> Status legend: **DRAFT** (this doc), **DECIDED** (settled, do not relitigate),
> **POC-GATED** (build only after the POC in §11 passes), **DEFERRED** (post-v1),
> **NON-GOAL** (explicitly out of scope).

---

## 0. TL;DR

- **What:** a lite, local-first library that indexes a codebase + its docs into a
  **code+context graph** and ranks/relates that graph with **ACT-R cognitive activation**.
- **Two user-facing views over one graph:**
  1. **recall** — "given a query (or the current file), return the most relevant
     chunks," ranked by BM25 + ACT-R activation (embeddings optional).
  2. **impact** — "if I change this symbol/file, what's the blast radius?" — called-by /
     calling edges → affected files + a **risk bucket** (low/med/high).
- **The graph is the product.** recall and impact are *views*; the typed node+edge graph
  is public API, so **codegraph** and **contextgraph** (§9) can be built on top later at
  near-zero marginal cost.
- **Node `kind` is first-class from day one** (§3.1): v1 implements `code` and `doc` (md);
  the schema *reserves* `fact`, `episode`, and other doc formats so the engine can grow
  into a general short/long-term ACT-R memory without migration.
- **Name:** `litectx` (npm-free) — "lite context."
- **v1 languages:** TypeScript, JavaScript, Python (routed by file extension).
- **Stack:** Node, pure **ESM JS + JSDoc** (no build step), `better-sqlite3` + FTS5, `web-tree-sitter`, `ripgrep`. **Zero
  external binaries required.** Embeddings are the one opt-in tier.
- **Edges/impact:** tree-sitter + `ripgrep -w` only — **no LSP server, ever** (§7).
- **Method:** *borrow, don't port* — reimplement AURORA's validated algorithms in clean ESM JS.

---

## 1. Why this exists

AI coding agents re-discover the same codebase every session — grep, read, lose the
thread, forget last turn. They also edit blindly, changing a function without knowing what
calls it. litectx gives an agent a **persistent, ranked, relationship-aware memory of the
code** and a **blast-radius signal before it edits**, both computed locally, with no
service and no required ML.

AURORA (`~/PycharmProjects/aurora`, Python) proved the core works. litectx extracts the
**validated kernel** — ACT-R activation, the edge graph, block-level git signals,
tree-sitter chunking, code-aware BM25 — and leaves behind the LLM orchestration
(`soar`/`reasoning`/`spawner`/`cli`, ~50k LOC) a harness already does. The most valuable
carry-over is not code but **calibration** (§12).

---

## 2. Scope — one substrate, two views (DECIDED)

The core deliverable is a **code+context graph**:

- **Nodes** — typed context units (see §3.1 for `kind`): code chunks
  (function/method/class, with name/signature/docstring/line-range) and doc chunks (md
  sections) in v1.
- **Edges** — typed relationships: `calls`, `imports`, `depends_on` (extensible).
- **Per-node signals** — git (block-level commits/recency), activation (access
  count/recency), AST complexity.

Over that one graph, v1 ships **two views**:

| View | Question it answers | Primary inputs |
|---|---|---|
| **recall** | "what's most relevant to *this*?" | FTS5/BM25 + ACT-R activation (+ optional embeddings) |
| **impact** | "if I change *this*, what breaks and how risky?" | call/import edges → reference count → risk bucket |

**Why this framing is load-bearing:** the graph is exposed as first-class public API, so
the future `codegraph`/`contextgraph` (§9) are *additional views over the same data*, not
re-extractions. Build "a search function" instead and you pay for the graph twice.

### 2.1 Module architecture (the memory engine) — one substrate, scorers, views

The engine decomposes into small ESM modules with a strict dependency DAG (no cycles). Each maps
to a build slice (§11.2) and to the calibration sections of the borrow ledger. *Slices ≠ modules:*
a slice adds a capability over time; the modules below are the code units it lands in.

| Module | Role | State | Slice / ledger |
|---|---|---|---|
| `store` | SQLite/FTS5, pragmas, all SQL, tables, `getNode`/`related` | ✅ | §9 · ledger §12 |
| `indexer` | pass orchestration: collect + incremental diff + dispatch | ✅ | §6 · slices 0–1 |
| `langdef` | per-language registry (`defTypes` per ext; `call_node_type`/`skip_names`/`.scm` to come with edges) | ✅ (grammar+defTypes) | slice 2 · ledger §11 |
| `chunker` | file → tree-sitter (code) / section (md) chunks + line ranges → `nodes` | ✅ | slice 2 |
| `gitsig` | file-level blame cache, slice per range → commit count+recency | new | slice 4 · ledger §8/§12 |
| `edges` | symbol table → `calls` + `imports` edges | new | slice 5 · ledger §11 |
| `tokenize` | code-aware BM25 body (`indexBody`: split + path + symbol names) + query match | ✅ (deps deferred) | slice 3 · ledger §1 |
| `activation` | ACT-R **pure fns**: BLA · decay(type+churn) · spreading · boost · total · norm | new | slice 4 · ledger §2–6 |
| `recall` | **kind-scoped** FTS gate → per-kind rank (→ +activation slice 4) | ✅ (kind-scoped; hybrid in slice 4) | slice 3 · ledger §7 |
| `impact` | refs/files → risk bucket + complexity | new | slice 6 · ledger §9 |
| `embeddings` | semantic tier (sqlite-vec/ONNX), off by default | tier | §8 · ledger §11/§12 |
| `LiteCtx` | facade: config + wiring | ✅ | §3 |

**Seam rules (do not violate):**
1. **`store` persists FTS content, never builds it** — code-aware body text is `tokenize`'s job
   (✅ slice 3: `store.applyChanges` now calls `tokenize.indexBody`).
2. **One `langdef` registry** — `chunker`, `edges`, and complexity all read it; never fork it
   per-slice (`.scm` for chunking + node-type config for edges hang off the same module).
3. **`activation` stays pure** — functions of already-extracted signals, so the bench can ablate
   each term (the POC's "BLA doesn't generalize" was a half-formula artifact, not a finding).
4. **`recall` is its own module, not the facade** — fusion weights / normalization / the
   tri→dual→activation fallback chain don't belong in `LiteCtx`.

Don't pre-create empty modules — `gitsig`/`edges`/`impact` land with their slices.

---

## 3. Public API (DRAFT shape)

One importable surface; one config object; safe defaults; everything advanced is opt-in.

```js
import { LiteCtx } from "litectx";

const lc = new LiteCtx({ root: "/path/to/repo" /*, ...LiteCtxConfig */ });

await lc.index();                       // incremental, git-aware (§6)
await lc.index({ paths: ["src/"] });

// view 1 — recall (kind-scoped; kinds never share a ranking — §5)
const code = lc.recall("how does auth work", { kind: "code" });     // flat Hit[], default n=10
const both = lc.recall("how does auth work");                       // grouped { code:[…5], doc:[…5] }
const more = lc.recall("how does auth work", { kind: "code", n: 30 }); // dig deeper
// Hit → { path, kind, format, score }  (signals{activation,semantic,git} arrive in slices 4–5)

// view 2 — impact
const blast = await lc.impact({ file: "src/auth.ts", line: 42 });
// → { symbol, usedBy:{refs, files}, risk:"low"|"med"|"high", complexity, callers, callees }

// the substrate itself (foundation for codegraph/contextgraph)
const node = await lc.getNode(id);
const related = await lc.related(id, { edge: "calls", hops: 1 });
```

`LiteCtxConfig` (one object, all optional): activation preset/weights, hybrid weights,
embeddings on/off + provider, ignore patterns, db path, enabled kinds.

### 3.1 Node kinds (memory types) — first-class from day one (DECIDED)

AURORA shipped a fixed `code | kb | doc | reas` set keyed by extension
(`core/.../chunk_types.py`). litectx generalizes this into an **open `kind` discriminator
present in the schema from day one**, because the engine is meant to grow into a general
ACT-R memory (short- and long-term), not just a code index.

| `kind` | v1? | What | Chunker |
|---|---|---|---|
| `code` | ✅ v1 | AST chunks (function/method/class) | tree-sitter |
| `doc` | ✅ v1 (**md only**) | human docs; markdown sections | section-aware md chunker |
| `fact` | reserved | semantic memory — asserted/extracted facts | (future) |
| `episode` | reserved | episodic memory — session events/observations | (future) |

Design rules (DECIDED):
- **Doc *formats* are a `format` field under `kind=doc`** (`md` in v1; `pdf`/`docx`/`txt`
  later), **not** new top-level kinds — so adding PDF support never migrates the schema.
- **PDF/DOCX deferred** (DEFERRED): markdown is a trivial local chunker; PDF/DOCX need
  extraction libraries (heavier, less local-first-clean) → a future `doc` format tier.
  **v1 sticks to md**, but the schema + decay map are ready for the rest.
- **Type-specific decay (§4) is keyed by `kind`** — adding a kind = add a decay rate + a
  chunker; no schema change. ACT-R applies uniformly across kinds, which is precisely how
  long/short-term doc memory lands later.

---

## 4. Activation — the differentiator (DECIDED algorithm; params tunable)

> **What we expect from litectx's memory (recalibrated 2026-06-04).** The "memory" is not
> search — it is an **ACT-R activation layer over the graph** that models which chunks are
> *cognitively hot*: frequently/recently touched (**BLA**), structurally central (**spreading**
> over edges), query-relevant (**context boost**), and stable-vs-volatile **by `kind`**
> (type-decay + churn). v1 has no access log, so memory is **seeded from git history**
> (cold-start BLA over commit timestamps, §4.1) — the repo's own change history is the proxy for
> "what's been worked on." **The bar:** dual-hybrid (BM25 + activation) must measurably beat
> plain BM25 on the multi-repo gate — the POC confirmed **graph spreading generalizes**; BLA
> earns weight only as the **full** formula (type-decay + churn, not the recency half) and only
> if it holds on both repos. Embeddings stay an **optional tier** (dual ≈85% vs tri ≈95% — not
> worth the cold-start + ML dep by default). The activation engine is **kind-agnostic** — the
> same math will ratchet `fact`/`episode` memory later; code is just v1's content.

ACT-R total activation, reimplemented in JS (grounding: aurora `activation/*`,
`docs/02-engineering/aurora-borrow-ledger.md`):

```
A = BLA + Σ_j (W_j · F^hop_ij) + ContextBoost − Decay
```

- **BLA (base-level)** — `ln(Σ_j t_j^-d)` over access history, `d=0.5` default.
- **Spreading** — BFS over edges, `F=0.7`/hop, max 3 hops.
- **Context boost** — query↔chunk keyword overlap, `boost=0.5`.
- **Decay** — `−d_kind · log10(days_since_access)`, **1-hour grace**, capped at **90d**,
  floored at `−2.0` (aurora-verified; see borrow ledger).
- **Type-specific decay** (keyed by **`(kind, format)`**) — markdown (`kind=doc, format=md`)
  `0.05`, class `0.20`, function/method/`code` `0.40`, toc-entry `0.01`; pdf/docx `0.02`
  (reserved). Markdown decays ~8× slower than functions. ⚠️ **aurora tuned _markdown_ at `0.05`**
  — its `0.02` rate was for paginated pdf/docx; do **not** apply `0.02` to md (ledger §3/§10).
- **Churn factor** — `0.1 · log10(commits+1)` added to decay (volatile code decays faster).
- **MMR diversity rerank** (optional) — needs embeddings; off by default.

Ship AURORA's 5 presets as config presets. All formulas are pure functions → near-verbatim
JS port, unit-testable. **Every constant above is source-verified in
`docs/02-engineering/aurora-borrow-ledger.md` (aurora `@ 750a39d`)** — that ledger, not this
summary, is the calibration source of truth; start at aurora's tested defaults, re-validate any
change on both repos before it earns weight.

### 4.1 Cold-start ranking — solved cleanly with git as the prior (DECIDED design)

At first index there is no access history, so a naive BLA would zero out everything and
recall would collapse to keyword-only. **AURORA already solved this the way we want** —
`git.py:calculate_bla(commit_times, decay=0.5)` applies the *same* `ln(Σ t_j^-d)` to a chunk's
git commit timestamps (fallback `0.5` when untracked); commit recency → recency, commit count →
frequency. So this is **borrowed, not invented**: litectx carries that unified single-formula
approach with **safe defaults**:

1. **Never-accessed is neutral, not punished** — empty access history ⇒ BLA `= 0` (not
   `−∞`); decay `= 0` when `last_access` is null or within grace. No chunk is penalized for
   being freshly indexed.
2. **Git provides the positive prior** — recently/often-committed chunks should outrank
   stale ones on day one. **Recommended unification (validate in POC):** *seed the BLA
   access-history with the chunk's git commit timestamps as pseudo-accesses.* Then the same
   `ln(Σ t_j^-d)` naturally bootstraps cold-start — commit **recency → recency term**,
   commit **count → frequency** — and real accesses simply append more terms over time. One
   formula instead of two BLAs; "git was good for first index" falls out for free.
3. **First-index ranking is therefore** git-prior + context-boost (query match) + spreading
   (edges) − (neutralized) decay → code and docs surface immediately on relevance + recency.

---

## 5. Retrieval pipeline + the code-over-md fix (DECIDED — reshaped in slice 3)

Two-stage (grounding: `hybrid_retriever.py`, `MEM_INDEXING.md §Hybrid`):

1. **FTS5 keyword gate** — SQLite FTS5 BM25 → top ~N candidates **per kind**.
2. **Kind-scoped ranking** → BM25 now; activation (slice 4) and semantic (embeddings tier)
   layer in **within a kind**, never across:
   - **code**: BM25 → +activation 30% / semantic 20% as they land.
   - **doc/kb**: BM25 → +activation / semantic (prose benefits more from embeddings).

**Code-over-md — solved structurally by kind-scoping, NOT by weights (slice 3 decision).**
The bug: prose-heavy md out-surfaced code because a query term is *mentioned* more in prose.
AURORA's fix was per-kind hybrid **weights** (`hybrid_retriever.py`) — but that only works
once ≥2 signals exist (in dual-hybrid, code leans BM25 0.625 / doc balances BM25 0.5 with
activation); **with BM25 as the only signal it degenerates to a tuned md-penalty constant**,
which the doctrine forbids. Worse, any *shared* ranking is hostage to the doc/code volume
ratio (AURORA had ~26k lines of md that overpowered code) — a calibration that can't
generalize across repos.

litectx's fix removes the shared ranking entirely:

> **Invariant: kinds never share a ranking.** `recall` is kind-scoped — one FTS query per
> kind, each BM25-ranked only against its own kind. A `kind:"code"` result can never contain
> a doc, no matter how prose-heavy the index. No weights, no md penalty, no calibration.

This matches how a long-running agent queries memory — it knows its intent (`code` /
`fact` / `episode`), so a required `kind` makes that intent explicit. Three modes: single
kind → flat list (default `n=10`); multiple, or omitted → grouped per kind (default `n=5`
each, the safe CLI/agent default); `n` caps per kind, raise to dig deeper.

**Validated (slice 3, `poc/datasets/aurora-mixed.mjs`):** indexing aurora's 497 `.py` *with*
its 196 `.md` design docs and recalling `kind:"code"` **holds — and slightly beats — the
py-only baseline** (MRR 0.525 → 0.545 — md in the corpus even sharpens code IDF) where a shared ranking dropped
it to 0.480 with **12/22 queries** prose-buried. The two surviving structural mechanisms:
1. **FTS5 gate per kind** so rare-but-relevant code isn't starved.
2. **Code-aware FTS body** (slice 3, `tokenize.indexBody`): identifier-split supplement
   (`getUserData → get user data`) + symbol names folded in, so a descriptive query matches
   identifier-dense code. (AURORA lesson: sparse content → descriptive queries return 0.)
   *Deps + `k1/b` tuning deferred — neutral on the bench, and deps ride slice-5 edge extraction.*

---

## 6. Indexing (DECIDED)

Grounding: `MEM_INDEXING.md`.

- **Route by file extension, everywhere** (DECIDED): extension → `kind` → parser → edge
  config. **Never** sniff language by content/shebang.
- **Index code + markdown**, incremental re-index.
- **Change detection** (fast→slow): `(mtime, size)` → content-hash (sha256); skips ~95% of
  files on re-index. Track in `file_index(path, content_hash, mtime, size, indexed_at)`. (A
  git-status pre-filter tier is deferred — `(mtime, size)` already meets the skip goal; §11.2.)
- **Block-level git signals** (DIFFERENTIATOR): `git blame --line-porcelain` → commit
  count + recency **per chunk line-range**, not per file — feeds churn, cold-start BLA
  (§4.1), and the output schema.
- **Ignore**: `.git`, `node_modules`, `__pycache__`, `.venv`, `dist`, `build`, plus a
  `.litectxignore` (gitignore syntax).

---

## 7. Edges & the impact view — ripgrep only, no LSP (DECIDED)

The decision is final: **there is no language-server tier.** Grounding: `LSP.md`,
`MEM_INDEXING.md §Adding a Language`.

- **The one and only edge resolver = tree-sitter queries + `ripgrep -w`** (word-boundary).
  Zero external binaries; ~2ms/symbol; deterministic. (AURORA measured LSP ~300ms/symbol
  and itself fell back to `rg -w`; in Node there is no multilspy and hand-driving servers
  over `vscode-jsonrpc` is fragile — explicitly rejected.)
- **Accuracy comes from the language definition, not a server.** Per language we author the
  tree-sitter query set + edge-semantics config (`function_def_types`, `call_node_type`,
  `skip_names`, framework-callback names so `bot.on('msg', handler)` isn't seen as dead).
  This is the knowledge that makes ripgrep edges accurate; the goal is the **best-possible
  blast radius via lang def.**
- **Two edge types, both required (ledger §11):** `calls` (symbol→symbol) powers called-by /
  calling + the symbol blast radius; `imports` (file→file, from tree-sitter import nodes) powers
  file connectivity (aurora's `get_imported_by`). Shipping only `calls` misses file-level impact.
- **Dead-code is a free *candidate* signal, never a verdict:** once both edge types exist,
  `0 callers ∧ 0 importers` is inverse impact — surfaced as a **review candidate, not "safe to
  delete"** (aurora fast mode ~85%; over-count bias errs toward false negatives, the safe
  direction; exports / entry-points / framework callbacks are roots). Ledger §11.
- **Adequacy for the goal:** `impact` outputs a **risk bucket** (0–2 low / 3–10 med / 11+
  high). Ripgrep *over*-counts (comments/strings) → errs toward caution, which is fine for
  bucketing. (Precise import-vs-usage separation — an LSP-only capability — is a NON-GOAL,
  §13.)

**Two distinct signals — do not conflate:**
- **complexity** = cyclomatic-ish AST branch count *inside* a chunk (local property).
- **risk/impact** = *reference count* from the call graph (blast radius).

Per-language edge config is the bulk of "adding a language" — budget ~1–2 days/language.

---

## 8. Tiers & defaults (DECIDED)

| Capability | Default | Tier (opt-in) | Rationale |
|---|---|---|---|
| BM25 + ACT-R recall | **on** | — | the lite core; zero ML |
| Block-level git signals | **on** | — | cheap, high-value |
| tree-sitter + ripgrep edges | **on** | — | zero external binaries; sole edge resolver |
| Embeddings (semantic) + MMR | **off** | `@xenova/transformers` (ONNX) and/or `sqlite-vec` | +10% quality but +ML dep and 15–19s cold latency |

Embeddings are the **only** tier. There is no LSP tier (§7).

---

## 9. Storage (DECIDED — closed question)

- **`better-sqlite3` + FTS5.** Single file, synchronous (no connection-pool tax — deletes
  ~330 LOC of AURORA's Python), FTS5 gives BM25 natively in SQL. Correct and final for a
  local-first lib; **"change if something better" is resolved: no.**
- **Vectors (embeddings tier only):** `sqlite-vec` extension or a `float32` BLOB column —
  inside the one SQLite file; no second datastore.
- Tables (from AURORA, slimmed): `chunks` (incl. `kind`, `format`), `relationships` (edges,
  indexed both ends), `activations` (reserved — v1 has no access log; git seeds BLA, §4.1),
  `file_index`.

---

## 10. Relationship to the bare suite

```
   bareagent  ── agent loop runner ──┐
        │                            ├─ may use → litectx  (code-aware memory; THIS doc)
        ▼                            │
   bareguard  ── policy + audit (the governance floor)
```

litectx is **orthogonal to bareguard**: it never touches token budgets, allowlists, or
content-judgment (bareguard/harness concerns — §13). It is a leaf-ish local library a
runner *uses*. The `barecontext-prd.md` boundary table now reads bareguard ↔ litectx; that
single reference is what bareguard's repo keeps after this doc relocates (banner, §0).

---

## 11. Build order & the POC gate (per AGENT_RULES — POC-first)

**POC (do first, stupidly simple, no tests):** `better-sqlite3` + FTS5 (BM25) + a hand-coded
ACT-R base-level decay + git-seeded cold-start (§4.1) + a few hardcoded edges + one-hop
spreading, over one sample repo. **The one hypothesis to kill or confirm:** *does
activation-weighted, graph-aware recall measurably beat plain FTS5/BM25?*

- **POC passes** → build v1 properly (below), with tests.
- **POC fails** (BM25-alone ≈ as good) → stop; re-scope to a thin BM25 index.

> **POC RESULT (2026-06-04 — PASS for graph-aware recall).** Ran on **two repos** — aurora
> (Python, 497 files, 22 queries) and gitdone (JS/CJS, 100 files, 20 queries). Harness + full
> writeup in `poc/` (`RESULTS.md`). The ablation separates the signals cleanly:
> - **Graph spreading generalizes and is the real win** — positive on *both* repos and every
>   breakdown, never hurts an aggregate (aurora HARD ΔMRR +0.050; gitdone HARD P@3 50% → 70%).
> - **Git-seeded BLA at a flat 0.3 weight does NOT generalize** — looked like a win on aurora
>   (driven by hot-file/easy queries) but is **net-negative on gitdone** (ALL −0.030), and the
>   combined preset **loses to plain BM25 on gitdone** (−0.067). Cause: recency half of ACT-R
>   shipped without the churn/decay half, so "recently changed" reads as "relevant" — and how
>   well that holds is repo-dependent.
>
> → **Build v1: ship the graph substrate + spreading. Rework the activation/cold-start term
> before it gets real weight** — implement decay+churn, demote BLA to a small term/tiebreaker,
> and re-validate on *both* repos (adopt only weights ≥ baseline on every repo). The dataset-driven
> `poc/` harness is kept as the multi-repo calibration gate (§4.1, §14 #1).

### 11.1 Build methodology — walking skeleton + vertical slices (DECIDED)

How we build matters as much as what. Hard-won constraint: a prior project was built as ~5500
heavy-TDD **unit** tests across modules that were never wired together — green coverage, nothing
ran, huge cleanup. That is the failure mode we engineer against. Rules:

- **Walking skeleton first.** Slice 0 is the thinnest end-to-end pipeline that *actually runs*
  (index → store → `recall` returns hits). The system is connected from the first commit.
- **Vertical slices, one capability at a time.** Each slice adds one capability to the
  already-running pipeline and is integrated **as it lands** — never build modules in isolation
  and wire them up at the end (that re-creates the failure above; "microservices built apart" is
  the same trap with bigger boundaries — litectx is one library with clean seams, not services).
- **"Works by itself" = observable end-to-end behavior, not isolated unit tests.** A slice is done
  when it runs through the whole pipeline, holds-or-beats the benchmark, and has its tests.
- **The `poc/` multi-repo labeled-query harness is the always-green integration gate.** Every
  slice must hold-or-beat its MRR/P@k on **both** repos before the next slice starts. The harness —
  not unit-test count — defines "done." It is also the calibration gate for any weight/signal change.
- **Tests per slice, after its design stabilizes** (per AGENT_RULES testing trophy): integration-
  first against `:memory:` SQLite + a tmp repo, <60% mocking, behavior not implementation; every
  bug fix adds a regression test. Do **not** front-load unit tests against an unstable design.
- **Aurora is a second opinion, not an oracle.** We borrow the *concept*, not the *output*; aurora
  may be bloated/wrong on a given approach (that's *why* we reimplement and simplify). A litectx↔
  aurora divergence is a **question to investigate, not a bug to fix toward aurora.** Cross-check is
  **manual and as-needed** (e.g. a signal misbehaving) — never a CI dependency (heavy Python env).

**Definition of done — one slice = one module (§2.1), three gates, then the next.** A slice adds
exactly one module from the module DAG and is not "done" (and the next slice may not start) until
**all three pass**:

1. **Behavior** — `npm run bench` **holds-or-beats** the baseline MRR/P@k on **both** repos
   (aurora + gitdone). Any new weight/signal is adopted only if it is ≥ baseline on *every* repo.
2. **Types** — `tsc --noEmit` (`checkJs` + `strictNullChecks`) is clean; the generated `.d.ts`
   stays in sync (no `!`, `as any`, or `@ts-ignore`).
3. **Tests** — integration-first against `:memory:` SQLite + a tmp repo (<60% mocking, behavior
   not implementation); every bug fix ships a regression test.

This is the guard against the 5500-dead-unit-tests failure mode: a module proves itself
end-to-end before the next one exists, so nothing is built apart and wired up later.

### 11.2 v1 build slices (after POC graduates)

- **Slice 0 — walking skeleton ✅ SHIPPED** (2026-06-04): index files → SQLite (FTS5) →
  `litectx recall "query"` returns ranked hits. **Plain BM25, file-granularity.** Real `src/`
  (LiteCtx/Store/indexer/tokenizer) + thin CLI `bin/litectx.js`; pure ESM + JSDoc→`.d.ts`
  (typecheck clean); one prod dep (`better-sqlite3`); 6 `node --test` integration tests.
  Integration gate = `npm run bench` (`poc/bench-lib.mjs`, runs the **real library** so it can't
  drift from the harness). **Baseline to beat, both repos:** aurora ALL MRR 0.523 / P@3 64%;
  gitdone ALL MRR 0.416 / P@3 45%.
1. **✅ SHIPPED** (2026-06-04): Harden SQLite store + schema (`kind`/`format` first-class) +
   incremental git-aware indexing (§6). `index()` re-reads only changed files (fast skip on
   `(mtime, size)`, `content_hash` as arbiter via a `file_index` table) and drops deleted files;
   returns `{ files, added, updated, removed, unchanged }`; `force`/`paths` opts. Recall path
   untouched → bench holds the slice-0 baseline exactly on both repos. 14 `node --test` tests.
   (Git-status as an explicit pre-filter tier deferred — `(mtime, size)`+hash already meets the
   "skip ~95% on re-index" goal; the same-mtime/same-size content swap is the documented `--force`
   corner.)
2. **✅ SHIPPED** (2026-06-05): tree-sitter **symbol-level** chunking for **TS, JS, Python** +
   md section chunker → a `nodes` table (§3.1, §6). **DUAL-GRAIN, not a replacement** —
   corrected from the POC: pure chunk-BM25 *regressed* the file-target gate on both repos
   (aurora MRR 0.523→0.434; max/sum/top3 pooling all lost), because for *file*-finding whole-file
   BM25 is a strong baseline that sub-file chunks fragment. So the file-level FTS doc stays the
   recall gate (bench holds **exactly** — aurora 0.523/64%, gitdone 0.416/45%) and the line-ranged
   symbol chunks land *alongside* as the structural substrate that block git-blame (slice 4) and
   edges (slice 5) ride on. The recall jump the chunks enable arrives in slices 3–4, not here
   (POC: `poc/RESULTS.md` "Slice-2"). Binding: **web-tree-sitter (WASM)** pinned to `0.22.6`,
   grammars **vendored** under `src/grammars/` (py/js/ts, Unlicense) — native tree-sitter was ~3×
   *slower* for this walk-heavy workload with identical output (POC: `binding-bench`). **+1 prod
   dep** (`web-tree-sitter`, 292 KB runtime; grammars vendored, not depended) — justified: symbol
   chunking/edges are doctrine-mandated (ripgrep + tree-sitter only) and not doable in stdlib;
   `tree-sitter-wasms` (50 MB, all langs) was rejected for the 3 vendored grammars (~3.4 MB).
   `index()` is now **async** (the PRD §3 `await lc.index()` shape). 6 new tests.
3. ✅ **SHIPPED** — Kind-scoped recall = the code-over-md fix (§5). `recall` scoped by `kind`;
   **kinds never share a ranking** (one FTS query per kind, BM25 within-kind) → prose can't bury
   code, no weights/calibration. Three modes (single→flat n=10; multi/omitted→grouped n=5 each);
   `KINDS` export; code-aware `indexBody` (camelCase split + symbol names; seam rule 1). Replaces
   AURORA's per-kind hybrid *weights* — those need ≥2 signals and degenerate to a forbidden
   md-penalty under BM25-only. Gate `aurora-mixed` (py+md): `kind:"code"` holds 0.525→**0.545** vs
   0.480 shared-ranking (12/22 prose-buried). 6 new tests pin the invariant. (deps/`k1·b` deferred:
   neutral on bench; deps ride slice-5 edges.)
4. ACT-R activation engine + presets + cold-start (§4) → **recall view** ships. Per the POC:
   base-level → **decay+churn** → context-boost; **validate on both repos before BLA gets weight.**
   Spreading is scaffolded here but **earns weight in slice 5**, once real edges exist (the POC
   already proved it generalizes — it's the priority the moment edges land).
5. tree-sitter + ripgrep edge extraction + per-language semantics config (§7) → graph edges.
   **Both `calls` (symbol blast radius) and `imports` (file connectivity) — not calls alone (§7,
   ledger §11);** the dead-code candidate falls out as inverse impact.
6. **impact view** (reference count → risk bucket; complexity from AST) over the edges.

**Impact-view timing:** sequenced *after* recall because it depends on accurate edges
(step 5). If step 5 slips, recall ships as v1 and impact lands v1.1 — the graph substrate
makes that a clean cut, not a rework.

---

## 12. What to carry over from AURORA (borrow, don't port)

**Reimplement in clean ESM JS** (pure logic, near-verbatim): ACT-R formulas (§4), code-aware
BM25 tokenizer + `k1/b` (§5), two-stage retrieval + code-over-md fix (§5), 3-tier
incremental indexing (§6), block-level git-blame extraction (§6), per-language
edge-semantics config (§7), the `kind`-keyed type taxonomy (§3.1).

**Carry the calibration, not just the code:**
- dual-hybrid ≈ 85% vs tri-hybrid ≈ 95% → embeddings are a tier, not the spine.
- code-over-md is solved by **kind-scoping** (§5, slice 3), not a penalty hack and not weights:
  AURORA's per-kind hybrid weights need ≥2 signals to be principled and collapse to a forbidden
  md-penalty under BM25-only — and any shared ranking is hostage to the repo's doc/code volume
  ratio. litectx's lesson borrowed here is the *symptom* (prose buries code) and the *non-penalty
  doctrine*, not the weight mechanism.
- edges from ripgrep/lang-def, **not** tree-sitter's import-parsing (AURORA's
  `_identify_dependencies()` was a dead side-path — do not repeat).
- type-specific decay + churn parameters (§4) are tuned values worth keeping.
- BM25 content must include deps + file_path or descriptive queries return 0.

**Leave behind entirely:** `soar`/`reasoning`/`spawner`/`cli` (~50k LOC); and AURORA's
Python plumbing Node deletes for free — connection pooling, budget tracker, conversation
logging, metrics, retry handler, abstract multi-backend store; **and the entire `lsp`
package** (§7).

> **The actual tuned constants** (formulas + every coefficient, with aurora `file:line`
> provenance, mapped to the slice that consumes them) live in
> **`docs/02-engineering/aurora-borrow-ledger.md`** — the written borrow contract for slices 3–6.
> Source-verified; re-verify if aurora moves off `750a39d`.

---

## 13. Non-goals (NON-GOAL)

- **Any LSP / language-server integration** — ripgrep + lang-def only (§7). Implies
  import-vs-usage separation and *binding-precise* dead-code are out of scope. (litectx still
  ships a *candidate* dead-code signal via inverse impact — §7 — just not an LSP-grade verdict.)
- **Token budgeting / context-window trimming / compaction** — runner/harness concern.
- **Content guardrails** — secret/PII/injection scanning, policy enforcement — bareguard.
- **LLM orchestration / task decomposition / agent spawning** — AURORA's `soar`/`reasoning`.
- **Multi-provider LLM clients / embeddings-as-default** — provider-agnostic; ML is opt-in.
- **PDF/DOCX extraction in v1** — schema-reserved (§3.1), deferred.
- **A server / daemon / hosted service** — local library only.
- **Linting** — mature per-language linters exist; do not wrap them.
- **Being "bare"** — litectx is a real library, not a ≤150-LOC primitive.

---

## 14. Open questions (DRAFT — settle during build)

1. **Cold-start unification** — ~~does the git-commits-as-pseudo-accesses model (§4.1) hold up
   in the POC?~~ **POC-ANSWERED (two repos):** the unified `ln(Σ t^-d)` recency prior **does not
   generalize as a co-equal weight** — net-positive on aurora (hot-file queries) but net-negative
   on gitdone, where the combined preset lost to plain BM25. Resolution: keep the unified model but
   it is only valid **paired with decay+churn** (§4) and at a **small weight / tiebreaker**, not
   the 0.3 used in the POC. Adopt a weight only if it scores **≥ baseline on every repo** in the
   `poc/` multi-repo harness — one repo is provably not enough (aurora alone would have shipped a
   gitdone regression).
2. **MMR without embeddings** — cheap lexical/structural diversity proxy, or accept that MMR
   is embeddings-tier only? (Default: tier-only.)
3. **Edge types beyond `calls`/`imports`/`depends_on`** — add `inherits`/`defines` in v1 or
   defer? (Lean: defer; the three cover impact.)
4. **Access-history write path** — does litectx own "agent accessed chunk X" writes, or does
   the consumer report accesses? (Affects who drives BLA.)
5. **Consumption surfaces & graph-view packaging** — **RESOLVED.** The core is the **library**
   (mechanism). A **thin CLI ships in-repo** (`bin/`) from v1 — it serves humans, cron, and
   shell-out agents at near-zero cost, and matches house style. **MCP and the `codegraph`/
   `contextgraph` views are separate downstream consumers**, not core: they wrap the same public
   API and would otherwise break "lite / one prod dep / no service" (scope discipline — mechanism
   in the lib, policy in the adopter). MCP **stdio** is a client-spawned subprocess, not a daemon,
   so it stays compatible with the "no service tier" rule — it just lives in its own package
   (`litectx-mcp` or a bare-suite member) when a consumer needs it.
6. **`fact`/`episode` kinds** — what writes them, and do they share the code decay map or
   need their own? (§3.1; design when the first non-code memory need is real.)

---

## 15. Status: BUILDING v1 — slices 0–3 shipped

Discovery done; **POC passed** (§11, 2026-06-04; harness + writeup in `poc/`); **build underway**.
This doc lives in the `litectx` repo — name reserved as `litectx@0.0.1` on npm, Apache-2.0, public,
**slices 0–3 shipped** (walking skeleton · incremental git-aware indexing / hardened `kind`/`format`
schema · tree-sitter symbol chunking `nodes` substrate · **kind-scoped recall** = the code-over-md
fix; `src/` + CLI + tests + integration gate; §11.2). **DECIDED:** name, stack, storage, indexing,
edges-are-ripgrep-only, tiers, v1 languages, `kind`-from-day-one, **the code-over-md fix (slice 3:
kind-scoping, not weights)**, the cold-start design, packaging (§14 #5), and the build methodology
(§11.1). **POC-REFINED:** graph spreading confirmed as the differentiator; git-seeded BLA must ship
paired with decay+churn at a gentler weight (§4.1, §14 #1). **SLICE-3-REFINED:** the code-over-md fix
is *kind-scoping* — AURORA's per-kind hybrid weights need ≥2 signals to be principled and degenerate
to a forbidden md-penalty under BM25-only; kinds never sharing a ranking dissolves the burial with no
calibration. **Next action:** slice 4 (ACT-R activation, §4) — git-seeded BLA + decay/churn + 1-hop
spreading layered *within a kind*; re-run the multi-repo gate (incl. `aurora-mixed`), adopt only
weights ≥ baseline on every repo. This is where recall should first move beyond BM25.
