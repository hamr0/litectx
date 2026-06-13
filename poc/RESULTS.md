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

---

## Slice-4 Step-0 POC — activation does NOT earn ranking weight (2026-06-05)

Harness: `poc/activation-poc.mjs` (throwaway). Step-0 gate **before** building the git-blame
plumbing (aurora's "336× indexing killer"): the original POC (above) shipped only the
**recency half** of ACT-R base-level and it failed gitdone. Ledger §3 named the missing half —
**type-decay + churn**. The one question: *does git-seeded activation **with** decay+churn (NO
spreading — that's the edge slice) beat plain BM25 on **both** repos?* Adopt a weight only if
`≥ baseline on every repo` (the POC's hard rule; gitdone vetoed flat BLA once already).

Model (PRD §4.1.2): commits as pseudo-accesses. `BLA = ln(Σ max(age_days,1)^-0.5)`;
`decay = (0.40 + 0.1·log10(commits+1)) · log10(max(days_since_last_commit,1))`; `act = BLA − decay`,
min-max normed, fused with BM25. Swept weights 0.1–0.4 for full-activation and recency-only.

```
                 aurora ALL    gitdone ALL    adoptable (≥ baseline both)?
  +bla.4 (rec)   +0.005        -0.030         ✗
  +act.4         +0.009        -0.094         ✗   ← decay+churn made gitdone WORSE
  +act.3 (0.3)   +0.038        -0.034         ✗
  +act.2 (0.2)   +0.060        -0.016         ✗
  +act.1 (0.1)   +0.005        -0.004         ✗   ← only "safe" because ≈ zero
```

**Verdict: FAIL — no weight is ≥ baseline on both repos.** Two findings:

1. **The decay+churn term — the half the ledger said was missing — did not rescue gitdone; at
   co-equal weight it made it *worse* (−0.094 vs −0.030).** Root cause is structural: BLA *and*
   decay-recency both reward recent commits; the only counterweight to "hot file looks relevant"
   is **churn**, which raises the decay rate but only bites *stale* high-churn files. gitdone's
   failure mode is *recently*-churned files — exactly what churn does not catch. So the prescribed
   fix doesn't address the actual failure. Git-seeded base-level activation is simply
   **repo-dependent** (great on aurora, poison on gitdone) — the cardinal sin for a ranking prior.
2. **The only safe weight (0.1) is safe because it contributes ≈ nothing** (gitdone −0.004 = noise).

**Why this is right, not a disappointment.** It re-derives aurora's own structure: aurora never
scored git directly — git **seeded activation** and was **displayed raw**; the scored activation
term rode a *real access log* ("accessed 7x"). litectx v1 has no access log, so the activation slot
is empty and git-alone can't fill it for ranking. POC-first did its job: we learned this **before**
building the expensive per-block blame plumbing, whose only v1 consumer was this signal.

**What this changes (carried into PRD/ledger):**
- **Base-level activation (BLA·decay·churn) is deferred to the access-log future** — litectx's
  long-running-memory differentiator. Schema's `activations` table is reserved; the math is
  validated *then*, on real usage, not git proxy. (PRD §4, §14 #1/#4; ledger §2/§3/§6/§8.)
- **Git becomes passive activity metadata** (commit count + recency, file-level — no blame
  plumbing) shown *alongside* hits as grounding, not a scored term. Mirrors aurora's result card.
- **"ACT-R" in v1 ranking = spreading** (the graph term), which the original POC validated on both
  repos (+0.028 aurora / +0.021 gitdone). It needs edges → it becomes the **next ranking slice**.
- **v1 default ranking = BM25 + spreading** (two zero-ML signals); semantic is the embeddings tier;
  base-level activation is the access-log tier.

---

## Slice-4 spreading Step-0 POC — imports lift recall; calls are for impact, not recall (2026-06-05)

Harness: `poc/spreading-poc.mjs` (throwaway). The original POC validated spreading with **import**
edges only; slice 4 plans **both calls + imports**. Two questions before building the `edges` module:
**Q1** does spreading still lift over the (code-aware) baseline? **Q2** do **call** edges help recall
spreading, or just imports? Edge approximations: imports = run.mjs's `import`/`require` regex;
calls ≈ symbol-def → reference scan (crude, over-links; see caveat).

```
VERDICT — spreading weight ≥ baseline on EVERY repo (ALL MRR):
  ✓ ADOPTABLE  imp.4    aurora +0.028   gitdone +0.021     ← imports: reproduces the original POC
  ✓ ADOPTABLE  imp.3    aurora +0.027   gitdone +0.018
  ✗ rejected   call.4   aurora +0.036   gitdone -0.001     ← calls: great on aurora, dead on gitdone
  ✗ rejected   both.4   aurora +0.036   gitdone -0.004     ← calls DILUTE the import win on gitdone
```

**Findings:**
- **Q1 → YES. Import-edge spreading holds on both repos** (+0.028 aurora / +0.021 gitdone; HARD
  +0.050 / +0.029, gitdone HARD P@3 50%→70%). Identical to the original POC over the slice-3-era
  baseline. **Build it** — recall spreading over import edges, weight ≈ 0.4 (0.3 nearly as good).
- **Q2 → NO (for recall). Call edges do not help recall spreading** — strong on aurora but
  net-neutral/negative on gitdone, and **adding them to imports drags the combined set below
  baseline on gitdone**. Same repo-dependence failure mode as base-level activation: a signal that
  wins on one repo and loses on the other is rejected. **Recall spreading = imports only.**
- **Calls keep their real job: the impact view** (blast radius, slice 5), where over-counting is
  acceptable by doctrine. They are not a recall signal in v1.

**⚠️ Caveat — the call result is SUSPECT, not final.** The call approximation over-links badly
(gitdone: **2069** call-ish edges vs **153** imports, ~13×) because it links any file *mentioning* a
symbol name, not actual call sites. The real tree-sitter call-query + `ripgrep -w` extraction is far
more precise. So the honest read is: *imports-in-recall is confirmed; calls-in-recall is unproven and
looks harmful under a noisy proxy.* Re-test calls-in-recall only with the precise extractor before
ever folding them into ranking — default to **imports-only recall spreading** until then.

**Slice-4 refinement:** recall spreading rides **import edges**; the `edges` module still extracts
**both** (imports for recall, calls for impact/slice-5). Don't fuse calls into recall on spec.

---

## Embeddings POC (post-v1 tier gate) — `embeddings-poc.mjs`

**Question:** does adding a semantic embedding signal to the shipped dual recall (BM25 + 1-hop
import-spreading) measurably beat dual on litectx's OWN benches? (The "~85% → ~95%" figure is
aurora's; validate the lift here before building the tier — POC-first.)

**Method:** BM25 gates a candidate pool (DEPTH 400), embeddings RE-RANK within it (the PRD's "lexical
match gated, then re-weighted"). Local ONNX model `Xenova/all-MiniLM-L6-v2` (384-dim) via
transformers.js — open-source, in-process, no vendor lock-in. File-granularity (matches recall's
gate), head-truncated to 6000 chars. Fused = norm(dualScore) + w·norm(cosine); weight swept.

**Result — PASS, decisively, on BOTH repos:**

| repo | dual (BM25+spread) | tri best | lift | rescued / hurt |
|---|---|---|---|---|
| aurora (482 files, 22 q) | 0.552 | 0.774 (w=1.5) | **+0.222** | 12 / 2 |
| gitdone (100 files, 20 q) | 0.425 | 0.716 (w=1.5) | **+0.291** | 14 / 0 |

Positive at **every** weight (0.3→1.5), monotonic upward, near-zero harm (2 hurt on aurora, 0 on
gitdone). An order of magnitude larger than the spreading lift (+0.01–0.03). **Embeddings earn their
tier.**

**Caveats / build-time notes:**
- **Cold latency confirms why it's opt-in:** ~50s to embed aurora's 482 files (~100ms/file) on CPU.
  This is the cost the PRD flagged — embeddings stay OFF by default, an explicit tier.
- **Weight is NOT tuned yet.** The sweep is monotonic up to 1.5 (the max tested) on the two *tuning*
  repos — production weight needs the held-out check the spreading slice used (multis / aurora-mixed)
  to avoid the overfitting cliff. The gate question (does it beat dual?) is answered; the optimum
  weight + fusion form is a build-time tuning task.
- Only the general model was tested; a code-specific embedding model may lift further (not needed to
  pass the gate). File-level + head-truncation already wins; chunk-level is a build-time refinement.

### Embeddings POC — round 2 (build-claim validation, before shipping to src/)

Validated the three build claims on aurora + gitdone (tuning) + **multis (held-out)**, fusion =
norm(dual) + w·norm(cosine) over the BM25-gated pool:

- **(A) representation — DISTILLED vs HEAD-truncation = a WASH.** Same-weight MRR within noise on all
  three repos (aurora head 0.774 / distilled 0.752; gitdone distilled 0.726 / head 0.716; multis
  distilled 0.774 / head 0.699). Distilled does **not** beat head → **ship head-truncation** (simpler;
  the claimed distillation win didn't materialize, so it doesn't earn its complexity).
- **(B) weight — NO overfitting cliff.** Held-out multis lift stays strongly positive across the whole
  sweep (w0.3 +0.10 → w1.5 +0.24 → w3.0 +0.17), peaking w1–1.5 — unlike the spreading cliff that sank
  the held-out repo at high weight. **Default w=1.0**, conservative: the bench is natural-language-only,
  so semantic isn't over-weighted for the exact-identifier queries it doesn't exercise (aurora keeps
  code-semantic low, 0.2, for that reason). Tunable.
- **(C) search latency — 4–6 ms/query warm** (query-embed + brute-force cosine over the ~400-pool).
  Confirms BLOB + brute-force needs no sqlite-vec; the only real cost is the one-time lazy model load.

**Build decisions locked:** file-level (matches recall's unit), one float32 BLOB per file from
head-truncated text; brute-force cosine over the gated pool; weight 1.0 default; embeddings OFF by
default; transformers.js (Xenova/all-MiniLM-L6-v2) lazy-loaded as an OPTIONAL peer dep.

### Written-memory recall quality + the porter probe (slice-7 follow-through, 2026-06-10)

**Question:** slice 7's tests prove a written fact *survives and surfaces* (boolean) — but is
fact/episode recall any *good*? Facts are short texts; FTS5 has no stemming; the smoke test had
already shown `"refund policy"` missing a fact containing only `"refunds"`.

**Harness:** `poc/memory-bench.mjs` + `poc/datasets/memory-facts.mjs` (`npm run bench:memory`) —
a committed corpus of 24 facts + 5 episodes written via `remember()` (pure-memory mode, no repo,
no `index()`), 32 labeled queries split **exact / morph / para**, with a mechanical **label audit**
(morph/para must share ZERO exact keywords with the target's indexed text — body *and* id, since the
id is indexed; exact must share ≥1). Mislabels fail the run. Mutation-checked three ways (mislabel /
impossible floor / stale `expected` → each exits 1).

**Result (shipped BM25 core):**

| category | MRR | P@1 | meaning |
|---|---|---|---|
| exact | **1.000** | 100% | shared-keyword recall is perfect on this corpus — floored at ≥0.8 |
| morph | **0.000** | 0% | inflectional variants (refund/refunds, cached/caching) NEVER match — FTS5 has no stemming |
| para  | **0.000** | 0% | paraphrase never matches — the embeddings-tier case, as designed |

The morph=0 is **total, not partial** — zero-overlap means BM25 *cannot* retrieve the target at any
rank. For short fact texts this is the dominant real-world failure mode (code recall is shielded by
repeating identifiers; one-sentence facts are not).

**Porter probe (throwaway, 15 min):** same corpus + ranking through an FTS5 table with
`tokenize='porter unicode61'` vs shipped `unicode61`:

| tokenizer | exact | morph | para |
|---|---|---|---|
| unicode61 (shipped) | 1.000 | 0.000 | 0.000 |
| **porter unicode61** | **1.000** | **0.722** | 0.000 |

Porter fixes **all inflectional** morph cases (7/9: refunds, caching, throttled, retried,
pagination, encrypted, migrations — 6 at rank 1, 1 at rank 2) with exact unchanged. The 2 residual
misses are *derivational* ("deployment"→"deploys") and *compounding* ("rollback"→"rolled back") —
genuinely beyond a stemmer. Para stays 0 (porter is not semantics — embeddings remain that tier).

**Open design question (NOT decided here):** the FTS5 tokenizer is **per-table**, and the one `docs`
table holds all kinds — so "porter for facts" is not a one-line flip. Options: (a) porter for
everything → must re-run the aurora/gitdone code gates (stemming identifiers could move them);
(b) a second FTS table for written memory only (recall already queries per kind, so routing is
clean) → no risk to the frozen code gates; (c) query-side expansion. Decide before MCP exposes
written memory to real consumers; the bench is the gate any choice must move (morph `expected` is
pinned at 0.000 and fails on silent change).

**Follow-up — option (a) "porter everywhere" MEASURED (same day):** the docs-table tokenizer was
temporarily flipped to `porter unicode61` and all four recall gates re-run through the real library:

| dataset | baseline MRR | porter MRR | Δ | note |
|---|---|---|---|---|
| aurora | 0.552 | 0.530 | **−0.022** | **FAILS the committed floor (0.550)**; P@1 36→32% |
| gitdone | 0.425 | 0.429 | +0.004 | but **P@1 25→15%** — top-rank precision collapses |
| aurora-mixed | 0.553 | 0.562 | +0.009 | |
| multis | 0.457 | 0.431 | **−0.026** | held-out repo regresses |
| memory-facts morph | 0.000 | 0.722 | +0.722 | the win, confirmed through the real pipeline |

**Verdict: (a) is rejected by the standing rule** ("adopt only if ≥ baseline on EVERY repo" — the
same rule that rejected git-seeded BLA). Two repos regress, one breaks its committed gate, and the
mechanism is the predicted one: in code, word-forms are distinct *symbols* (`token`/`tokens`/
`tokenize`/`tokenizer`), so stemming dilutes identifier distinctiveness — visible as the P@1 drops
even where MRR holds. In prose, forms are the same meaning — so written memory gets the full win.
**→ Option (b): stem written memory only** (its own FTS table or per-kind routing), leaving the
frozen code gates untouched. The schema change rides the next build slice.

---

# Post-slice-7 evidence (slice 11 + access-log tier + v0.5.0)

The sections above are the original §11 gate and the v1 build POCs. The ledger below extends it
with every POC run after the slice-7 write path: the KNN-union memory tier (slice 11), the
access-log tier (5a/5b/5c), and the embeddings-by-default litmus (v0.5.0). Same standing rule
applies — *adopt only if ≥ baseline on EVERY repo* — and it is what falsified two of these into
**views/columns instead of ranking signals**. The benches are committed and runnable.

## Slice 11 — KNN union earns the memory paraphrase tier — `knn-union-poc.mjs`

**Question:** the memory bench (above) showed `para 0.000` and `morph 0.000` — BM25 cannot retrieve
a fact a query shares no words with. Embeddings re-ranking can't fix it either: re-ranking only
reorders the BM25-gated pool, and a zero-overlap paraphrase never *enters* the pool. Does letting
cosine **nominate** (union the K nearest stored vectors into the pool, not just re-rank it) rescue
paraphrase recall **without** hurting exact/morph?

**Harness:** prototype the union inline (not in src/) over the committed `memory-facts` corpus, real
`Xenova/all-MiniLM-L6-v2` model, sweep K (nominee count) × T (min-cosine admission threshold). Union
mirrors the eventual `src/index.js` `_rankKind` fusion: `pool = FTS-gated dual` ∪ `top-K stored
vectors by cosine ≥ T not already in pool`, fused `minmax(dual) + 1.0·minmax(cosine)`.

**Result — PASS, the paraphrase half is recovered with exact/morph held:**

| category | BM25 core | KNN union | meaning |
|---|---|---|---|
| exact | 1.000 | **1.000** | held — nomination never displaces a shared-keyword hit |
| morph | 0.722* | **0.889** | inflectional variants lifted (* stemmed-memory baseline, option (b)) |
| para  | **0.000** | **0.574** | P@3 83% — the zero-overlap case BM25 structurally can't reach |

**Verdict + build decisions locked:** cosine **nominates** for `fact`/`episode` (not just re-ranks),
which is the whole point — the lift is impossible under re-rank-only. The sweep found **no admission
threshold T earns its keep** (any T>0 dropped a real paraphrase before it lifted a wrong one), so the
shipped boundary is **`cos > 0` admits**, `KNN_K = 8`. Strictly-positive-cosine-only, BM25-gated for
exact/morph (cosine never gates *those*). Shipped in slice 11 (v0.3.0); `--embeddings` bench is
gated-when-it-runs and mutation-checked.

## Access-log tier — base-level activation: real *next-edit* signal, but NOT a recall term

This is the term §4 (Slice-4 Step-0) deferred as "git-only base-level is repo-dependent." The
access-log tier revisits it with a *real* signal (witnessed edits, git-replayed as the cold-bench
proxy) and splits one question into two: does the full ACT-R formula predict anything, and may it
touch recall ranking?

### (a) The formula DOES predict next-edit — `edit-bind-poc.mjs`

**Question (PRD §14 #4 / §11.3):** was base-level activation falsified because the *idea* is bad, or
because the POC rebuilt it as a crude half-formula (recency-only, no `count·t^−d` bucketing — the
borrow-ledger §2/§3 thesis)? Non-circular git-replay oracle: walk commits in time order; at commit
N score every previously-seen file by activation from edits in commits `< N`, measure how well each
scorer ranks the files actually edited in commit N (rank-AUC; 0.5 = chance).

**Result:** `BLA > recency > freq > 0.5`, **AUC ≈ 0.79–0.97** across repos. The full aurora
`base_level.py` formula (bucketed `ln(Σ count·age^−d)`) **is a real next-use predictor** — the
original falsification was the half-implementation, exactly as the ledger argued. The idea is
vindicated *for predicting the next edit*.

### (b) …but it must NOT re-rank recall — ships at zero — `access-bench.mjs`

**Question:** can that validated edit-activation be folded into **recall** ranking as a term?
Non-circular: relevance labels are the committed recall ground truth; activation comes from real git
edit history, independent of them. Re-rank the recall pool by `norm(recallScore) + w·norm(editBLA)`,
sweep `w ∈ {0,0.1,0.2,0.3,0.5}` on aurora/gitdone/litectx. **Safety gate (the §7.2 asymmetry —
pollution is the danger): no swept weight may drop MRR below the recall baseline; a lift is reported,
never required.**

**Result — the edit-bind ships at ZERO.** Best MRR is at **w = 0** on the repos; any positive weight
is flat-to-negative and **repo-dependent**. The mechanism is plain: edit-recency answers "what was I
*touching*," which is **topic-blind** — the file you edited last is rarely the file a *query about a
concept* wants. AUC-for-next-edit (a) and MRR-for-relevance (b) are different questions, and the
signal only wins the first.

**Verdict:** base-level activation as a **recall ranking term stays OUT** (the §4 deferral becomes
permanent for recall). The validated next-edit signal instead powers an **isolated read view** —
`recentActivity()` (5a) over a `chunk_edits` table — never search scoring. This is the access-log
tier's core finding: *re-ranking recall by the edit log ships at zero; surfacing the edit log as its
own view ships real value.*

## Access-log tier 5a/5b — the read views compose through the public API

**`recent-activity-eyeball.mjs` (5a):** runs `recentActivity()` through the real pipeline on a real
repo by materializing two committed snapshots (oldRef→newRef) into a temp dir and letting `index()`
witness the span as one edit pass. Confirms the finding-#2 fix — litectx's **tree-sitter chunks give
clean symbol-grain rows** (the function/section actually edited), unlike the original git-funcContext
POC that returned class-level spans for code and random prose for md. Isolated from recall by
construction (reads the edit log, not the ranker).

**`promotion-ladder-poc.mjs` (5b):** proves the episode→fact promotion ladder **composes through the
shipped public API before any src/ method is added.** The new `promotionCandidates` query (hot, fresh,
`provenance='agent'`, 30-day soft-decay floor on `occurred_at`) is run inline and shown to select
exactly the hot/fresh/agent episode while excluding warm/stale/human; the downstream rungs
(`remember` → real `reviewCandidates`) use only shipped API, and "acting on a candidate removes it
from the set" holds (a human re-`remember` flips provenance off `agent`). **PASS** — the rung hands
off cleanly into what exists. Shipped as 5b.

## 5c trust columns — the tie-break is bench-FALSIFIED → surfaced, not scored

The 5c premise was a **trust/stability tie-break** among already-relevant results (more-stable /
human-verified / more-used first). A tie-break is weaker than a re-rank — it only reorders hits whose
relevance is (near-)equal, so it can't cross a relevance gap by construction. Two POCs killed even
that, on both halves of the store.

**Code side — `trust-tiebreak-poc.mjs`:** churn (git commit count, total + 90-day) as the stability
proxy; sweep the tie-band `ε ∈ {0, 0.02, 0.05, 0.1, 0.2}` (fraction of per-query score range),
stable-first inside each band. **Result:** at **ε = 0** (pure exact-score tie) it's a **no-op — code
files almost never tie on BM25** (distinct identifiers → distinct scores). Any **ε > 0** turns it
into a soft re-rank that is **repo-dependent pollution** (the same failure class as git-seeded BLA).
There is no band where stable-first safely helps.

**Facts side — `trust-facts-poc.mjs`:** the facts half has its own ranking domain (the stemmed `mem`
table) and different trust signals (provenance human>agent, recall `use`); no stability signal exists
(no chunks → no churn). Two questions: **(1) empirical** — do short prose facts even *tie* on BM25
often enough for an exact-tie rule to fire? They largely **don't**. **(2) policy** — when they do,
does "human-verified first, then more-used" order them well? **No — it buries better-matching
answers**: provenance is *validation, not quality* (an agent fact can be the better answer), and
`use = 0` is a **fresh win, not a demerit** (a brand-new fact hasn't been recalled yet).

**Verdict:** the trust/stability tie-break is **falsified as a ranking mechanism**. 5c ships the
exact same signals as **surfaced columns** on written-memory hits — `provenance` / `use` /
`occurredAt` — for the agent to weigh, with **ranking left as pure relevance**. "Surfaced, not
scored." (Access-log tier complete: 5a view, 5b ladder, 5c columns — all ship; none touch the
ranker.)

## v0.5.0 — embeddings-by-default litmus — `recall-litmus{,-repos,-expand}.mjs`

**Question:** embeddings shipped opt-in (off by default). Should the **CLI/MCP surfaces** flip it
**on by default**, or can the always-present agent LLM substitute for it via **query expansion** (so
the dep/model cost isn't worth a default)? Three committed harnesses, the standing evidence base for
the v0.5.0 decision.

**(1) `recall-litmus.mjs` — litectx self-queries, naive vs LLM-expanded, BM25 vs emb sweep.** Eight
`src/` targets on this repo with `poc/`+`test/` as distractors. The weak spot reproduces: a fuzzy
prose query ("knn union") lets keyword-dense poc/test chunks **outrank the real `src/`
implementation** under the lexical core. Embeddings and expansion both fix it.

**(2) `recall-litmus-repos.mjs` — aurora/gitdone existing labeled queries, BM25-off vs emb sweep**
(through the real shipped `recall()` path, n=10):

| repo | BM25 | embeddings (w=1.0) | Δ MRR | misses |
|---|---|---|---|---|
| aurora | 0.543 | **0.758** | +0.215 | ~4 → 1 |
| gitdone | 0.411 | **0.644** | +0.233 | ~4 → 1 |

A big, consistent lift on natural-language code queries; P@1 ~doubles. **`w = 1.0`** (the shipped
default) is best — no recalibration needed.

**(3) `recall-litmus-expand.mjs` — +LLM-expansion arm.** Free in-agent query expansion (domain
synonyms + likely identifiers, authored from intent, not from reading the targets) **recovers
~90–95% of the embeddings lift and erases the misses** — but it is **non-binding**: an agent *may
skip it*, and the author had prior repo exposure (an optimistic ceiling). So expansion is a real
mitigation but not a floor.

**Verdict (v0.5.0):** embeddings is the **reliable accuracy floor** that doesn't depend on the agent
remembering to expand; the memory paraphrase half (0.000→0.574, slice 11) is near-essential and has
*no* lexical substitute. So the **agent-facing surfaces (CLI + MCP) default embeddings ON**
(`--no-embeddings` opts out), while the **library `LiteCtx` default stays `false`** so lib consumers,
all tests, and the BM25 gates remain byte-identical. `@xenova/transformers` → `optionalDependency`
(auto-installed best-effort, graceful BM25 fallback if absent). The earlier "15–19s cold latency" was
aurora's mis-borrowed torch figure — measured transformers.js/ONNX is **~2.1s first download · ~0.72s
cached · ~6ms warm**, model **~23 MB**; the real cost is the dep + index-time embedding, not query
latency.

## Track-2 POC — `assemble(units, ctx)` budget-fit preserves task success (2026-06-12)

**Question (the one unproven RT-1 claim, CE-PRD §8.2):** fitting a multi-round transcript to a token
budget is trivially possible; the gate is whether it drops the unit a *later round re-reads*.
Dropping a stale tool-result is safe; dropping the one about to be re-read is a **silent regression**.

**Method (`poc/assemble-fit-poc.mjs`, prove-don't-assert):** replay **8 real Claude Code session
transcripts** across 8 different projects (not one — no single-session overfit), map each to the RT-1
neutral unit stream `{id,role,content,kind,pinned,atomic,tokensApprox}`, and extract dependency
ground-truth **mechanically** (never hand-labelled — the [[chunker-orphans-leading-docs]] crafted-bench
trap): `edit-after-read` (an `Edit`/`Write(P)` needs the most-recent `Read`-result of `P` in context)
and `re-read` (a second `Read(P)`). **1059 real deps.** Fit policies never peek at the dep edges.
`tokensApprox = chars/4`. Outcome proxy = *is the needed unit still in the assembled window* (the
structural precondition for the Edit's `old_string` to match; a live LLM is not re-run — stated limit).

**Results (silent-regression rate = needed unit dropped before its re-read):**

| policy @ budget | violRate | avg window |
|---|---|---|
| recency @10% | 31.4% | 12% |
| recency @25% | 16.6% | 27% |
| **recency @50%** | **1.8%** | 44% |
| salience(recency+bounded-relevance) @50% | 1.9% | 44% |

**Findings.**
1. **A recency-anchored fit preserves task success.** At a 50% budget it loses **1.8%** of 1059 real
   re-read deps; the loss grows only as the budget tightens (16.6% @25%, 31.4% @10%) — and the spread
   across the sweep proves the deps are genuinely long-range (e.g. `mailproof` 86% @10%, all
   edit-after-read), not trivially recent.
2. **Semantic re-ranking of the transcript does NOT help and slightly hurts** — re-reads are
   *recency-bound, not topic-bound*. (Honest correction: an early unbounded-overlap salience scored
   far worse; that was a weight mis-scaling, not a truth. With a bounded jaccard nudge it washes out.)
   This is a *discovered design constraint*, matching RT-1's cache-stable / recency-anchored order
   doctrine — not an assumption carried in.
3. **The restorable handle (R-C4 `dropped[]`/`rehydrate`, already POC'd in `ri3-handle-poc.mjs`) is
   LOAD-BEARING, not optional** — it converts the residual silent loss into an *explicit* re-read
   round (costs a round-trip, never silent data loss). Must ship *with* `assemble`, not after.
4. **Conservative floor:** this models **drop-only**. Real `assemble` adds **COMPRESS** (down-tier a
   non-needed unit to `signature` instead of evicting it), which can only *free budget to keep more
   needed units verbatim* → violRate is an upper bound. Not measured here (would need per-unit
   signature costing); claimed as headroom, not a number.

**Verdict: PASS — `assemble()` is safe to build**, with the constraints the replay pinned: fit is
**recency-anchored** (semantic re-rank off for the transcript path), `pinned`/`atomic` invariants hold
by construction, and **`dropped[]`-with-handle ships in the same slice** (the residual loss has nowhere
else to go). Next: build `assemble(units, ctx)` over the neutral unit shape, reusing `recall({body:true})`
(units need bodies) and `compress()` (the COMPRESS tier).

### Track-2 "last bit" — live-model confirmation of the structural proxy (2026-06-13)

The drop-replay above measured a *structural proxy* ("needed unit survived in the window"). This
closes the gap with a **real model in the loop** (`poc/assemble-fit-model-poc.mjs`): on 8 clean
edit-after-read cases across 8 projects, ask `claude -p` (sonnet, **tools OFF** — it can't go re-read
the file and cheat) to produce the exact `old_string` an `Edit` replaces, with the needed Read result
**PRESENT vs ABSENT** in the assembled window — everything else held equal. Success = the returned
anchor is a real substring of the file. Majority of 3 samples/cell.

| | PRESENT | ABSENT |
|---|---|---|
| cases passing (majority of 3) | **8/8** | **0/8** |
| raw valid draws | 24/24 | 2/24 |

Keeping the re-read unit → the model reproduces the correct edit anchor every time; dropping it → it
collapses to ~0 (the 2 stray ABSENT draws were short, guessable anchors like a function signature),
and typically returns `CANNOT_DETERMINE` — an **explicit, non-silent** failure that the R-C4
`dropped[]`/`rehydrate` handle recovers in one re-read. **The proxy is real, not an artifact.**

**Honest process note (prove-don't-assert).** The first run looked noisy (PRESENT 6/8, one *inverted*
row) — every "anomaly" turned out to be a **measurement bug, not a finding**, and only running again
surfaced them: (1) a scorer that stripped triple-fences but not inline backticks silently failed a
*correct* answer; (2) single-sample cells flipped between runs (→ majority-of-3); (3) the harness's own
`claude -p` calls wrote new transcripts into the live corpus mid-run (→ skip transcripts modified
<120 s ago); (4) a self-inflicted array-aliasing bug (`chosenF = chosen` then `chosen.length = 0`
emptied both) printed "no clean cases" while selection had genuinely found 8. The clean 8/8-vs-0/8
only appeared after each was fixed. Also surfaced: ~5/13 candidate cases were **leak-rejected** because
the file content was *redundantly* present (re-reads, prior edits) — which independently supports
budget-fit safety (dropping one copy rarely removes the information).

**Combined Track-2 verdict (structural + model): PASS, build `assemble()`** — recency-anchored fit,
`pinned`/`atomic` invariants, `dropped[]`-with-handle in the same slice.

### Track-2 build verification — SHIPPED `assemble()` vs the POC, and a correction (2026-06-13)

After building `src/assemble.js`, ran the **exported verb** over the same 8 real transcripts
(`poc/assemble-verify-shipped.mjs`) to check it reproduces the POC — because the unit tests in
`test/assemble.test.js` are author-written and confirmatory (they guard the invariants, they don't
re-prove the real-data claim). It **does not exactly match**, and the gap is a real finding:

| | @25% | @50% |
|---|---|---|
| POC inline fit (`assemble-fit-poc.mjs`) | 16.6% | 1.8% |
| **shipped `assemble()`** | **19.0%** | **3.8%** |
| mailproof (longest-range) | 82% | **23% (POC: 2%)** |

**Root cause (instrumented, not guessed).** The POC's inline fit completed atomic groups with a
post-hoc `ATOMIC_WHOLE` pass that had **no budget check**: a needed *old* read's tiny tool-*call*
(~18 tok) could slip in under budget during the greedy pass, then group-completion dragged its large
*result* (~1.2k tok) in too — **keeping it by overflowing the budget**. The shipped verb fits whole
atomic groups **budget-honestly** (an over-budget group drops whole), so long-range reads that sit past
the budget boundary fall out of the window. On `mailproof` (94 deps, the longest-range set) this flips
2% → 23%.

**The correction (prove-don't-assert).** **The POC's 1.8%@50% was optimistic — an overflow artifact.
The budget-honest cost is 3.8%@50%** (single-digit aggregate still; but long-range-heavy sessions pay
more). This does **not** weaken the verdict — it **strengthens** the load-bearing role of
`dropped[]`-with-handle: a budget-honest fit drops *more* long-range reads, and the rehydrate re-read is
exactly what recovers them (the model's `CANNOT_DETERMINE` → re-read path, confirmed by the live-model
A/B, which is independent of this — it compared PRESENT vs ABSENT directly, not via a fit policy).
The shipped verb is kept as-is (budget-honest is correct); the number is corrected to 3.8%.

### Track-2 SELECT leg — can recall RE-SUPPLY the off-window chunk? (2026-06-13) — `assemble-select-poc.mjs`

**Question (the unproven SELECT assumption, CE-PRD §8.1).** `assemble` v1 is FIT-only. The FIT
model POC proved that dropping the unit a later action needs makes the model fail. SELECT's promise
is that litectx can put that off-window context **back by retrieving it from the graph index** — but
that only helps if recall can find it. The recall benches use *curated* dev questions; at the
assemble moment there is no curated query, only **in-window signal** (what the agent is doing now).
Can recall, queried with that alone, surface the chunk the next action needs?

**Method (prove-don't-assert, no hand-labels).** Reuse the FIT POC's mechanical edit-after-read
cases (an Edit whose `old_string` ≥24 chars is a real substring of the most-recent Read result of
that file — the off-window chunk a budget drops). Index each transcript's **live repo** with litectx;
query recall with **in-window signal only** — target file basename + identifiers from the agent's
recent text + identifiers from the `new_string` it is writing — **never the `old_string`** (that is
the answer we test retrieval of; peeking is the crafted-bench cheat). 8 repos, 43 cases.
- **PRIMARY (drift-robust):** does the target file path appear in top-K? (file-level re-supply)
- **SECONDARY (strict):** on files that did NOT drift (old_string still on disk), does the chunk
  **body** holding the needed bytes come back? Drift makes this unscorable elsewhere (the edit
  already replaced `old_string`), so it is reported only on the unchanged subset.

**Four harness bugs surfaced by *running* (every one printed a clean but false 0%):** (1) on-disk
cache reused a partial db; (2) transcript `file_path` is **absolute** (and uses the `/Documents`
symlink) while `hit.path` is repo-relative → path compare + disk read both silently failed; (3) the
biggest — `new LiteCtx({dbPath})` **creates the db file in its constructor**, so the `existsSync`
guard was always true → `index()` skipped → every cached db was empty. Each "0%" was a measurement
bug, not a result. (Reinforces [[prove-dont-assert]] / [[verify-shipped-against-poc-data]].)

**Result (BM25-only; embeddings ON ≡ OFF, see below).**

| metric | rate |
|---|---|
| file-level re-supply | **24/43 = 56%** (median rank **1**) |
| exact-chunk re-supply (unchanged files) | **6/24 = 25%** |
| …**ex-dominant-repo** (drop the top contributor) | **0/13 = 0%** |

The 56% file-level number is bimodal and **mailproof-dominated** (mailproof 13/13 @100%, latefyi
75%; dwi 0%, plato 20%, litectx 25%). The strict chunk-level metric — did the bytes the action needs
actually come back — is **25%, and 0% outside the single repo that carries it**. It does not
generalize. **Embeddings ON changes nothing** (byte-identical): code recall is **BM25-gated** (cosine
re-ranks the FTS candidate set, never *nominates* for code — KNN-union is fact/episode only), so the
misses are lexical-gate misses the in-window query can't anchor, which cosine cannot recover.

**Verdict: auto-SELECT keyed on in-window task text is NOT a dependable re-supply signal** (chunk-level
~0 outside one repo). Two honest consequences, both shaping the SELECT+COMPRESS slice:
1. **"Re-supply the file I'm editing" is a DIRECT PATH FETCH** (`get`/`impact` by path — near-100%,
   no lexical gamble), not lexical recall. SELECT should not route that case through recall.
2. **recall-SELECT's real value is the NEVER-read related file** (a callee def the agent never opened)
   — which this mechanical proxy *cannot* label, and which needs an **explicit, agent-supplied query**,
   not auto-derived task text.

→ **Do NOT build auto-SELECT on in-window signal.** Either scope SELECT to path-fetch re-supply, or
POC the never-read mode with an explicit query before committing the slice. The role-boundary decision
with bareagent (#2) is downstream of *this* — there is no point settling "what role injected context
carries" until we know which injection mode SELECT actually ships. POC throwaway; role= placeholder
throughout (never handed to a provider — the keystone boundary is untouched).

**Two rigor checks closing self-gloss risks (the verdict is consequential + negative, so it earns
them):**
- *Is the embeddings claim asserted or verified?* The emb db holds **74 stored vectors** and recall
  reranks **measurably differently** from BM25 on NL queries (verified A/B, `/tmp/embverify`). So the
  tier is **live**; "ON ≡ OFF on these cases" is real FTS-gate-binding (the target isn't in the
  candidate set for cosine to reorder), not a silently-dead tier. Mechanism now stands on evidence.
- *Is the negative verdict an artifact of one query recipe?* Ablated `QUERY_MODE` floor→upper:
  `min` (basename only) 25% / ex-dom 8% · `rich` 25% / 0% · `upper` (full `new_string`, max legit
  signal) **21% / 0%**. Chunk-level re-supply is **flat across the spectrum** — more in-window signal
  does not help (the bottleneck is the FTS gate + chunk localization, not query richness; richer query
  only improves the *rank* of files already gated in, 3→1). The verdict is robust, not recipe-bound.

**Honest limitations (scope, not gloss).** (a) Strict metric n is small — 24 unchanged files, 13
ex-mailproof; the 0–8% ex-dominant is directionally clear but low-precision. (b) This proxy can only
measure the **re-supply** mode (edit-after-read has mechanical ground truth). SELECT's actual value —
injecting a **never-read** related file — has **no mechanical ground truth without hand-labelling**
(the crafted-bench trap), so this POC *redirects* the slice; it does not settle whether
explicit-query SELECT is worth building. That is the next POC, and its open methodological question is
how to label "needed a related file" mechanically (candidate: the agent's *own later Read* of a
graph-adjacent file — future behavior as the label, gated by a real impact edge).
