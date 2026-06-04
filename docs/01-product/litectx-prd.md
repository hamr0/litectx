# litectx — Product Requirements Document (PRD, DRAFT)

> A standalone, **lite, local-first code-aware memory engine** for AI coding agents:
> it indexes a repository (code + docs) into a queryable **code+context graph** and serves
> two read-views over it — **recall** (ranked search) and **impact** (blast-radius / risk).
> Published as an importable **npm library** (Node + TypeScript). It is the realization of
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
> earns its place, Testing Trophy.
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
- **Stack:** Node + TS, `better-sqlite3` + FTS5, `web-tree-sitter`, `ripgrep`. **Zero
  external binaries required.** Embeddings are the one opt-in tier.
- **Edges/impact:** tree-sitter + `ripgrep -w` only — **no LSP server, ever** (§7).
- **Method:** *borrow, don't port* — reimplement AURORA's validated algorithms in clean TS.

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

---

## 3. Public API (DRAFT shape)

One importable surface; one config object; safe defaults; everything advanced is opt-in.

```ts
import { LiteCtx } from "litectx";

const lc = new LiteCtx({ root: "/path/to/repo" /*, ...LiteCtxConfig */ });

await lc.index();                       // incremental, git-aware (§6)
await lc.index({ paths: ["src/"] });

// view 1 — recall
const hits = await lc.recall("how does auth work", { topK: 10, kind: "code" });
// → [{ id, kind, file, lines, score, signals:{ bm25, activation, semantic?, git } }]

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

ACT-R total activation, reimplemented in TS (grounding: aurora `activation/*`,
`docs/02-features/memory/ACTR_ACTIVATION.md`):

```
A = BLA + Σ_j (W_j · F^hop_ij) + ContextBoost − Decay
```

- **BLA (base-level)** — `ln(Σ_j t_j^-d)` over access history, `d=0.5` default.
- **Spreading** — BFS over edges, `F=0.7`/hop, max 3 hops.
- **Context boost** — query↔chunk keyword overlap, `boost=0.5`.
- **Decay** — `−d_kind · log10(days_since_access)`, 1-day grace, capped at 365d.
- **Type-specific decay** (keyed by `kind`/element) — kb/doc `0.05`, class `0.20`,
  function/method/code `0.40` (docs decay ~8× slower than functions).
- **Churn factor** — `0.1 · log10(commits+1)` added to decay (volatile code decays faster).
- **MMR diversity rerank** (optional) — needs embeddings; off by default.

Ship AURORA's 5 presets as config presets. All formulas are pure functions → near-verbatim
TS port, unit-testable.

### 4.1 Cold-start ranking — solved cleanly with git as the prior (DECIDED design)

At first index there is no access history, so a naive BLA would zero out everything and
recall would collapse to keyword-only. AURORA solved this with a separate git-recency BLA
(`0.5^age_in_years`). litectx unifies it through **one formula** with **safe defaults**:

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

## 5. Retrieval pipeline + the code-over-md fix (DECIDED)

Two-stage (grounding: `hybrid_retriever.py`, `MEM_INDEXING.md §Hybrid`):

1. **FTS5 keyword gate** — SQLite FTS5 BM25 → top ~100 candidates.
2. **Chunk-kind-aware hybrid re-rank** → top K:
   - **code**: BM25 50% / activation 30% / semantic 20%
   - **doc/kb**: BM25 30% / activation 30% / semantic 40%
   - **Dual-hybrid fallback** (embeddings off, the default): redistribute semantic weight
     to BM25+activation → **~85% vs ~95%** tri-hybrid.
   - Scores min-max normalized to [0,1] before weighting.

**Code-over-md promotion (the bug we hit, and the fix to carry — grounded, no magic
boost).** Prose-heavy md chunks were out-surfacing code because a query term is *mentioned*
more often in prose. The fix was **three structural mechanisms together**, with **no
explicit md penalty** (verified: none exists in `hybrid_retriever.py`):
1. **Per-candidate kind-aware weights** — a code chunk is scored with code weights
   (BM25 0.5, the strongest exact-token signal); an md chunk with doc weights (BM25 0.3).
2. **FTS5 gate replaced the old activation gate** (v0.17.1) so rare-but-relevant code isn't
   starved before re-rank.
3. **Code-aware BM25 tokenizer** (`getUserData → get/User/Data/getuserdata`, `k1=1.5`,
   `b=0.75`) **+ deps + file_path included in BM25 content**, so code isn't a sparse loser
   to prose. (AURORA lesson: sparse content → descriptive queries return 0.)

---

## 6. Indexing (DECIDED)

Grounding: `MEM_INDEXING.md`.

- **Route by file extension, everywhere** (DECIDED): extension → `kind` → parser → edge
  config. **Never** sniff language by content/shebang.
- **Index code + markdown**, incremental re-index.
- **3-tier change detection** (fast→slow): git status → mtime → content-hash; skips ~95% of
  files on re-index. Track in `file_index(path, content_hash, mtime, indexed_at)`.
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
  indexed both ends), `activations`, `file_index`.

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
2. tree-sitter **symbol-level** chunking for **TS, JS, Python** + md section chunker → nodes
   (§3.1, §6). Replaces file-granularity; **benchmark must not regress.**
3. Code-aware BM25 + FTS5 gate + code-over-md fix (§5).
4. ACT-R activation engine + presets + cold-start (§4) → **recall view** ships. Per the POC:
   base-level → **decay+churn** → spreading; **validate on both repos before BLA gets weight.**
5. tree-sitter + ripgrep edge extraction + per-language semantics config (§7) → graph edges.
6. **impact view** (reference count → risk bucket; complexity from AST) over the edges.

**Impact-view timing:** sequenced *after* recall because it depends on accurate edges
(step 5). If step 5 slips, recall ships as v1 and impact lands v1.1 — the graph substrate
makes that a clean cut, not a rework.

---

## 12. What to carry over from AURORA (borrow, don't port)

**Reimplement in clean TS** (pure logic, near-verbatim): ACT-R formulas (§4), code-aware
BM25 tokenizer + `k1/b` (§5), two-stage retrieval + code-over-md fix (§5), 3-tier
incremental indexing (§6), block-level git-blame extraction (§6), per-language
edge-semantics config (§7), the `kind`-keyed type taxonomy (§3.1).

**Carry the calibration, not just the code:**
- dual-hybrid ≈ 85% vs tri-hybrid ≈ 95% → embeddings are a tier, not the spine.
- code-over-md needs the three structural mechanisms (§5), not a penalty hack.
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
  import-vs-usage separation and LSP-grade dead-code are out of scope.
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

## 15. Status: BUILDING v1 — slices 0–1 shipped

Discovery done; **POC passed** (§11, 2026-06-04; harness + writeup in `poc/`); **build underway**.
This doc lives in the `litectx` repo — name reserved as `litectx@0.0.1` on npm, Apache-2.0, public,
**slices 0–1 shipped** (walking skeleton + incremental git-aware indexing / hardened `kind`/`format`
schema; `src/` + CLI + tests + integration gate; §11.2). **DECIDED:** name, stack, storage, indexing,
edges-are-ripgrep-only, tiers, v1 languages, `kind`-from-day-one, the code-over-md fix, the cold-start
design, packaging (§14 #5), and the build methodology (§11.1). **POC-REFINED:** graph spreading
confirmed as the differentiator; git-seeded BLA must ship paired with decay+churn at a gentler weight
(§4.1, §14 #1). **Next action:** slice 2 (tree-sitter symbol-level chunking) per §11.2 — must
hold-or-beat the slice-0/1 benchmark on both repos; this is where recall numbers should first jump.
