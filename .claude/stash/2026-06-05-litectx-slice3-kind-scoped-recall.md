# Stash — litectx: Slice 3 shipped (kind-scoped recall = the code-over-md fix, weights rejected)

- **Date:** 2026-06-05
- **Repo:** `/home/hamr/PycharmProjects/litectx` (also `/home/hamr/Documents/...`). git, `main`, public GitHub.
- **Continues:** `.claude/stash/2026-06-05-litectx-slice2-chunking-and-context-md.md`.
- **Mode:** build (slice 3) + a long design discussion that **reshaped the slice**. NOT yet committed
  (user commits explicitly; offered).
- **Governing files:** `.claude/memory/AGENT_RULES.md` (POC-first, dep hierarchy, testing trophy) +
  `LIBRARY_CONVENTIONS.md` (pure ESM JS + JSDoc→`.d.ts`; one-prod-dep bar; §3 context.md contract).
  SoT for the engine = `docs/01-product/litectx-memory-prd.md`.

---

## The headline: Slice 3's premise was falsified, and the fix changed shape

Slice 3 was scoped as "code-aware BM25 + code-over-md fix via per-kind hybrid **weights**" (PRD §5,
borrowed from aurora `hybrid_retriever.py`). **POC-first testing killed that plan and produced a better one.**

1. **Tokenization is a neutral lever here.** Six body-enrichment variants (camelCase split, symbol-name
   fold, deps fold) all net-neutral on the bench (aurora 0.523→0.525, gitdone 0.416→0.415 — ±0.001 noise).
   Full-body split *regressed* Python (duplicates tokens; unicode61 already splits snake_case). Only the
   **lower-first camelCase supplement** (excludes PascalCase, which hurt aurora P@1) is correct-and-neutral.
   This corroborates the POC: the recall beat is the **graph (slice 4)**, not tokenization.

2. **Aurora's weighted re-rank can't be ported honestly.** Reading `hybrid_retriever.py`: the code-over-md
   effect comes from per-kind weights (dual-hybrid: code leans BM25 0.625 / doc balances 0.5 with
   activation). **It requires ≥2 signals.** With BM25 as litectx's only signal (activation = slice 4), the
   formula degenerates to a bare `doc × w` md-penalty constant — exactly the "penalty hack" the doctrine
   (PRD §5 / ledger §1) forbids. And any *shared* ranking is hostage to the doc/code volume ratio (aurora
   had ~26k lines of md that overpowered code) — uncalibratable across repos.

3. **The user reframed it (the key decision): kinds never share a ranking.** Default-retrieve-everything
   was the self-inflicted problem. Search ONE kind at a time (an agent knows its intent: code / fact /
   episode). The code-over-md burial becomes *structurally impossible*, no weights, no calibration.

---

## What shipped (the reshaped slice 3)

**Invariant (the whole fix):** *no code path ever flattens kinds by score.* `recall` is kind-scoped —
one FTS query per kind, BM25-ranked only against its own kind.

**`recall(query, opts)` — three modes + per-kind `n` (locked with the user):**
| call | shape | default n |
|---|---|---|
| `recall(q, {kind:"code"})` | flat `Hit[]` | 10 |
| `recall(q, {kind:["code","doc"]})` | grouped `{code,doc}` | 5 each |
| `recall(q)` (omitted) | grouped over all `KINDS` | 5 each |
- `n` = max **per kind** (single: per-kind == total). No hard cap, no pagination (dig deeper = bigger n;
  context budget is the caller's, per "no token concerns" doctrine). Polymorphic return pinned by JSDoc
  `@overload` (single→`Hit[]`, grouped→`Record<string,Hit[]>`); generates clean `.d.ts` (TS 5.9.3).
- Omitting kind → grouped-all (safe CLI/agent-forgot default), **never** a flattened ranking.
- `export const KINDS = ["code","doc"]` — canonical vocabulary; grows with fact/episode extractors.

**Kind is the open discriminator; what's gated is *ingestion* of a new kind** (it carries chunking
behavior). Retrieval filters any kind value; adopter-defined kinds at ingestion = a future langdef/chunker
seam (architected-for via the slice-2 registry, deferred).

