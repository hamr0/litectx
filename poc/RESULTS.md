# POC results — the PRD §11 gate

> **Throwaway validation.** This `poc/` is not litectx and is never shipped/imported. Its only
> job is to kill or confirm one hypothesis before we build:
> **does activation + graph-aware recall measurably beat plain FTS5/BM25?**

## How to see it yourself

```sh
cd poc
npm install          # better-sqlite3 (native build)
node run.mjs         # indexes aurora's 497 .py files, runs the eval, prints the tables
```

- **What it indexes:** every tracked `.py` in the aurora repo (the kernel we're borrowing).
- **The eval:** 22 developer questions with a hand-verified ground-truth file each
  (`queries.mjs`), split 11 EASY (keywords in the file/name → BM25 should find it) and
  11 HARD (intent/synonym phrasing, or many files share the keywords and only one is right).
- **What it measures:** for each query, where the right file lands under each ranker.
  MRR / P@1 / P@3 / P@5, broken out EASY vs HARD.

The eval set was authored *before* tuning, from a read of aurora's actual modules — the targets
are not cherry-picked to make activation win. Read `queries.mjs` and check any row against the
aurora source.

## The four rankers (ablation)

All four use the **same FTS5 candidate set** (the FTS gate — activation never surfaces a file the
query doesn't lexically match). They differ only in how they *order* those candidates:

| ranker | score = weights · [bm25, git-bla, graph-spread] |
|---|---|
| `baseline` | `[1.0, 0, 0]` — pure BM25 |
| `+bla` | `[0.6, 0.4, 0]` — BM25 + git-seeded base-level activation |
| `+spread` | `[0.6, 0, 0.4]` — BM25 + 1-hop spreading over import edges |
| `litectx` | `[0.5, 0.3, 0.2]` — all three (aurora's code weights) |

- **git-bla** = `ln(Σ age_days^-0.5)` with each commit timestamp as a pseudo-access (the PRD §4.1
  cold-start unification). Recency + frequency, straight from `git log`. No churn-penalty term yet.
- **graph-spread** = a candidate inherits the best BM25 relevance among its import-graph neighbors
  (edges regex-extracted from `from/import` statements; 518 intra-repo edges).

## Results (n=22, aurora @ 750a39d, 497 files)

```
  ALL
    baseline  MRR 0.511  P@1 36%  P@3 59%  P@5 68%
    +bla      MRR 0.516  P@1 36%  P@3 59%  P@5 73%   Δmrr +0.005
    +spread   MRR 0.539  P@1 36%  P@3 68%  P@5 82%   Δmrr +0.028
    litectx   MRR 0.575  P@1 41%  P@3 73%  P@5 77%   Δmrr +0.064

  EASY (11)
    baseline  MRR 0.580  P@1 36%  P@3 73%  P@5  91%
    +bla      MRR 0.689  P@1 55%  P@3 73%  P@5 100%   Δmrr +0.109
    +spread   MRR 0.586  P@1 36%  P@3 82%  P@5 100%   Δmrr +0.006
    litectx   MRR 0.735  P@1 55%  P@3 91%  P@5 100%   Δmrr +0.155

  HARD (11)
    baseline  MRR 0.441  P@1 36%  P@3 45%  P@5 45%
    +bla      MRR 0.342  P@1 18%  P@3 45%  P@5 45%   Δmrr -0.099   ← BLA HURTS hard queries
    +spread   MRR 0.491  P@1 36%  P@3 55%  P@5 64%   Δmrr +0.050   ← spread helps everywhere
    litectx   MRR 0.414  P@1 27%  P@3 55%  P@5 55%   Δmrr -0.027
```

## Verdict: **PASS — build v1**, with one calibration correction

1. **The hypothesis holds overall.** litectx beats plain BM25 on every aggregate metric
   (MRR +0.064, P@3 +14pts). Re-ranking moved 13/22 queries — 9 better, 4 worse.

2. **Graph spreading is the robust differentiator.** `+spread` is the *only* signal that improves
   the HARD set (and never hurts): HARD P@5 45% → 64%, P@3 45% → 55%. This is the part of the bet
   most at risk — graph-as-substrate — and it earned its place.

3. **Git-seeded BLA, as a flat 0.3 weight, is too aggressive — it must be corrected before v1.**
   It's a big win on EASY/hot-file queries (P@1 36% → 55%) but it *hurts* HARD (P@1 36% → 18%),
   because it boosts recently-**churned** files whether or not they answer the query. The cause is
   structural: we implemented the **recency half** of ACT-R and not the **churn-penalty / decay
   half** (§4). Half of activation is worse than none on hard queries.

## What this changes for v1 (carried into the PRD)

- **Keep** the graph substrate + spreading — confirmed (§2, §4).
- **Correct** the cold-start model (§4.1, open question #1): git recency is a useful prior **only
  paired with the churn/decay term** — recently-churned ≠ more relevant. Implement decay+churn
  before weighting BLA, and weight BLA gentler than 0.3 (or as a tiebreaker). Re-run this harness
  after, expecting the HARD regression to flip positive.

## Honest limits of this POC

- **n=22, one repo, file-granularity** (not symbol-level as v1 will be).
- The eval leans toward **active modules** (the interesting ones), which flatters BLA's recency on
  EASY; a colder query set would shrink that win.
- **1 FTS miss** ("penalize unstable frequently-changing code") — no ranker can rank a target the
  FTS gate never surfaces. That's a tokenization/chunking gap (the file talks about "churn"/
  "instability", not the query's words), not a ranking failure — and exactly what the code-aware
  tokenizer + deps-in-BM25 content (§5) is meant to close.
- Decay/churn and embeddings tiers are **not** implemented here — out of scope for the gate.
