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
| `langdef` | per-language registry (`defTypes`/`importTypes`/`callTypes`/`branchTypes` per ext) | ✅ | slice 2/4/5 · ledger §11 |
| `chunker` | file → tree-sitter (code) / section (md) chunks + line ranges → `nodes` | ✅ | slice 2 |
| `gitsig` | file-level `git log` (one pass) → commit count + last-commit time, attached to hits as **activity metadata** (not scored) | ✅ | slice 4 · ledger §8 |
| `edges` | import specifiers → **`imports`** edges (intra-repo) → **1-hop additive spreading** in recall; `calls` relationships computed on-demand by `impact` (not persisted, §7.1 — `type='call'` row stays reserved) | ✅ (imports) | slice 4 · ledger §11/§4 |
| `tokenize` | code-aware BM25 body (`indexBody`: split + path + symbol names) + query match | ✅ (deps deferred) | slice 3 · ledger §1 |
| `activation` | ACT-R base-level **pure fns** (BLA · decay+churn · boost) — **deferred to access-log tier** (POC: git-only base-level is repo-dependent; the *spreading* ACT-R term ships via `edges`) | deferred | access-log tier · ledger §2–6 |
| `recall` | **kind-scoped** FTS gate → per-kind BM25 **+ additive import-spreading** (+semantic w/ embeddings tier) | ✅ (kind-scoped + spreading) | slice 3–4 · ledger §7 |
| `impact` | `impact(symbol)`: callees (ts walk) + callers (`rg -w`→ts confirm) → risk bucket `max(confirmed,mentions)` + complexity, on-demand; §7.2 hedges | ✅ (5a; alias/barrel mitigations → 5b) | slice 5 · ledger §9 |
| `embeddings` | semantic tier (sqlite-vec/ONNX), off by default | tier | §8 · ledger §11/§12 |
| `LiteCtx` | facade: config + wiring | ✅ | §3 |

**Seam rules (do not violate):**
1. **`store` persists FTS content, never builds it** — code-aware body text is `tokenize`'s job
   (✅ slice 3: `store.applyChanges` now calls `tokenize.indexBody`).
2. **One `langdef` registry** — `chunker`, `edges`, and complexity all read it; never fork it
   per-slice (`.scm` for chunking + node-type config for edges hang off the same module).
3. **`activation` stays pure** — functions of already-extracted signals, so the bench can ablate
   each term. (Ablation earned its keep: Step-0 showed base-level *still* fails the multi-repo gate
   *with* decay+churn — not a half-formula artifact but a real "needs an access log" finding.)
4. **`recall` is its own module, not the facade** — fusion weights / normalization / the
   tri→dual fallback chain don't belong in `LiteCtx`.

Don't pre-create empty modules — `gitsig`/`edges`/`impact` land with their slices; `activation`
lands with the access-log tier, not v1.

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