**Files changed (uncommitted):**
- `src/tokenize.js` — new `indexBody({path,body,extra})`: path-double + raw body + **lower-first camelCase
  supplement** (`camelParts`) + symbol names as `extra`. (deps `importTokens` was built, measured neutral,
  **removed** — rides slice-5 edge extraction.)
- `src/store.js` — `search(match, kind, limit)` now filters `AND kind = ?`; `applyChanges` calls
  `indexBody` (seam rule 1: body construction left `store`).
- `src/index.js` — `recall` reshaped (3 modes, overloads, `n`); `KINDS` export.
- `bin/litectx.js` — `--kind` / `-n` flags; bare `recall` prints grouped top-n per kind (`# code` / `# doc`).
- `poc/bench-lib.mjs` — recall now `{kind:"code", n:DEPTH}` (all dataset targets are code).
- `poc/datasets/aurora-mixed.mjs` — **NEW gate**: aurora's queries, indexing `.py` + `.md` (the code-over-md testbed).
- `test/recall-kinds.test.js` — **NEW, 6 tests**: 3 modes, per-kind `n`, and the core invariant.
- `test/{litectx,incremental}.test.js` — call sites updated to the kind API.
- Docs: PRD §3/§5/§11.2/§12/§15, ledger §1, README, `litectx.context.md`, CHANGELOG — all reframed
  weights→kind-scoping and verified (see below).

---

## DoD gates — ALL GREEN (verified + adversarially checked)
1. **tsc --noEmit** clean; overloads generate correct `.d.ts`. No `!`/`as any`/`@ts-ignore`.
2. **node --test 26 pass / 0 fail** (20 prior + 6 new).
3. **bench:** aurora **0.525** · gitdone **0.415** (both within noise of slice-2 0.523/0.416) ·
   **aurora-mixed `kind:"code"` 0.545** — holds-and-beats the py-only baseline with 196 md docs in the
   index, where a **shared ranking dropped to 0.480 with 12/22 queries prose-buried** (reproduced
   independently). npm pack still 21 files.

**Verification pass (user asked "validate #2 changelog/prd/context"):** reproduced every quantitative
claim from scratch. Caught + fixed: (a) "7 new tests" → **6**; (b) PRD §5 "holds baseline **exactly**
0.525→0.545" → "holds-and-beats" (it's +0.020); (c) gitdone "hold (0.415)" grounded with its 0.416
slice-2 baseline. No stale weighted-re-rank text contradicts the new §5.

---

## NEXT — Slice 4 (ACT-R activation, §4) — where recall first moves beyond BM25
- Git-seeded base-level activation + **decay+churn** (the POC's dropped half — don't ship recency alone) +
  1-hop spreading, layered **within a kind** (the slice-3 invariant holds; never re-rank across kinds).
- Re-run the multi-repo gate **incl. `aurora-mixed`**; adopt only weights **≥ baseline on every repo**
  (the POC's hard rule — gitdone already vetoed flat BLA once). Spreading is the validated winner
  (+0.028 aurora / +0.021 gitdone) but **earns weight in slice 5** once real edges exist.
- `recall` is where the hybrid fusion lands; today it's BM25-only per kind. `activation` module stays
  **pure** (seam rule 3) so the bench can ablate each term.

## Carry-overs / debt (not slice work)
- **deps-in-BM25-body** deferred to slice 5 (reuse the edge extractor's import parse; was neutral solo).
- **`k1`/`b` tuning** deferred (FTS5 `bm25()` is fixed k1=1.2/b=0.75; only matters if we hand-roll scoring).
- Pre-1.0 debt still owed before `0.1.0`: CI (`ci.yml`/`publish.yml`), trusted-publishing OIDC.
- **NOT mine / leave alone:** `docs/00-context/*`, `docs/01-product/litectx-ce-prd.md`, and a stray
  `M docs/01-product/barecontext-prd.md` (modified outside this session — do not fold into a slice-3 commit).

## Memory written this session
- `prefers-discussion-over-multiple-choice.md` (feedback): on design/architecture forks the user wants
  prose + evidence and to steer; reserve `AskUserQuestion` for discrete well-scoped choices. (They twice
  redirected my multiple-choice gates into discussion — which produced the kind-scoping design.)
