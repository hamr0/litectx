---
type: reference
title: Recall Engine
status: stable
sources: [docs/archive/litectx-prd.md]
---

Recall is litectx's read-view over the graph: a two-stage retrieval pipeline (FTS5 keyword gate
→ kind-scoped ranking) layered with an ACT-R-inspired activation model, running over an index
built by extension-routed, incrementally-updated file/chunk parsing. This page traces how a query
turns into ranked results.

## Activation: what ships in v1 vs what's deferred

The full activation formula is `A = BLA + Σ_j (W_j · F^hop_ij) + ContextBoost − Decay`
(litectx-prd.md:798-803), reimplemented in JS from aurora's `activation/*` calibration. It has
two conceptual terms: **spreading** (activation flows along call/import edges) and **base-level**
(frequency/recency of access, with type-decay + churn by `kind`) (litectx-prd.md:753-756).

A POC (Slice-4 Step-0) split these cleanly, and only one of them earned v1 ranking weight:

- **Spreading — DECIDED, built.** `recall = BM25 + 1-hop import-spreading`, over **import** edges
  only (call edges don't help recall). It ships as an **additive** boost `own + w·spread` at
  **w=0.3**, not the convex `(1−w)·own + w·spread` form, which taxed well-ranked files with weak
  neighbours. This was validated across four repos (aurora +0.027 / gitdone +0.010 /
  aurora-mixed +0.008 / multis +0.014) — additive@0.3 is the only setting positive on all four
  (litectx-prd.md:758-764). Above that weight every knob seesaws across repos, and one
  regression mode is irreducible: a poorly-connected true answer is demoted by any graph prior
  under any fusion — the intrinsic cost of trusting the graph. Further recall gains do not come
  from more graph tuning; they come from separate deferred tiers (embeddings, access-log
  base-level) (litectx-prd.md:765-772).
- **Base-level activation — deferred to the access-log future.** It needs a real access log,
  which v1 doesn't have. Seeding it from git history (commits as pseudo-accesses), even with the
  full type-decay + churn formula, proved **repo-dependent** — net-positive on aurora,
  net-negative on gitdone at every weight — so it does not ship as a v1 ranking term
  (litectx-prd.md:773-778). The design distinguishes an **access** (a retrieval that was
  actually used) from a mere appearance in results: boosting appearance alone would be a
  degenerate rich-get-richer feedback loop, not a relevance signal. This is also why git isn't
  treated as access: git measures *edit* frequency, an access log measures *use* frequency
  (litectx-prd.md:781-787). Consequently git is **passive activity metadata** — commit count and
  last-modified shown alongside hits, never scored (litectx-prd.md:788-791).

**v1 default ranking = BM25 + spreading**, two zero-ML signals; embeddings remain an optional
tier layered on top. The activation engine itself stays kind-agnostic — the same math will
ratchet `fact`/`episode` memory once a real access log exists (litectx-prd.md:793-796).

### Activation formula components (calibration, mostly not yet scored)

The reimplemented formula carries these terms, ground-truthed against aurora:

- **BLA (base-level)** — `ln(Σ_j t_j^-d)` over access history, `d=0.5` default.
- **Spreading** — BFS over edges, `F=0.7` per hop, max 3 hops.
- **Context boost** — query↔chunk keyword overlap, `boost=0.5`.
- **Decay** — `−d_kind · log10(days_since_access)`, with a 1-hour grace period, capped at 90
  days, floored at −2.0 (litectx-prd.md:805-809).
- **Type-specific decay**, keyed by `(kind, format)`: markdown (`kind=doc, format=md`) `0.05`,
  class `0.20`, function/method/`code` `0.40`, toc-entry `0.01`; pdf/docx `0.02` (reserved).
  Markdown decays roughly 8× slower than functions — note aurora tuned markdown at `0.05`, and
  its `0.02` rate was for paginated pdf/docx, not markdown (litectx-prd.md:810-813). Written-memory
  rates — `fact` `0.02` (durable, ~never fades) and `episode` `0.40` (recency-dominated) — are
  **provisional calibration only**, not yet code, since nothing scores decay until the access-log
  tier exists (litectx-prd.md:814-820).
- **Churn factor** — `0.1 · log10(commits+1)` added to decay, so volatile code decays faster
  (litectx-prd.md:821).
- **MMR diversity rerank** — optional, needs embeddings, off by default (litectx-prd.md:822).

Of all these terms, **only spreading ships as a v1 ranking term**; BLA, type-decay, churn, and
context-boost belong to the access-log tier, built and validated once real accesses exist
(litectx-prd.md:828-831).

### Cold-start: git as metadata, not a ranking prior

The original design seeded base-level activation from git commit timestamps (recency → recency
term, count → frequency term) so cold-start recall wouldn't collapse to keyword-only, borrowing
aurora's `git.py:calculate_bla`. The Slice-4 Step-0 POC falsified this as a *ranking* signal — it
is repo-dependent (net-positive on aurora, net-negative on gitdone at every weight). So in v1,
git is passive activity metadata only, cold-start ranking is BM25 + spreading, and the unified
BLA-from-git design is retained purely as the future access-log path, where it would be validated
on real usage (litectx-prd.md:833-843). Under that retained design, never-accessed chunks are
neutral (BLA `= 0`, not `−∞`), so nothing is penalized for being freshly indexed
(litectx-prd.md:852-854).

## Retrieval pipeline and the code-over-md fix

Retrieval is two-stage (litectx-prd.md:868):

1. **FTS5 keyword gate** — SQLite FTS5 BM25 selects the top ~N candidates **per kind**.
2. **Kind-scoped ranking** — BM25 first; spreading (over edges) and semantic (embeddings tier)
   layer in *within* a kind, never across kinds. Base-level activation is not a v1 ranking term.
   For `code`: BM25 → +spreading → +semantic. For `doc`/`kb`: BM25 → +semantic (prose benefits
   most from embeddings, since it has few code edges). Git activity and impact/refs are shown as
   grounding, never scored (litectx-prd.md:870-876).

**The code-over-md problem** was that prose-heavy markdown out-surfaced code because a query
term is simply mentioned more often in prose. Aurora's fix was per-kind hybrid weights, which
only work once ≥2 signals exist — with BM25 as the sole v1 signal that degenerates into a tuned
md-penalty constant, which the doctrine forbids. Worse, a shared ranking is hostage to the
doc/code volume ratio of a given repo and can't generalize (litectx-prd.md:878-885).

litectx's fix removes the shared ranking entirely — this is the invariant: **kinds never share a
ranking.** `recall` runs one FTS query per kind, each BM25-ranked only against its own kind, so a
`kind:"code"` result can never contain a doc regardless of how prose-heavy the index is, with no
weights and no calibration (litectx-prd.md:887-891). This mirrors how a long-running agent
queries memory — it already knows its intent (`code`/`fact`/`episode`) and supplies `kind`
explicitly. Three query modes: a single kind returns a flat list (default `n=10`); multiple kinds
or an omitted kind return results grouped per kind (default `n=5` each — the safe CLI/agent
default); `n` caps results per kind (litectx-prd.md:893-896).

This was validated on aurora's 497 `.py` files indexed together with its 196 `.md` design docs:
recalling `kind:"code"` held — and slightly beat — the py-only baseline (MRR 0.525 → 0.545),
whereas a shared ranking dropped it to 0.480 with 12/22 queries prose-buried
(litectx-prd.md:898-901). Two structural mechanisms make this hold: the FTS5 gate applied per
kind (so rare-but-relevant code isn't starved by candidate-pool competition with docs), and a
code-aware FTS body that splits identifiers (`getUserData → get user data`) and folds in symbol
names, so descriptive queries match identifier-dense code (litectx-prd.md:901-906).

### Written-memory stemming — a gate fix, not a ranking fix

A separate failure mode showed up for short written facts: FTS5 has no stemming, so a fact stored
as "refunds…" is never retrieved by "refund policy" — morph MRR 0.000, because the failure is at
the **gate**, not the ranker (activation re-ranks, it never gates), and short fact text has no
identifier-style redundancy to absorb the miss the way code does (litectx-prd.md:910-914).

Two options were measured against the real pipeline before deciding. Applying porter stemming to
everything fixed memory morph recall (0.000→0.722) but broke code/doc floors on every other repo
(aurora 0.552→0.530, multis 0.457→0.431, gitdone P@1 25%→15%) — rejected by the every-repo rule,
because in code, word-forms are distinct symbols (`token`/`tokens`/`tokenize`) that stemming
merges and dilutes (litectx-prd.md:916-921). Aurora itself stems everything, but only as a
stage-1 gate re-scored by a separate code-aware ranker; litectx's FTS table is both gate and
ranker, which is exactly why porter-everywhere moved its rankings. A "stem the gate, rank exact"
hybrid for code is documented as a future option, not built now (litectx-prd.md:922-927).

**Decision:** porter stemming applies only to `fact`/`episode`, in their own FTS table
(`tokenize='porter unicode61'`); `code`/`doc` stay on the unstemmed `docs` table. Because kinds
never share a ranking, no query ever merges BM25 scores across the two tables. Even a `doc`
written directly via `remember` stays unstemmed, since `doc` is the one kind produced by both the
file-index and direct-write paths, and stemming only the direct half would fork it into two
incomparable ranking domains — the residual morphology gap for doc passages is left to the
embeddings tier (litectx-prd.md:929-936).

## Indexing

Indexing feeds the graph that recall and activation operate over (grounding: `MEM_INDEXING.md`):

- **Routing is by file extension everywhere**, never by content or shebang sniffing: extension →
  `kind` → parser → edge config (litectx-prd.md:944-945).
- Code and markdown are indexed, incrementally, on re-index.
- **Change detection** goes fast→slow: `(mtime, size)` first, then a content hash (sha256) —
  skipping roughly 95% of files on a typical re-index, tracked in
  `file_index(path, content_hash, mtime, size, indexed_at)`. A git-status pre-filter tier is
  deferred since `(mtime, size)` already meets the skip goal (litectx-prd.md:946-949).
- **Block-level git signals** — `git blame --line-porcelain` computes commit count and recency
  **per chunk line-range**, not per file. This is a differentiator, feeding churn, the cold-start
  BLA design, and the output schema (litectx-prd.md:950-952).
- **Symbol-chunk composition:** a code chunk's line-range extends upward over an
  immediately-adjacent doc-comment block (JSDoc `/** … */`, contiguous `//`, or Python `#`), with
  a blank line breaking the association. This exists because a JS/TS JSDoc is a tree-sitter
  sibling node *above* its function/class, so without this rule it was orphaned into the file's
  `preamble` chunk, dissociated from the symbol it documents (Python docstrings, being inside the
  body, were never affected). The sole justification is the `compress()` render tier — it does
  **not** improve recall: this is chunk-granular only (file-level FTS/embeddings still index the
  raw whole file, so file-grain ranking is byte-identical — proven unchanged at aurora 0.552 /
  gitdone 0.425), and even at chunk grain neither lexical localization (0/3 real cases) nor
  semantic ranking (−0.003 MRR) improved. Over-capture is the accepted failure direction — a
  mis-attached comment widens a chunk but never drops a symbol (litectx-prd.md:953-969).
- **Ignored paths:** `.git`, `node_modules`, `__pycache__`, `.venv`, `dist`, `build`, plus a
  `.litectxignore` file using gitignore syntax (litectx-prd.md:970-971).
