# Aurora Borrow Ledger

**Purpose.** litectx reimplements aurora's *validated* signal algorithms in clean ESM JS —
**borrow the concept + the calibration, not the code** (CLAUDE.md doctrine; PRD §12). The POC
drifted because the tuned constants lived nowhere in this repo, so the activation signal got
rebuilt as a crude half-formula (`ln(Σ t^−0.5)` recency only — **no churn, no type-keyed decay**),
and "BLA doesn't generalize" got mistaken for a finding about the *idea* rather than the
*half-implementation*. This ledger is the written contract that prevents that: every formula and
constant below is **verified against aurora source** (file:line) so build slices borrow from a
spec, not from memory.

**Provenance.** aurora `@ 750a39d` (main), repo `/home/hamr/PycharmProjects/aurora`. Re-verify
file:line if aurora moves.

**Doctrine reminders.**
- Reimplement clean; do **not** port aurora's plumbing (pools, retries, metrics, LSP, soar/cli).
- Aurora is a **second opinion, not an oracle**. These are *starting* values — the `poc/`
  multi-repo gate decides. Adopt a borrowed weight only if it holds-or-beats baseline on **both**
  repos. Divergence from aurora is a question to investigate, not a bug to fix toward aurora.
- Two **intentional** divergences (concept borrowed, mechanism not): **no LSP** (refs via
  ripgrep `-w` + tree-sitter), **embeddings off by default** (dual-hybrid spine, semantic is a tier).

---

## The output contract (what the signals render to)

```
BM25:       0.895   keyword match (normalized 0–1)
Semantic:   0.865   embedding cosine (opt-in tier only)
Activation: 0.014   ACT-R: BLA + spreading + context_boost − |decay|, normalized
Git:        7 commits, modified 8d ago, <epoch>     cold-start + churn source
Used by:    2 files, 2 refs, complexity 44%, risk MED   impact view
```

---

## 1. BM25 — `bm25_scorer.py`

- **Formula:** Okapi BM25, `score = Σ IDF(qi)·(f·(k1+1)) / (f + k1·(1 − b + b·|D|/avgdl))`
  (`bm25_scorer.py:137`); `IDF = log((N − n + 0.5)/(n + 0.5) + 1)`.
- **Constants:** `k1 = 1.5`, `b = 0.75` (`bm25_scorer.py:164`).
- **litectx target:** **slice 3** (code-aware BM25). v1 uses FTS5's native `bm25()`; the `k1/b`
  matter only if/when we hand-roll scoring. Carry the **two-stage retrieval** (FTS5 top-100 gate →
  re-rank) and the **code-over-md** structural fix here, not a penalty hack.

## 2. Base-level activation (BLA) — `base_level.py`

- **Formula:** `BLA = ln(Σ_j count_j · t_j^−d)`, `t_j` = seconds since access j; `t≤0 → 1`
  (`base_level.py:147–167`). Bucketed history: `count_j > 1` = multiple accesses at bucket midpoint.
- **Constants:** `decay_rate d = 0.5`; `default_activation = −5.0` (no history); `min_activation = −10.0`
  (floor). (`base_level.py:78–86`).
- **litectx target:** **slice 4**. No access log in v1 → seed from git (§8 below). Keep the bucketed
  `count·t^−d` shape so a real access log slots in later.

## 3. Decay — type-keyed + churn — `decay.py`  ★ the part the POC dropped

- **Penalty formula:** `decay = −decay_factor · log10(max(1, days_since_access))`, capped at
  `max_days`, floored at `min_penalty`; `0` within the grace period (`decay.py:194–200`).
- **Effective decay rate is NOT flat** — it is keyed by `kind` and adjusted by churn:
  `effective = DECAY_BY_TYPE[kind] + CHURN_COEFFICIENT · log10(commit_count + 1)`.
- **`DECAY_BY_TYPE`** (`decay.py:53`): `kb 0.05 · class 0.20 · function 0.40 · method 0.40 ·
  code 0.40 · soar 0.30 · doc 0.02 · toc_entry 0.01`. (Stickiness: docs ≫ classes ≫ functions.)
- **Churn** (`decay.py:66–68`): `CHURN_COEFFICIENT = 0.1` → high-commit files decay **faster**
  (5 commits +0.07, 50 +0.17, 100 +0.20). This is the term that stops "recently committed" from
  reading as "relevant" — the exact gitdone failure mode in the POC.
- **Other constants:** `decay_factor = 0.5`, `max_days = 90`, `min_penalty = −2.0`,
  `grace_period = 1h` (`decay.py:82–102`).
- **litectx target:** **slice 4**, keyed off the `kind` column shipped in **slice 1**. Validate
  type-decay + churn on both repos *before* activation gets weight (POC mandate).

## 4. Spreading activation — `spreading.py`

- **Formula:** `spread = Σ weight · spread_factor^hop` over a BFS of the relationship graph,
  bidirectional, additive across paths, source excluded (`spreading.py:276–279`).
- **Constants:** `spread_factor = 0.7` (1-hop 0.7, 2-hop 0.49, 3-hop 0.343); `max_hops = 3`;
  `max_edges = 1000`; `min_weight = 0.1` (`spreading.py:72–89`).
- **litectx target:** **slice 5** (edges) → spreading in recall. POC already confirmed 1-hop
  spreading **generalizes** — this is the validated win; build it.

## 5. Context boost — `context_boost.py`

- **Formula:** `boost = (|query_kw ∩ chunk_kw| / |query_kw|) · boost_factor`
  (`context_boost.py:333–356`). Field weights: name 2.0 > docstring 1.5 > signature/body 1.0.
