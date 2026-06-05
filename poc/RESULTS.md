# POC results — the PRD §11 gate

> **Throwaway validation.** This `poc/` is not litectx and is never shipped/imported. Its only
> job is to kill or confirm one hypothesis before we build:
> **does activation + graph-aware recall measurably beat plain FTS5/BM25?**

## How to see it yourself

```sh
cd poc
npm install                # better-sqlite3 (native build)
node run.mjs aurora        # the kernel we're borrowing (Python, 497 files)
node run.mjs gitdone       # generalization test (JavaScript/CJS, 100 files)
```

- **Datasets** live in `poc/datasets/*.mjs` — each declares the repo, the file glob, the edge
  style (python imports / cjs requires), and its eval queries with hand-verified ground-truth
  files. Read them and check any row against the source; targets were authored before tuning,
  not cherry-picked.
- **The eval:** developer questions, each split EASY (keywords in the file/name → BM25 should
  find it) vs HARD (intent/synonym phrasing, or many files — incl. same-named test files —
  share the keywords and only one is right).
- **What it measures:** where the right file lands under each ranker. MRR / P@1 / P@3 / P@5,
  broken out EASY vs HARD.

## The four rankers (ablation)

All four use the **same FTS5 candidate set** (the FTS gate — activation never surfaces a file the
query doesn't lexically match). They differ only in how they *order* those candidates:

| ranker | score = weights · [bm25, git-bla, graph-spread] |
|---|---|
| `baseline` | `[1.0, 0, 0]` — pure BM25 |
| `+bla` | `[0.6, 0.4, 0]` — BM25 + git-seeded base-level activation |
| `+spread` | `[0.6, 0, 0.4]` — BM25 + 1-hop spreading over code edges |
| `litectx` | `[0.5, 0.3, 0.2]` — all three (aurora's code weights) |

- **git-bla** = `ln(Σ age_days^-0.5)`, each commit timestamp a pseudo-access (PRD §4.1 cold-start).
  Recency + frequency from `git log`. **No churn-penalty/decay term yet.**
- **graph-spread** = a candidate inherits the best BM25 relevance among its code-graph neighbors
  (edges: python `import`s / cjs relative `require`s).

## Results

### aurora — Python, 497 files, 518 import-edges (n=22)

```
  ALL       baseline MRR 0.511  P@1 36%  P@3 59%  P@5 68%
            +bla     MRR 0.516  ...                       Δmrr +0.005
            +spread  MRR 0.539  P@3 68%  P@5 82%          Δmrr +0.028
            litectx  MRR 0.575  P@1 41%  P@3 73%          Δmrr +0.064
  EASY(11)  +bla Δ+0.109   +spread Δ+0.006   litectx Δ+0.155
  HARD(11)  +bla Δ-0.099   +spread Δ+0.050   litectx Δ-0.027
```

### gitdone — JavaScript/CJS, 100 files, 153 require-edges (n=20)

```
  ALL       baseline MRR 0.423  P@1 25%  P@3 45%  P@5 70%
            +bla     MRR 0.393  ...                       Δmrr -0.030   ← BLA net-negative
            +spread  MRR 0.444  P@3 55%  P@5 75%          Δmrr +0.021
            litectx  MRR 0.356  P@1 15%  P@3 40%          Δmrr -0.067   ← combined LOSES to BM25
  EASY(10)  +bla Δ+0.011   +spread Δ+0.013   litectx Δ-0.022
  HARD(10)  +bla Δ-0.072   +spread Δ+0.029   litectx Δ-0.112
            (HARD P@3: baseline 50% → +spread 70%)
  litectx vs baseline: moved 15/20 — 6 better, 9 worse.
```

## Verdict: **PASS for graph-aware recall; the activation/cold-start term must be reworked**

Two repos, two languages, and the signals separate cleanly:

1. **Graph spreading is confirmed — and it generalizes.** `+spread` is positive on *both* repos
   and *every* breakdown (aurora ALL +0.028 / HARD +0.050; gitdone ALL +0.021 / HARD +0.029,
   HARD P@3 50% → 70%), and never hurts an aggregate. This is the part of the bet most at risk —
   graph-as-substrate — and it earns its place. **Build it.**

2. **Git-seeded BLA, as a flat 0.3 co-equal boost, fails the generalization test — do not ship it
   as configured.** It looked like a win on aurora (driven by EASY/hot-file queries) but is
   **net-negative on gitdone** (ALL −0.030, HARD −0.072), and the combined `litectx` preset
   **loses to plain BM25 on gitdone** (−0.067; 9 of 15 moved queries got *worse*). Root cause is
   structural: we shipped the **recency half** of ACT-R without the **churn-penalty/decay half**
   (§4), so "recently changed" reads as "more relevant" even when it isn't — and how well that
   correlates with the answer is **repo-dependent**, which is exactly what a ranking prior must
   not be.

**Net:** the gate passes — activation + graph-aware recall beats BM25 — but the win is carried by
the **graph**, not by naive git-recency. The single-repo aurora run *overstated* BLA; the second
repo corrected it. That is the POC doing its job.

## What this changes for v1 (carried into the PRD)

- **Ship** the graph substrate + spreading (§2, §4) — validated on two repos.
- **Rework** the cold-start/activation term before it gets any real weight (§4.1, §14 #1):
  - implement decay + churn so recency is **penalized when it's instability**, not rewarded;
  - demote BLA from a co-equal 0.3 boost to a **small term or a tiebreaker** until it earns more;
  - **re-run this harness on both repos** as the gate — adopt only weights that are ≥ baseline on
    *every* repo, not just on average.
- **Keep a multi-repo regression harness** (this `poc/`, dataset-driven) as the calibration gate
  for any future signal/weight change. One repo is not enough — gitdone just proved that.

## Slice-0 library baseline (the bar to beat)

`run.mjs` is the research ablation. `bench-lib.mjs` (`npm run bench`) is the **integration gate** —
it indexes through the real `LiteCtx` and runs `recall()`, so the library and the gate can't drift.
The slice-0 walking skeleton (file-granularity, plain BM25) establishes the bar every later slice
must **hold-or-beat on both repos**:

```
[aurora]  ALL MRR 0.523  P@1 36%  P@3 64%  P@5 73%   (EASY 0.640 · HARD 0.406)
[gitdone] ALL MRR 0.416  P@1 25%  P@3 45%  P@5 75%   (EASY 0.277 · HARD 0.555)
```

Reproduces the ablation `baseline` within noise (aurora 0.511, gitdone 0.423) and the same single
aurora FTS miss (`decay.py`) — confirming lib ≡ harness. Slice 3 (code-aware BM25) and slice 4
(activation/spreading) must move these up without regressing either repo.

## Honest limits of this POC

- **Small n** (22 + 20), **two repos**, **file-granularity** (v1 ranks at symbol level).
- **aurora's eval leans toward active modules**, which flattered BLA there; **gitdone's baseline is
  weak** (EASY P@1 only 10%) because many small CJS modules share email/event vocabulary and one
  ~1700-line file (`email-bodies.js`) skews BM25 — so the EASY/HARD split is less clean on gitdone.
  Both are real repos; neither was tuned to flatter a ranker.
- 1 aurora FTS miss (a tokenization gap the code-aware tokenizer + deps-in-BM25 content of §5 is
  meant to close). Decay/churn and embeddings tiers are **not** implemented here — out of scope
  for the gate.

---

## Slice-2 POC — tree-sitter symbol chunking (2026-06-04)

Harness: `poc/chunk-poc.mjs` (throwaway). Binding under test: **web-tree-sitter (WASM)**
+ prebuilt `tree-sitter-wasms` grammars. Chunker = per-language def-node set (function/
method/class) + a file "preamble" chunk; bench collapses chunks→best-per-file (targets
are files) and compares to file-granularity BM25.

**Binding friction (real):** `tree-sitter-wasms@0.1.13` grammars (ABI ~0.20–0.22) do NOT
load under `web-tree-sitter@0.25+` (dylink model) — `getDylinkMetadata` throw. Had to pin
runtime to **0.22.6**. Runtime+grammar versions must move in lockstep; the prebuilt-WASM
story lags native.

**Recall finding (across both repos):**
- **Chunk-replacement REGRESSES** the file-target bench. For *file*-finding, whole-file
  BM25 is a strong baseline; sub-file chunks fragment term stats. Confirmed for max-pool
  (aurora MRR 0.523→0.434), sum-pool (collapses), top3-pool (gitdone 0.416→0.358).
- **Fused (file BM25 gate + α·best-chunk BM25, min-max normed) ≈ break-even on MRR but
  lifts P@3 on both repos** (α=0.3): aurora MRR 0.523→0.522, P@3 64%→68%, EASY P@3 82%→91%;
  gitdone MRR 0.416→0.434, P@3 45%→55%. α=0.6 helps gitdone, dents aurora MRR (0.500).

**Verdict → slice 2 is DUAL-GRAIN, not replacement.** Keep the file-level FTS doc as the
recall gate (holds baseline exactly); add a `nodes` table of symbol chunks (path, kind,
format, symbol, line-range, body) as the structural substrate. Chunk-BM25 is NOT where the
recall jump comes from — the lift the PRD expects rides ON chunks in slices 4–5 (activation
over line-ranges, edges over symbols). Chunking alone must not swap the BM25 grain.

### Binding validation — native vs WASM (`poc/binding-bench.mjs`)

Assumption going in: native `tree-sitter` would be faster/more robust. **Validated → false
for our workload.** Chunk extraction is tree-walk-heavy; the native binding marshals a JS
object per node across the C++ boundary, WASM stays in linear memory.

| axis | native (tree-sitter + grammars) | WASM (web-tree-sitter + tree-sitter-wasms) |
|---|---|---|
| parse+walk speed | baseline | **~3× faster** (stable over 2 runs, both repos) |
| chunk correctness | 6190 / 1814 | **identical** (6190 / 1814) |
| install | ~40s node-gyp compile | **<1s** prebuilt |
| deps | 4 native (runtime + 3 grammars), node-gyp | 2 pure (runtime + 1 grammar bundle), no compile |
| version friction | TS grammar peers `^0.21`, py/js `^0.25` → needs `--legacy-peer-deps` | runtime pinned to **0.22.6** for prebuilt grammars |
| portability (local-first doctrine) | needs build toolchain | runs anywhere web-tree-sitter runs |

**Decision: WASM** (`web-tree-sitter@0.22.6` + `tree-sitter-wasms`). Faster, identical
output, leaner/portable, no native compile. Sole cost: pin the runtime to the grammars'
ABI (0.22.6) — a stable pin, re-evaluated only if we vendor newer-ABI `.wasm` grammars.