> **What we expect from litectx's memory (recalibrated 2026-06-05, POC-corrected).** The "memory"
> is an **ACT-R activation layer over the graph** with two terms: **spreading** (activation flows
> along call/import edges) and **base-level** (frequency/recency of access, with type-decay + churn
> by `kind`). **The Slice-4 Step-0 POC split them cleanly:**
>
> - **Spreading is the v1 ranking win — BUILT (slice 4).** `recall = BM25 + 1-hop import-spreading`,
>   over **import** edges only (calls don't help recall). Shipped as an **additive boost**
>   `own + w·spread` at **w=0.3** — not the convex `(1−w)·own + w·spread` form, which *taxed*
>   well-ranked files with weak neighbours (two diagnosed regression modes: *collateral dilution* and
>   *weak-neighbour demotion*). **Validated on four repos** (aurora +0.027 / gitdone +0.010 /
>   aurora-mixed +0.008 / multis +0.014): additive@0.3 is the only setting positive on all four.
>   In v1, "ACT-R in recall" effectively *means spreading*.
> - **Limit — 1-hop import-spreading is at its robust optimum; graph-only recall has hit diminishing
>   returns.** The four-repo weight sweep is the ceiling evidence: above additive@0.3 every knob is a
>   *seesaw* (additive@0.7 = +0.044 aurora but **−0.024 multis**, below baseline — the two non-tuning
>   repos peak low and punish high weight), and one regression mode is **irreducible** — a genuinely
>   poorly-connected true answer is demoted by *any* graph prior under *every* fusion/weight (the
>   intrinsic cost of trusting the graph, not a tunable). Further recall gains therefore do **not**
>   come from graph tuning (more hops dilute; call edges don't help recall) — they come from the
>   **deferred tiers** (embeddings/semantic; access-log base-level), which are separate tiers.
> - **Base-level activation does NOT earn v1 ranking weight.** It needs a real **access log**, and
>   v1 has none. Seeding it from git history (commits as pseudo-accesses, §4.1) — even with the
>   full **type-decay + churn** formula — is **repo-dependent**: net-positive on aurora,
>   net-negative on gitdone at *every* weight (POC: `RESULTS.md` "Slice-4 Step-0"). decay+churn did
>   not rescue it (it bites *stale* high-churn files; gitdone's failure is *recently*-churned ones).
>   A repo-dependent prior is the one thing recall must not ship. **So base-level activation is
>   deferred to the access-log future** — litectx's long-running-memory differentiator — and
>   validated *then*, on real usage. The `activations` table is schema-reserved for it.
>   - **An access is a *retrieval that was used*, NOT a mere appearance in results.** The access-log
>     boost (a "this surfaced before, lift it" term) records when a hit is actually retrieved/acted
>     on — that is the genuine relevance signal base-level activation rewards. Boosting *appearance*
>     alone would be a degenerate feedback loop (rich-get-richer: it amplifies the current ranking,
>     not relevance) and is explicitly **not** the design. This is also why git ≠ access: git is
>     *edit* frequency (commits), the access log is *use* frequency — aurora's card shows them as two
>     separate counts ("accessed 7x, 7 commits").
> - **Git is not a scored signal; it is passive activity metadata** (commit count + last-modified,
>   shown alongside hits as grounding). This re-derives aurora's own design: aurora never scored git
>   directly — git *seeded* activation and was *displayed raw*; its scored activation rode a real
>   access log ("accessed 7x").
>
> **v1 default ranking = BM25 + spreading** (two zero-ML signals). **Embeddings stay an optional
> tier** (semantic; dual ≈85% vs tri ≈95% — not worth the cold-start + ML dep by default). The
> activation engine remains **kind-agnostic** — the same math ratchets `fact`/`episode` memory once
> the access log exists; code is just v1's content.

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
change on both repos before it earns weight. **Scope note (POC-corrected):** of these, only
**spreading** ships as a v1 *ranking* term (slice 4, over edges). The base-level terms (BLA,
type-decay, churn, context-boost) are the **access-log tier** — built and validated when real
accesses exist, not at cold-start (see §4.1 and §14 #1/#4).

### 4.1 Cold-start ranking — git is activity metadata, not a ranking prior (POC-corrected 2026-06-05)

> **Original design (retired for v1 ranking).** The plan below seeded base-level activation from
> git commit timestamps so cold-start recall wouldn't collapse to keyword-only. The **Slice-4
> Step-0 POC falsified it as a ranking signal**: git-seeded base-level — *even with* the full
> type-decay + churn formula — is **repo-dependent** (net-positive aurora, net-negative gitdone at
> every weight; `RESULTS.md` "Slice-4 Step-0"). So in v1: **git is passive activity metadata**
> (commit count + last-modified, displayed alongside hits, not scored), cold-start ranking is
> **BM25 + spreading**, and the unified BLA model below is **kept for the access-log future** —
> where it is validated on real usage, the only place it has signal. The reasoning below stands as
> the *future* design; it is no longer the v1 cold-start path.

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
2. **Kind-scoped ranking** → BM25 now; **spreading** (slice 4, over edges) and **semantic**
   (embeddings tier) layer in **within a kind**, never across. Base-level activation is the
   access-log tier (§4), not a v1 ranking term:
   - **code**: BM25 → +spreading (graph) → +semantic (embeddings tier).
   - **doc/kb**: BM25 → +semantic (prose benefits most from embeddings; few code edges).
   - *(grounding shown, not scored:* git activity per chunk; impact/refs via the impact view.)

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
   *Deps + `k1/b` tuning deferred — neutral on the bench, and deps ride slice-4 edge extraction.*

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

> **Status (slice 5a, shipped):** `impact(symbol)` is built and tested — callees via a tree-sitter
> walk of the symbol body, callers via `rg -w` confirmed with tree-sitter, risk = `max(confirmed,
> mentions)` bucketed at the aurora thresholds (≤2/3–10/11+), plus complexity and the §7.2 hedges.
> **Computed on demand, not persisted** (§7.1's mechanisms are query-time; the `type='call'` edge
> row stays reserved for a future persist-if-slow optimization). The §7.2 **alias / barrel**
> anti-false-isolation mitigations are deferred to **slice 5b**, gated on adding a TS bench fixture
> (POC-first) — the export-root, reflection (unconfirmed-mention) and underscore/public hedges and
> the universal *unresolved ≠ absent* net ship now. Validated on aurora: hubs bucket `high` with
> correct fan-in (`SQLiteStore` 235 refs/109 callers, `BaseLevelActivation` 47/36), ~0.1–0.9s/symbol.

The decision is final: **there is no language-server tier.** The one and only edge resolver =
**tree-sitter queries + `ripgrep -w`** (word-boundary). Zero external binaries; ~2ms/symbol;
deterministic. (AURORA measured LSP ~300ms/symbol and itself fell back to `rg -w`; in Node there is
no multilspy and hand-driving servers over `vscode-jsonrpc` is fragile — rejected.) Grounding:
`LSP.md`, ledger §11. Accuracy comes from the **language definition** (`function_def_types`,
`call_node_type`, `skip_names`, entry/callback lists), not a server — that is the knowledge that
makes ripgrep edges accurate. Per-language config is the bulk of "adding a language" (~1–2 days/lang).

### 7.1 The carve-out — what litectx answers vs. what only an LSP can (DECIDED)

litectx replaces the *questions you'd ask* an LSP, not the LSP. It is near-perfect at **detecting**
syntax (tree-sitter) and deliberately **imprecise at resolving bindings** (over-count by design).

| Capability | In/Out | How | **Detect** | **Resolve** | Failure bias |
|---|---|---|---|---|---|
| **calling** (callees) | ✅ in | tree-sitter walk of def body (no rg) | ~99% | ~95% by-name | over (local; nothing to resolve) |
| **called-by** (callers) | ✅ in | `rg -F -w --json` sweep → ts confirm call site | ~90% | ~80% | **over-count** (superset) |
| **imports / connected files** | ✅ in | ts import nodes → module→file heuristics | ~98% | ~75–90% | under/mis-attrib (see 7.2) |
| **refs → risk bucket** | ✅ in | confirmed candidates → counts → risk thresholds (ledger §9) | — | inherits | over → higher risk |
| **complexity** | ✅ in | ts branch-node count in the chunk | ~99% | n/a | none |
| **dead-code** | ✅* candidate | inverse impact (0 callers ∧ 0 importers) | — | inherits | false-neg (safe) — *never a verdict* |
| `get_definition` / `hover` | ⛔ out | editor nav, not litectx | | | |
| `lint` / diagnostics | ⛔ out | linters exist | | | |
| precise import-vs-usage binding | ⛔ **non-goal** | over-count by design (§13) | | | |

*The one measured anchor is aurora's ripgrep dead-code mode at ~85% ("daily dev / CI, NOT before
deleting"). The rest are mechanism estimates anchored to it; litectx's own numbers get measured on
the bench when slices 4–5 land. **Detection is near-perfect everywhere; the gap is resolution, and
it is biased to over-count.***

### 7.2 The safety contract — over-count is safe, under-count is dangerous (DECIDED, GOVERNING)

The two error directions are **not** equally bad, and the whole impact view is built around the
asymmetry:

- **Over-count** (looks *more* connected / *higher* risk) → AI is over-cautious → wasteful, never
  harmful. **75%-accurate counts are fine.**
- **Under-count** (looks *more isolated* / *lower* risk) → AI concludes "siloed, safe to change" →
  **breaks hidden consumers. This is the damaging error.**

**Invariant: litectx may overstate connectivity freely, but must never understate it silently.**
"It's connected / risky" is a normal claim; **"it's isolated / unused / low-risk" is a load-bearing
safety claim** and only ships hedged, after the anti-false-isolation mitigations below.

Every dangerous failure mode is an under-count. Sorted by *danger × incidence × testability* (the
gate repos — aurora Py / gitdone JS — exercise only reflection: 23/497 `getattr`, 7/103 dynamic
`require`; **zero** aliases/barrels/TS):

| Under-count mode | Mitigation | v1 status |
|---|---|---|
| Framework callbacks / entry points | carry aurora's `entry_*`/`callback` lists as **roots** | ✅ build (exercised; lists borrowed) |
| Public exports look unused | every export is a **usage root** | ✅ build (trivial, falls out of export nodes) |
| Reflection / string-keyed (`getattr`, `require(var)`) | flag dynamic-feature files + **string-literal mention check** (rg already running) before any dead/isolated claim | ✅ build (the mode actually in our data; cheap 80/20) |
| Barrel / `export…from` re-exports | capture re-export **edges**; transitive-through-barrel (bounded) | 🟡 edges now; transitivity deferred (0 incidence/untestable) |
| Path aliases (`tsconfig paths`) | parse tsconfig/jsconfig `paths`+`baseUrl` | ⏸ **spec, don't build blind** — 0 TS in the bench; gate on adding a TS fixture (POC-first) |

**The universal safety net (cheap, covers the residual):** the only dangerous act is *silently
dropping a reference*. So any reference we can't resolve — unfollowable alias, dynamic call,
unresolvable import — is recorded as **`unresolved`, never `absent`**. That single rule keeps every
"isolated / low-risk" verdict honest even for modes we haven't fully solved: such a symbol reads as
"couldn't fully resolve," not "siloed." Truly unresolvable reflection then gets the explicit caveat
*"dynamic usage not statically visible — review candidate,"* never a clean isolation verdict.

### 7.3 Edge types & the two non-conflatable signals

- **Two edge types, both required (ledger §11):** `calls` (symbol→symbol) powers called-by/calling
  + symbol blast radius; `imports` (file→file, tree-sitter import nodes) powers file connectivity
  (aurora's `get_imported_by`). **Recall spreading rides `imports` only** (Step-0 POC: calls were
  repo-dependent for recall); **`calls` feed impact**, not recall.
- **complexity** = cyclomatic-ish AST branch count *inside* a chunk (local property);
  **risk/impact** = *reference count* from the call graph (blast radius). Separate fields, by design.

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
   symbol chunks land *alongside* as the structural substrate that edges + spreading (slice 4) ride
   on. The recall jump the chunks enable arrives in slices 3–4, not here
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
   neutral on bench; deps ride slice-4 edges.)
4. **Edges + spreading (the next ranking win) + git activity metadata** — RESHAPED 2026-06-05
   after the Slice-4 Step-0 POC (`RESULTS.md`; old slice 4 = "ACT-R activation in recall" is
   **dissolved** — base-level activation does not earn v1 ranking weight, see §4/§14 #1).
   **✅ SHIPPED (2026-06-05) — imports + spreading + `gitsig`. Slice 4 complete.**
   - **Edges (`imports`) — ✅ SHIPPED.** Import specifiers extracted in the **same tree-sitter parse**
     as the slice-2 chunks (Python `import`/`from` abs+rel, ES `import`, CJS `require()`), resolved
     to **intra-repo** target files only → directed `edges(type, src, dst)` table. The `calls` edge
     type (symbol blast radius, ripgrep `-w` + tree-sitter call-queries) is **reserved for the impact
     view (slice 5)** — calls don't help recall (Step-0 POC), so they're not built here.
   - **Spreading — ✅ SHIPPED.** 1-hop over **import** edges, fused into recall **within a kind** (the
     slice-3 invariant holds). Shipped as an **additive boost** `own + w·spread` at **w=0.3** — the
     convex `(1−w)·own + w·spread` form (POC default ≈0.4) was corrected at build time: it *taxed*
     well-ranked files with weak neighbours (two diagnosed regression modes). **Re-validated on four
     repos** (added `multis`, a 3rd CJS repo): additive@0.3 is the only setting **≥ baseline on every
     repo** (aurora +0.027 / gitdone +0.010 / aurora-mixed +0.008 / multis +0.014). **Default ranking
     is now BM25 + additive import-spreading.** *Limit: this signal is at its robust optimum — higher
     weight overfits aurora and sinks multis below baseline; further recall gain is the deferred tiers,
     not graph tuning (see §4).*
   - **Git activity metadata (`gitsig`) — ✅ SHIPPED.** One `git log` pass → per-file commit count +
     last-commit time on each hit (`git: { commits, lastCommit } | null`), stored in `git_sig`.
     **Not a scored term** — bench byte-identical. `git: null` honestly marks *no commit history*
     (non-git tree, or tracked-but-uncommitted). No per-block blame (file granularity; blame +
     base-level activation are the access-log tier).
5. **impact view** (reference count → risk bucket; complexity from AST).
   - **Slice 5a — ✅ SHIPPED (2026-06-05).** `impact(symbol)` on demand: callees (ts walk of the
     body) + callers (`rg -w` → ts-confirm, with enclosing symbol) → `risk = bucket(max(confirmed,
     mentions))` at aurora thresholds ≤2/3–10/11+, plus complexity and the §7.2 hedges. Calls
     computed on-demand, not persisted (§7.1). `langdef` gains `callTypes`/`branchTypes`. 9 tests +
     a mutation check (under-count kills the §7.2 tests). Recall bench byte-identical.
   - **Slice 5b — ⏸ NEXT (gated on #1).** The §7.2 **alias / barrel** false-isolation mitigations,
     plus the **impact bench gate** that proves them. Sequencing in §11.3.

**Deferred to post-v1 tiers (schema-reserved, not v1 slices):**
- **Embeddings / semantic tier** (§8) — opt-in; adds semantic as the third ranking signal
  (tri-hybrid). Off by default (ML dep + cold latency).
- **Access log + base-level activation** (§4, §14 #4) — litectx's long-running-memory
  differentiator. Once real accesses accumulate in the reserved `activations` table, BLA +
  decay+churn become a *validated* scored signal (on real usage, not git proxy). Git activity
  metadata (slice 4) is the v1 grounding that stands in for it.

**Impact-view timing:** sequenced *after* recall because it depends on accurate edges
(slice 4). If edges slip, recall ships as v1 and impact lands v1.1 — the graph substrate
makes that a clean cut, not a rework.

### 11.3 End-to-end validation — one labeled bench per view (DECIDED)

The "Behavior" gate (§11.1) is the system's **end-to-end test**: index a *real, stable repo* (a
frozen external checkout, never a toy fixture) through the real `LiteCtx`, run labeled inputs
through the real public API, and score the user-facing output against hand-authored ground truth.
`poc/bench-lib.mjs` is the working template — for **recall** it indexes aurora/gitdone, runs each
labeled `{ q, target }` query through `recall()`, and reports **MRR / P@k** (where the truth file
ranked). The hold-or-beat rule makes it a regression gate.

As litectx grows past recall (impact now; write/select/compress/isolate, activation, embeddings
later — the views are all over **one** graph), **each view gets its own labeled bench gate with a
view-appropriate metric.** Same machine, different labels:

| View | Corpus (stable repos) | Labels | Metric | Status |
|---|---|---|---|---|
| **recall** | aurora (Py), gitdone (JS) | `{ q → target file }` | **MRR / P@k**, hold-or-beat | ✅ shipped |
| **impact** | **aurora (Py) + mcprune (JS)** | `{ symbol → known callers; isolated? }` | **caller-recall (miss-rate)** — must be ~100%; over-count tolerated (§7.2) | 🚧 **next** — validates 5a (no TS dependency) |
| **impact (TS false-isolation)** | TS fixture (#1) | symbol reached *only* via alias/barrel → `isolated:false` | asserts impact does **not** report isolated | 🚧 5b (needs #1) |
| write/compress/select/… | tbd | tbd | tbd | post-v1 |

**The impact metric is not MRR — it is dictated by the §7.2 asymmetry.** Recall's risk is a *miss
buries an answer* (ranking quality → MRR). Impact's risk is a *miss is a false "isolated → safe"
that breaks hidden consumers*, so the gate's headline number is **caller-recall = found ÷ known**,
which must approach 100%; precision (over-count) is deliberately *not* gated hard. A naïve accuracy
metric would pass an impact view that silently drops callers — the one failure §7.2 exists to stop.

Corpus choice: **aurora + mcprune** are externally-owned and effectively **archived** (frozen), so
their call graph is a stable oracle that won't drift under the gate. Two languages (Py + JS) catch
language-specific resolution bugs. TS isolation hazards (alias/barrel) need the dedicated TS fixture
(#1) — neither aurora nor mcprune is TS — which is exactly why that gate is sequenced into 5b.

Beyond per-view gates, **a composing scenario test** (index once → recall → `impact` on a recalled
symbol → … ) is the proof that the views share one coherent graph rather than re-extracting — the
"validate the whole memory end-to-end" test as the surface completes. At least one bench gate should
graduate from human-read to an **asserted threshold** so quality regressions fail CI, not just print.

---

## 12. What to carry over from AURORA (borrow, don't port)

**Reimplement in clean ESM JS** (pure logic, near-verbatim): the **spreading** ACT-R term (§4,
slice 4), code-aware BM25 tokenizer + `k1/b` (§5), two-stage retrieval + code-over-md fix (§5),
3-tier incremental indexing (§6), per-language edge-semantics config (§7), the `kind`-keyed type
taxonomy (§3.1). **File-level** git activity (count+recency) for metadata (slice 4). *(Base-level
ACT-R formulas + block-level git-blame = access-log tier, deferred — §4, §14 #1.)*

**Carry the calibration, not just the code:**
- dual-hybrid ≈ 85% vs tri-hybrid ≈ 95% → embeddings are a tier, not the spine. (litectx's v1
  "dual" = **BM25 + spreading**, not BM25 + base-level activation — the POC showed base-level needs
  an access log to pull weight; §4, §14 #1.)
- code-over-md is solved by **kind-scoping** (§5, slice 3), not a penalty hack and not weights:
  AURORA's per-kind hybrid weights need ≥2 signals to be principled and collapse to a forbidden
  md-penalty under BM25-only — and any shared ranking is hostage to the repo's doc/code volume
  ratio. litectx's lesson borrowed here is the *symptom* (prose buries code) and the *non-penalty
  doctrine*, not the weight mechanism.
- edges from ripgrep/lang-def, **not** tree-sitter's import-parsing (AURORA's
  `_identify_dependencies()` was a dead side-path — do not repeat).
- type-specific decay + churn parameters (§4) are tuned values worth keeping — but they belong to
  the **access-log tier** (base-level activation), not v1 ranking (POC: they don't rescue git-only
  base-level; §14 #1).
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

1. **Cold-start / git-seeded activation** — ~~does git-commits-as-pseudo-accesses (§4.1) work?~~
   **CLOSED (Slice-4 Step-0 POC, two repos):** git-seeded **base-level activation does not earn v1
   ranking weight — not even with decay+churn.** The full formula (BLA − type-decay − churn) is
   net-positive on aurora but net-negative on gitdone at *every* weight 0.1–0.4 (`RESULTS.md`); the
   "missing half" (decay+churn) made gitdone *worse*, because churn penalizes *stale* high-churn
   files and gitdone's failure mode is *recently*-churned ones. Root cause: it is a **repo-dependent
   prior** because v1 has **no access log** to give base-level real signal. **Resolution:** (a)
   base-level activation → **access-log tier** (§4, #4 below), validated then on real usage; (b)
   **git → passive activity metadata** (commit count + recency, displayed, not scored); (c) the v1
   ranking lift comes from **spreading** (slice 4), which *did* hold ≥ baseline on both repos. The
   "adopt only if ≥ baseline on every repo" rule stands and is what rejected base-level — one repo
   (aurora) alone would have shipped a gitdone regression.
2. **MMR without embeddings** — cheap lexical/structural diversity proxy, or accept that MMR
   is embeddings-tier only? (Default: tier-only.)
3. **Edge types beyond `calls`/`imports`/`depends_on`** — add `inherits`/`defines` in v1 or
   defer? (Lean: defer; the three cover impact.)
4. **Access-history write path** — **now the gate for base-level activation** (#1): it only earns
   ranking weight once a real access log exists. Open: does litectx own "agent accessed chunk X"
   writes (e.g. `recall()` logs hits to the reserved `activations` table), or does the consumer
   report accesses? This is the **access-log tier**'s core design and litectx's long-running-memory
   differentiator — design it when the first long-running consumer is real.
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
kind-scoping, not weights)**, packaging (§14 #5), and the build methodology (§11.1).
**SLICE-4-STEP-0-REFINED (2026-06-05):** git-seeded **base-level activation does not earn v1 ranking
weight — not even with decay+churn** (repo-dependent: +aurora / −gitdone at every weight 0.1–0.4;
`RESULTS.md`). It re-derives aurora's structure: base-level needs a real **access log**, which v1
lacks. So base-level activation → **access-log tier** (deferred); **git → passive activity metadata**
(displayed, not scored); the v1 ranking lift comes from **spreading** (validated on both repos).
**v1 default ranking = BM25 + spreading.** **SLICE-3-REFINED:** the code-over-md fix is *kind-scoping*
(kinds never share a ranking), not weights. **Next action:** **slice 4 = edges + spreading +
git-activity-metadata** (§11.2) — tree-sitter+ripgrep `calls`/`imports` edges → 1-hop spreading fused
*within a kind*; re-run the multi-repo gate (incl. `aurora-mixed`), adopt the spreading weight only if
≥ baseline on every repo. This is where recall first moves beyond BM25.