- **Constant:** `boost_factor = 0.5` (`context_boost.py:39`).
- **litectx target:** **slice 4** (cheap, no embeddings needed).

## 6. Total activation — `engine.py`

- **Formula:** `total = BLA + spreading + context_boost − |decay|` (`engine.py:200–205`).
- **litectx target:** **slice 4**. Each component **min-max normalized to [0,1] independently**
  before the hybrid weights (§7) apply.

## 7. Hybrid weights (BM25 · activation · semantic) — `hybrid_retriever.py`

- **Type-aware weights:** `_CODE_WEIGHTS = (0.5, 0.3, 0.2)`, `_KB_WEIGHTS = (0.3, 0.3, 0.4)`
  (`hybrid_retriever.py:40–41`). `hybrid = bm25_w·bm25 + act_w·act + sem_w·sem`.
- **Staging:** FTS5 top-`100` gate → re-rank (`stage1_top_k = 100`); fallback chain
  tri-hybrid → dual-hybrid (no embeddings) → activation-only.
- **litectx target:** recall view, **slice 4** (dual-hybrid) + embeddings tier (tri-hybrid).
  **Divergence:** embeddings off by default → renormalize code weights over (BM25, activation)
  when semantic is absent. Re-validate the weights on both repos before adopting.

## 8. Git cold-start — `git.py`

- **Formula:** same BLA `ln(Σ t^−d)` applied to **commit timestamps** instead of accesses;
  `calculate_bla(commit_times, decay=0.5)`; **fallback `0.5`** when no git history
  (`git.py:296–366`).
- **Extraction:** `git blame --line-porcelain <file>` once per file (O(files)), sliced per
  function range (O(range)); returns unique commit timestamps, newest first; caches
  `{line:(sha,ts)}` and `{sha:ts}`. Commit **count** also feeds churn (§3).
- **litectx target:** **slice 4** seeds BLA; **slice 1** already enumerates via git. Block-level
  blame (per chunk line-range) lands once chunking (slice 2) gives line ranges.

## 9. Impact / blast-radius — `memory.py`

- **Refs / files:** aurora uses **LSP** `get_usage_summary`, falling back to `rg -w -c`.
  **litectx DIVERGES: ripgrep `-w` + tree-sitter only, no LSP** (doctrine). Over-counting is fine —
  the output is a risk *bucket*, not a precise reference list.
- **Complexity:** `complexity_pct = int(branch_count / (branch_count + 10) · 100)`, cap 99;
  `−1` if unavailable (`memory.py:144`). Branch nodes via tree-sitter (`if/elif/else/for/while/
  with/except/and/or`). 10 branches → 50%, 100 → ~91%.
- **Risk thresholds** (`memory.py:167–170`): **HIGH** if `files≥10 ∨ refs≥50 ∨ complexity≥60`;
  **MED** if `files≥3 ∨ refs≥10 ∨ complexity≥30`; else **LOW**; `−` if no data. Any one threshold
  triggers — not weighted.
- **litectx target:** **slice 6** (impact view), over slice-5 edges + slice-2 AST.

## 10. Chunk kinds — `chunk_types.py`

- **Set:** `frozenset{"code", "kb", "doc", "reas"}` (`chunk_types.py:42`). Ext map: code
  `.py/.js/.ts/.go/.java`; kb `.md/.markdown`; doc `.pdf/.docx/.txt`; reas = generated.
- **litectx target:** **shipped (slice 1)** as the open `kind` discriminator (v1: `code` + `doc`;
  `fact`/`episode` reserved). Note mapping difference: litectx folds aurora's `kb` (markdown) into
  `kind=doc, format=md`; aurora's paginated `doc` (pdf/docx) becomes litectx `kind=doc` + other
  `format`s (deferred). Type-decay (§3) keys off this column.

---

## Calibration quick-reference

| signal | constant | value | aurora src |
|---|---|---|---|
| BLA | decay_rate `d` | 0.5 | base_level.py:78 |
| BLA | default / floor | −5.0 / −10.0 | base_level.py:84–86 |
| decay | factor / cap / floor / grace | 0.5 / 90d / −2.0 / 1h | decay.py:82–102 |
| decay | type rates | code 0.40, class 0.20, kb 0.05, doc 0.02, toc 0.01 | decay.py:53 |
| churn | coefficient | 0.1 · log10(commits+1) | decay.py:68 |
| spreading | spread_factor / max_hops | 0.7 / 3 | spreading.py:72–78 |
| context | boost_factor | 0.5 | context_boost.py:39 |
| BM25 | k1 / b | 1.5 / 0.75 | bm25_scorer.py:164 |
| hybrid | code (bm25,act,sem) | (0.5, 0.3, 0.2) | hybrid_retriever.py:40 |
| hybrid | kb (bm25,act,sem) | (0.3, 0.3, 0.4) | hybrid_retriever.py:41 |
| retrieval | FTS5 stage-1 top-k | 100 | hybrid_retriever.py:90 |
| git | cold-start fallback | 0.5 | git.py:336 |
| complexity | formula | branch/(branch+10)·100 | memory.py:144 |
| risk | HIGH / MED | files≥10∣refs≥50∣cx≥60 / ≥3∣≥10∣≥30 | memory.py:167–170 |

**Mandate:** every weight/threshold above is a *prior*, not a constant of nature. Re-validate on
aurora + gitdone via `npm run bench` before it earns weight; keep only what holds on both.
