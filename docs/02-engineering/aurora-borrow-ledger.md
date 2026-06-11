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
  matter only if/when we hand-roll scoring.
- **✅ SHIPPED (slice 3) — and corrected AURORA's design.** Carried: FTS5 keyword gate + a
  code-aware FTS body (`tokenize.indexBody`: camelCase identifier split + symbol names). **Did NOT
  carry the per-kind hybrid re-rank weights** — verified on `aurora-mixed` (py+md) that with BM25 as
  the only signal, AURORA's `_CODE_WEIGHTS`/`_KB_WEIGHTS` collapse to a bare `doc × w` md-penalty
  (the "no penalty hack" doctrine forbids it); the weights only become principled once ≥2 signals
  exist (slice 4 adds **spreading** as the second; base-level activation is deferred — §2/§4).
  Instead the code-over-md symptom is dissolved structurally: **kinds
  never share a ranking** (`recall` is kind-scoped, one FTS query per kind). Result: `kind:"code"`
  holds 0.525→0.545 with 196 md docs in the index, vs 0.480 / 12-of-22-prose-buried under a shared
  ranking. `k1/b` tuning + deps-in-body deferred (neutral on bench; deps ride slice-4 edges).

## 2. Base-level activation (BLA) — `base_level.py`

- **Formula:** `BLA = ln(Σ_j count_j · t_j^−d)`, `t_j` = seconds since access j; `t≤0 → 1`
  (`base_level.py:147–167`). Bucketed history: `count_j > 1` = multiple accesses at bucket midpoint.
- **Constants:** `decay_rate d = 0.5`; `default_activation = −5.0` (no history); `min_activation = −10.0`
  (floor). (`base_level.py:78–86`).
- **litectx target:** **DEFERRED → access-log tier** (was slice 4). Slice-4 Step-0 POC: seeding BLA
  from git alone is repo-dependent (+aurora / −gitdone at every weight) — base-level needs a *real*
  access log to have signal, which v1 lacks (`poc/RESULTS.md` "Slice-4 Step-0"; PRD §4/§14 #1). Keep
  the bucketed `count·t^−d` shape so a real access log slots in later; do **not** ship it git-seeded.

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
- **litectx target:** **DEFERRED → access-log tier** (was slice 4), keyed off **(`kind`, `format`)**
  (slice-1 columns). ⚠️ aurora's `kb` = *markdown* → litectx `format=md` **0.05**; aurora's `doc` =
  *pdf/docx* → litectx `format=pdf/docx` **0.02** (deferred). Do **not** collapse md onto `0.02`.
  **Step-0 finding (the POC mandate, executed):** decay+churn did **not** rescue git-seeded
  base-level — at co-equal weight it made gitdone *worse* (−0.094 vs −0.030 recency-only). Churn
  raises the decay rate but only bites *stale* high-churn files; gitdone's failure mode is
  *recently*-churned ones, which it does not catch. These params are real but belong to the
  access-log tier (decay against *real* accesses), not v1 git-seeded ranking (`RESULTS.md`).

## 4. Spreading activation — `spreading.py`

- **Formula:** `spread = Σ weight · spread_factor^hop` over a BFS of the relationship graph,
  bidirectional, additive across paths, source excluded (`spreading.py:276–279`).
- **Constants:** `spread_factor = 0.7` (1-hop 0.7, 2-hop 0.49, 3-hop 0.343); `max_hops = 3`;
  `max_edges = 1000`; `min_weight = 0.1` (`spreading.py:72–89`).
- **litectx target:** **slice 4** (edges) → spreading in recall — **promoted to the next ranking
  slice.** The original POC confirmed 1-hop spreading **generalizes** (+0.028 aurora / +0.021
  gitdone, positive on every breakdown); with base-level activation deferred (§2/§3), spreading is
  *the* v1 ranking lift. Fuse **within a kind** (slice-3 invariant); adopt the weight only if ≥
  baseline on every repo. This is the ACT-R term that ships in v1. **Edge-type split (Step-0 POC,
  `RESULTS.md`):** recall spreading rides **import** edges only — **call** edges were repo-dependent
  for recall (great aurora, −gitdone) under a noisy proxy and belong to the **impact** view (§9), not
  recall, unless a precise extraction later proves them ≥ baseline on both.

## 5. Context boost — `context_boost.py`

- **Formula:** `boost = (|query_kw ∩ chunk_kw| / |query_kw|) · boost_factor`
  (`context_boost.py:333–356`). Field weights: name 2.0 > docstring 1.5 > signature/body 1.0.
- **Constant:** `boost_factor = 0.5` (`context_boost.py:39`).
- **litectx target:** **mostly folded into BM25 already** — slice-3 `indexBody` indexes symbol names
  into the FTS body, which is what context-boost's name-overlap term rewards. A separate scored
  boost is redundant for v1; revisit only as part of the access-log tier's full activation total.

## 6. Total activation — `engine.py`

- **Formula:** `total = BLA + spreading + context_boost − |decay|` (`engine.py:200–205`).
- **litectx target:** **DEFERRED → access-log tier.** The full `BLA + spreading + boost − decay`
  total only makes sense once base-level terms have an access log; in v1, recall fuses BM25 +
  spreading directly (§7). Each component still **min-max normalized to [0,1] independently** when
  the total lands. (Spreading alone ships in slice 4 as its own normalized term.)

## 7. Hybrid weights (BM25 · activation · semantic) — `hybrid_retriever.py`

- **Type-aware weights:** `_CODE_WEIGHTS = (0.5, 0.3, 0.2)`, `_KB_WEIGHTS = (0.3, 0.3, 0.4)`
  (`hybrid_retriever.py:40–41`). `hybrid = bm25_w·bm25 + act_w·act + sem_w·sem`.
- **Staging:** FTS5 top-`100` gate → re-rank (`stage1_top_k = 100`); fallback chain
  tri-hybrid → dual-hybrid (no embeddings) → activation-only.
- **litectx target:** recall view. **Divergence (POC-corrected):** v1 "dual-hybrid" = **BM25 +
  spreading** (slice 4), *not* BM25 + base-level activation — base-level is deferred (§2/§3). The
  embeddings tier adds semantic → tri-hybrid. Renormalize over whichever terms are present; the
  aurora `(0.5, 0.3, 0.2)` split is a *starting prior* for (BM25, spreading/activation, semantic),
  re-validated on both repos before adopting. Aurora's activation slot is litectx's spreading slot
  in v1.

## 8. Git cold-start — `git.py`

- **Formula:** same BLA `ln(Σ t^−d)` applied to **commit timestamps** instead of accesses;
  `calculate_bla(commit_times, decay=0.5)`; **fallback `0.5`** when no git history
  (`git.py:296–366`).
- **Extraction:** `git blame --line-porcelain <file>` once per file (O(files)), sliced per
  function range (O(range)); returns unique commit timestamps, newest first; caches
  `{line:(sha,ts)}` and `{sha:ts}`. Commit **count** also feeds churn (§3).
- **litectx target (POC-corrected):** **slice 4 = git *activity metadata*** — file-level `git log`
  → commit count + last-modified, attached to hits as displayed grounding (not scored; mirrors
  aurora's result card, which shows `Git: 7 commits, modified 8d ago` raw). **No per-block blame
  needed for v1** (the 336× blame concern, §12, doesn't apply to file-level metadata). The
  BLA-*seeding* use is deferred with base-level activation (§2) → access-log tier; block-level blame
  lands then.

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
- **litectx target:** **slice 5** (impact view), over slice-4 edges + slice-2 AST.

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

---

## 11. Language-definition layer + edge pipeline (slice 4/5) — carry vs correct

This is where litectx replaces aurora's LSP. **Borrow what was validated, fix what was a mistake.**

### Carry (aurora got this right — evidence: worked across 5 languages, clean)

- **The `LanguageConfig` registry pattern** (`lsp/.../languages/{base,python,javascript,...}.py`):
  one dataclass per language, registered in a `LANGUAGES` dict + `EXTENSION_MAP`. Adding a
  language = author one config. Carry this shape verbatim (as a JS object per language).
- **The per-language fields that make ripgrep accurate** — these ARE the "strong lang def":
  - `function_def_types` — Py `{function_definition, class_definition}`; JS
    `{function_declaration, method_definition, arrow_function, class_declaration}`; TS adds
    `{interface_declaration, type_alias_declaration}`.
  - `call_node_type` — Py `call`; JS/TS `call_expression`.
  - `branch_types` — for complexity (the `if/for/while/with/except/&&/||…` set), per language.
  - `skip_names` — language builtins/stdlib stoplist so `len`, `map`, `console`, `print`,
    `push`… aren't counted as references (aurora ships real lists per lang — carry them).
  - `entry_points` / `entry_patterns` (glob, e.g. `test_*`, `Benchmark*`) / `entry_decorators`
    (`@app.route`, `@click.command`) — so framework-invoked defs aren't seen as dead/unreferenced.
  - `callback_methods` (`map filter reduce forEach then catch setTimeout`…) + framework
    callback names — so `bot.on('msg', handler)` / `queryFn` aren't misread.
- **Batched `ripgrep -w --json`** for symbol presence — aurora's fast path, **24× faster** than
  per-symbol grep: one `rg` call with `-f <patterns_file>` for all symbols at once. Carry this.
- **Tree-sitter via direct node-type + field access** (`node.type == call_node_type`,
  `child_by_field_name("function")`) — aurora used this successfully and **did NOT need `.scm`
  query files**. (Open call, below.)

### Correct / drop (aurora mistakes — do NOT borrow)

- **The entire `lsp` package + multilspy.** ~300ms/symbol, needed per-language patches
  (`multilspy_patches.py` for TS), only Python was "full" — JS/TS/Go "partial, LSP untested".
  litectx drops it wholesale (PRD §7, final). We borrow the *intent* (who-uses-this), not the
  mechanism.
- **`_identify_dependencies()`** (`context-code/python.py:593`) — extracted deps then **discarded
  them** (`dependencies=[]` always). A dead path that tried local binding resolution tree-sitter
  can't do alone (`obj.method()` ambiguity). Don't reproduce. **Our answer to that ambiguity is
  not to resolve it** (next point).
- **Reaching for precise binding resolution at all.** Aurora went to LSP because tree-sitter
  can't tell *which* `method` an `obj.method()` calls. **litectx makes over-counting a design
  choice**: the output is a **risk bucket**, not a reference list (PRD §7, §13). Same-named
  methods collapsing together is acceptable — it errs toward caution. This is the key correction
  that makes "no LSP" not a downgrade but a *scoping* decision.
- **Complexity logic duplicated 3×** in aurora — centralize to one `complexity(node, langdef)`.
- **Mixed backends in one module** (LSP+rg+tree-sitter tangled) — keep clean seams: ripgrep for
  the candidate sweep, tree-sitter for confirmation; one concern per module.

### The edge-resolution pipeline (litectx, slice 4)

1. **Defs** — tree-sitter walk every file → for each `function_def_types` node emit a node
   `{name, kind, file, [startLine,endLine]}`. This is the symbol table (also feeds slice-2 chunking).
2. **Candidate refs** — batched ripgrep over the repo:
   `rg -F -w --json -t <langtype> -f <names_file> <root>` —
   - `-F` literal (symbol names aren't regex — no injection), `-w` word boundary,
     `-t`/`--type-add` to scope by language, `-f` one symbol per line (batched).
   - `--json` emits NDJSON `begin`/`match`/`end`/`summary`; each `match` has `path.text`,
     `line_number`, `absolute_offset`, and `submatches[].{start,end}` (byte cols). Parse these for
     exact (file, line, col) candidates. (`-P/--pcre2` only if a lang ever needs lookaround — avoid.)
3. **Confirm** — for each candidate (file,line,col), check the tree-sitter node there is a *use*
   (ancestor is `call_node_type`, or an identifier in a usage position), **not** a definition, and
   not inside a comment/string; drop `skip_names` and callback/entry noise. We confirm "is this a
   plausible call site," we do **not** resolve the binding.
4. **Edges + impact** — caller = the def whose line-range contains the candidate → edge
   `(caller)-[calls]->(target)`. `refs` = confirmed candidates, `files` = distinct files →
   **risk bucket** via §9 thresholds. `complexity` = §9 branch count inside the def.

### Two edge types — both required (don't ship only calls)

The stated goals need **two** edge kinds, not one. The call pipeline above gives *called-by /
calling*; **file connectivity needs import edges separately.**

- **`calls`** — symbol → symbol, from `call_node_type` (above). Powers called-by/calling + the
  symbol-level blast radius.
- **`imports`** — file → file/module, from import/require statements. **This is aurora's
  `get_imported_by` (`facade.py:265`)** — "files connected to this file." Aurora did it with
  per-language import regex (`filters.py:IMPORT_PATTERNS`: Py `from X import` / `import X`; JS/TS
  `import … from` / `require(`; Go/Java/Rust forms) + `rg -l --type <lang> -e <combined>`
  (file-level). **litectx improvement:** extract from **tree-sitter import nodes** (cleaner than
  regex), resolve module→file with path heuristics (over-count acceptable — risk bucket).
  File-level blast radius = transitive reverse-`imports` ∪ callers of the file's exported symbols.

### Dead-code (inverse impact) — a *candidate* signal, never a safe assertion

"0 called-by + 0 imported-by ⇒ unused" is **derivable for free** once both edge types exist
(it's `impact` inverted). But borrow aurora's *caution*, not a false confidence:

- Aurora's fast ripgrep mode was **~85% accurate, documented for "daily dev / CI," NOT "before
  deleting"** — it gated the confident mode behind a better resolver. Never present litectx
  dead-code as "safe to delete" — it is **"likely-unused, review candidate."**
- litectx's **over-counting bias makes it safer**: over-counting refs → fewer spurious "0 refs"
  → errs toward **false negatives** (misses some dead code), not the dangerous **false positive**
  (flagging live code dead). That is the correct failure direction for dead-code.
- **Mandatory filters or it's noise:** entry_points / entry_decorators / framework callbacks
  (`@app.route`, test runners, event handlers) **and — for a library — every public export is a
  root.** Dynamic dispatch / reflection / string-keyed calls are invisible to ripgrep → residual
  false positives. So: a signal, not a verdict.

### LSP surface → litectx coverage (verified vs aurora `facade.py`)

| aurora LSP fn | gives | litectx | how |
|---|---|---|---|
| `get_usage_summary` | files + refs | ✅ | call edges → risk bucket (§9) |
| `get_callers` | called-by | ✅ | `calls` edges, reverse |
| `get_callees` | calling | ✅ | tree-sitter walk of def body (no rg) |
| `find_usages` | use sites | ✅ | rg candidate + ts confirm |
| `get_imported_by` | connected files | ✅ | `imports` edges (above) |
| `find_dead_code` | unused | ✅* | inverse impact — *candidate only* |
| `lint` / diagnostics | linting | ⛔ drop | not a litectx goal (linter's job) |
| `get_definition` / `get_hover` | editor nav | ⛔ drop | editor feature, not litectx |
| `ImportFilter` (import vs usage) | precise split | ⛔ NON-GOAL | over-count by design (PRD §7/§13) |

### Open call (decide in the slice-2 tree-sitter POC)

- **`.scm` queries vs inline node-type matching.** PRD §7/doctrine says "tree-sitter query set";
  aurora succeeded with inline node-type checks and no `.scm` files. Evidence says the *config*
  (`function_def_types`/`call_node_type`) carries the accuracy, queries are a thin layer. Lean:
  `.scm` queries for **chunking** (declarative capture of function/class spans, slice 2) +
  node-type config for **edges** (slice 4). Confirm in the slice-2 POC alongside the
  web-tree-sitter (WASM) vs native binding choice.

---

## 12. Indexing performance — the speed playbook (aurora's hardest-won lessons)

Aurora hit a real indexing-speed wall; the fixes are documented and worth borrowing exactly.

### ★ Git blame was the killer — file-level cache, slice per function (336× — non-negotiable)

> **v1 sidesteps this entirely.** Per-block blame is only needed to seed *chunk-level* base-level
> activation, which is **deferred to the access-log tier** (§2/§8). v1 git *activity metadata* is
> **file-level `git log`** (count + last-modified) — O(files), no per-range blame. This playbook
> applies when block-level activation is built later.

- **The mistake:** `git blame -L <start>,<end>` **per function** → O(functions) git subprocesses
  (a 50-function file = 50 blame calls). This was aurora's dominant indexing cost.
- **The fix** (`context-code/.../git.py:100–294`): run `git blame --line-porcelain <file>`
  **once per file**, cache `{line → (sha, ts)}`, then slice each function's range in O(1).
  CHANGELOG: **"336× speedup on subsequent function lookups."** Second-level `{sha → ts}` cache
  too.
- **litectx (access-log tier, deferred):** when block-level git signals land (§8), do file-level
  blame **once**, slice per chunk line-range. Never per-symbol git calls. This is THE indexing-speed
  lesson. (v1 slice-4 git *metadata* is file-level `git log` only — no blame, so this doesn't bite.)

### SQLite write pragmas (cheap, applied now to `Store`)

- Aurora (`connection_pool.py:81–105`): `WAL` + `synchronous=NORMAL` + `cache_size=-8000` (8 MB)
  + `mmap_size=256MB` + `temp_store=MEMORY`. litectx had only `WAL` → now matches (the index is
  rebuildable, so NORMAL's "lose at most the last txn on power loss" is the right trade).

### Parallel parsing (slice 2)

- Aurora parses tree-sitter **in a `ThreadPoolExecutor`, `min(8, cpu)` workers** (tree-sitter is
  stateless/thread-safe) — `memory_manager.py:670–844`. **litectx:** single-threaded is fine for
  v1; reach for `worker_threads` only if the slice-2 bench shows parsing dominates. Don't
  pre-optimize.

### Incremental detection — already shipped (slice 1), aurora-aligned

- Aurora: git status → mtime → SHA-256 (`memory_manager.py:524–586`), `file_index{hash, mtime,
  chunk_count}`, deleted-file cleanup. litectx slice 1 = mtime+**size**→sha256 + cleanup. The one
  divergence: litectx **defers the git-status tier-0** — mtime+size already skips the expensive
  read+hash; git status would only save `stat()` calls (cheap). Revisit only if a huge-repo bench
  shows the walk itself dominates.

### litectx sidesteps one aurora bottleneck by design

- Aurora cached a **pickled BM25 index** (`bm25_index.pkl`) because rebuild was **9.7s** → <100ms
  load. **litectx has no such cost:** BM25 is **native FTS5 inside the SQLite file** — it persists
  with the db, nothing to rebuild or re-pickle. A free win from the storage doctrine.

### Embeddings (opt-in tier only)

- Cold start **15–19s** (model download + torch import), warm 2–3s; aurora **lazy-loads** +
  **background-preloads** the model and **batches** encode at `batch_size=32`
  - ⚠️ **litectx does NOT inherit this number.** That 15–19s is aurora's **torch** cold-start.
    litectx's transformers.js/ONNX embedder measured **~2.1s first-ever download · ~0.72s cached
    load · ~6ms warm** (2026-06-11). The "15–19s cold latency" had been mis-borrowed into
    CLAUDE.md + PRD §8/§3.3 and is now corrected there — litectx's embeddings cost is the **dep +
    index-time embedding**, not query latency.
  (`embedding_provider.py`). Carry all three **only in the embeddings tier** — never on the
  default path (this is precisely why embeddings are off by default).

- **Embedding model — candidates (2026-06-11).** Current: `Xenova/all-MiniLM-L6-v2` —
  general-purpose, **384-dim, ~23 MB** quantized ONNX, downloaded on first use. Serves litectx's
  *integral memory* use (facts/episodes are prose) well, decent on code, light + offline-after-first.
  Candidates if code recall becomes the priority:
  - `jina-embeddings-v2-base-code` — **DEPRIORITIZED, not a planned upgrade.** It's the only
    transformers.js-viable code model (768-dim, ~160 MB), but there's **no measured gap to close**:
    the *general* MiniLM already delivered the code lift (+~0.2 MRR on aurora/gitdone), and litectx's
    structural machinery (camelCase BM25 + import-spreading + chunk locators + the impact graph +
    recall→impact disambiguation) does the "find the right code" work — embeddings is a supplementary
    rerank, not the primary signal (unlike vector-first tools). A code model would also risk the
    *prose-memory* half (the integral use). Revisit ONLY if the litmus ever shows MiniLM + the
    structure leaving a measurable code gap. Bigger ≠ better; fit-to-workload wins.
  - `nomic-embed-code` (DeusData/codebase-memory-mcp ships it int8, 768-dim, **compiled into a
    static binary**) — **NOT directly adoptable**: the full model is ~7B params, far too heavy for an
    in-process transformers.js library. It's a precedent (code-specific, bundled) that only works
    *because* that tool is a compiled binary; a JS lib can't bundle it. Inspiration, not a swap.
  - **Which one:** keep MiniLM as default (general model fits the prose-memory primary use + stays
    light/offline). A code-specific model helps code recall but risks the memory half — so any swap is
    a *per-workload* call, gated by the litmus, not a clear win. Bigger ≠ better here; fit-to-workload wins.

---

## 13. SOAR / CE primitives — carry vs correct (the context-engineering layer)

The §1–12 entries are aurora's **memory signals**. This section covers the **CE primitives** mined
from aurora's SOAR pipeline (`packages/soar/`, `packages/reasoning/`) and cross-checked against the
Arize "Alex" talk [Arize]. Maps to `litectx-ce-prd.md` R-* IDs. **Verified against source** — the
big lesson here is that two things the SOAR *docs* describe were **never actually built**, so they
are designs, not validated borrows.

> **Path note:** read under `/home/hamr/Documents/PycharmProjects/aurora`, which is the **same
> inode** as the header's `/home/hamr/PycharmProjects/aurora` (3681847) at the **same commit
> `750a39d`** — so these file:lines match the ledger's stated provenance. ✅ verified.

### 13.1 Rank-tiered chunk render → **R-C7** (Compress) — ✅ built, CARRY the *shape*, reimplement
- **Source:** `packages/soar/src/aurora_soar/phases/decompose.py:243-310`, inside
  `_build_context_summary()` (**inlined, not a discrete function**).
- **Mechanism (the real one — richer than "render to docstring"):** chunks are rendered **by rank
  in tiers**, not uniformly. `CHUNK_LIMITS = {"MEDIUM": (5,8), "COMPLEX": (7,12), "CRITICAL":
  (10,15)}` → `(TOP_N_WITH_CODE, MAX_CHUNKS)` (`decompose.py:246`). The first `TOP_N` chunks get
  **full verbatim code**; chunks `TOP_N..MAX` get a **docstring/description fallback** (`[:200-300]`
  chars); everything past `MAX` is **dropped**.
- **Carry:** the **rank-tiered budget** — *verbatim for the top, signature+docstring for the middle,
  drop past a cap*. This is the calibration (code-only confused the agent; tiered fixed it) and it's
  the natural implementation of **R-C2 token-budgeted assembly** + **R-C7 render**.
- **Correct/adapt:** it's **inlined** in the orchestrator → **reimplement clean**, don't extract.
  litectx already extracts `signature`/`docstring` (memory PRD §2), so the render unit is free; the
  tiering belongs in `assemble()`. The `(top_N, max)` numbers are aurora priors — re-tune to a
  **token budget**, not a fixed count.
- **Companion prior (non-aurora) — Headroom `SmartCrusher`.** A *second* structural prior for the
  same R-C7 tiering, from the Headroom library (`github.com/chopratejas/headroom`, Apache-2.0; full
  study in [copy-pattern-studies §4](copy-pattern-studies.md)): retain **30% from start (schema) +
  15% from end (recency) + 55% by importance score**, and **keep anomalies (errors/warnings)
  unconditionally**. Different payload (JSON arrays vs code chunks) but the same shape as aurora's
  `CHUNK_LIMITS`, plus a *never-drop override* aurora's tiering lacks. Carry as a **competing bench
  hypothesis** next to the `(top_N, max)` split — not aurora calibration, so it stays out of the §-12
  quick-reference table; both are **untested priors** the `poc/` gate decides between (or fuses:
  rank-tiered code + unconditional-keep for errors).

### 13.2 Retrieval-quality signal (NONE/WEAK/GOOD) → **R-S8** (Select) — ⚠️ DESIGN ONLY, never built
- **Source:** `docs/02-features/soar/SOAR_ARCHITECTURE.md:276-329` **only** — the enum
  (NONE/WEAK/GOOD), the `groundedness` computation, and the thresholds **do not exist** in the
  `aurora_soar` source. Confirmed absent from the codebase.
- **Documented design:** `high_quality = chunks with activation ≥ 0.3`; **GOOD** = `groundedness ≥
  0.7 AND high_quality ≥ 3`; **WEAK** = either fails; **NONE** = `total_chunks == 0`.
- **Verdict:** **not a validated borrow — a litectx-original** inspired by aurora's *unbuilt* design
  + the Arize "we want a principled context-quality metric" gap [Arize]. litectx is uniquely placed
  to build it (it owns the activation scores). The `0.3 / 0.7 / 3` numbers are **untested priors**;
  treat them as bench hypotheses, not calibration. (NB: litectx has no separate "groundedness"
  signal yet — for v1 the label can key off the **activation distribution alone**.)

### 13.3 Success boost on record → **R-W7** (Write feedback) — ✅ built & confirmed, CARRY
- **Source:** `packages/soar/src/aurora_soar/phases/record.py:282-283`:
  `pattern_marked = confidence >= 0.8` · `activation_update = 0.2 if pattern_marked else 0.05`
  (policy docstring `:198-201`; `< 0.5` skips caching).
- **Constants (confirmed):** **+0.2** at confidence ≥0.8 · **+0.05** at ≥0.5 · skip below 0.5.
- **"Success" source:** `synthesis_result.confidence` (`record.py:218`) — an **LLM-produced**
  number from the synthesize phase. → the *verdict* is harness/bareagent (ceded); litectx only
  applies the boost via `recordUseful(ids, weight)`.
- **Carry:** the constants as priors; re-validate on the bench. This boost is **on top of**
  automatic base-level use (§2), keyed to *helped*, not merely *retrieved*.

### 13.4 Sibling borrows (NOT litectx — parked in CE-PRD §10.4)
- **Cost-budget gate → bareguard.** ⚠️ **DESIGN ONLY** — `aurora_core/budget/tracker.py` tracks
  spend but has **no per-tier caps and no soft/hard gate**; the `$0.001/$0.05/$0.50/$2.00` tiers +
  80%/100% checks live only in the docs. **Build fresh**, not a borrow.
- **Complexity assessment → bareagent.** ✅ built: `packages/soar/src/aurora_soar/phases/assess.py:82-343`
  — verb stoplists (`SIMPLE_VERBS`/`COMPLEX_VERBS`…) + question-pattern regex, **no LLM**. Real,
  carryable.
- **Decomposition caps → bareagent.** ✅ built: `SUBGOAL_LIMITS = {"MEDIUM":2,"COMPLEX":4,"CRITICAL":6}`
  (`packages/reasoning/src/aurora_reasoning/prompts/decompose.py:167`). **Attribution fix:** the
  2/4/6 is the **subgoal cap**, *not* the few-shot count — few-shot examples are a separate knob, cut
  to `0/1/1/2` (`examples.py:111-116`) to save context. The lesson (numeric caps curb LLM
  over-engineering) carries; the agent-matching closed-labels (excellent/adequate/bad) are also
  bareagent.
