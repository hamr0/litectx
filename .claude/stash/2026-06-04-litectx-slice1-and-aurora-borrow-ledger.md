# Stash — litectx: SLICE 1 SHIPPED + aurora borrow ledger (source-verified calibration)

- **Date:** 2026-06-04
- **Repo:** `/home/hamr/PycharmProjects/litectx` (git, public GitHub `hamr0/litectx`, on `main`).
- **Continues:** `.claude/stash/2026-06-04-litectx-poc-and-build-methodology.md` (slice 0 session).
  This session: **shipped slice 1** (incremental indexing), then on user push, **built a
  source-verified aurora "borrow ledger"** and used it to **correct PRD drift** and **design the
  language-definition / edge layer + indexing-speed playbook**. Next = **slice 2** (tree-sitter chunking).
- **Mode:** shipping + borrow-grounding. Real commits, nothing pushed this session.

> **CORE THEME (user feedback, now a memory `borrow-aurora-dont-restart`):** *Aurora was a
> well-calibrated, tested memory — understand and BORROW what worked; only correct genuine
> mistakes. Stop reinventing crude approximations.* Saved to project memory + MEMORY.md.

---

## Commits this session (since slice-0 doc `fa92d53`) — all local, NOT pushed
```
65217bb Slice 1: incremental git-aware indexing + first-class kind/format schema
050c4bc docs: aurora borrow ledger — source-verified signal calibration
ca94ad4 docs: strong language-def design + correct PRD §4 drift from aurora source
b35dfff docs(ledger §11): add import edges + dead-code view + LSP coverage table
0375513 perf(store): aurora SQLite write pragmas + ledger §12 indexing-speed playbook
```

## SLICE 1 — SHIPPED (`65217bb`)
- `index()` now **incremental + git-aware**: new `file_index(path, content_hash, mtime, size,
  indexed_at)` table; fast skip on **(mtime, size)**, `content_hash` (sha256) is the arbiter; drops
  vanished files. Returns `{files, added, updated, removed, unchanged}`. `index({force})` rebuilds,
  `index({paths})` scopes a pass (no out-of-scope deletes).
- **`kind`/`format` first-class** columns (format routed by ext: ts/js/py/md); recall hits carry both.
- **Caught + fixed a real silent-miss:** mtime-only detection skips a same-tick edit without hashing →
  added **`size`** to the fast signal. Residual same-mtime+same-size swap = documented `--force` corner.
- **Constructor fix:** mkdir `dirname(dbPath)` (was always `<root>/.litectx`, polluted indexed repos).
- CLI `index` shows `+a ~u -r, =unchanged` + `--force`; `recall` shows `kind/format`.
- **Verified incremental on BOTH real repos** (persistent db, 2 passes): aurora 693 files cold 739ms →
  warm skip-all **13ms (57×)**; gitdone 152 cold 88ms → warm **6ms (15×)**. Indexed count == `git
  ls-files` filtered (proves git-collection path + indexing happened).
- **Bench held slice-0 baseline EXACTLY** (recall path untouched): aurora ALL MRR **0.523** P@3 64% ·
  gitdone ALL MRR **0.416** P@3 45%. **14 `node --test` tests** (8 new), typecheck clean.
- Later (`0375513`) added aurora SQLite pragmas to Store: `synchronous=NORMAL, cache_size=-8000,
  mmap_size=256MB, temp_store=MEMORY` (had only WAL). Bench unchanged.

## THE BORROW LEDGER — `docs/02-engineering/aurora-borrow-ledger.md` (NEW, the key artifact)
Source-verified against **aurora @ `750a39d`** (every constant has file:line). PRD §4/§12 point at it
as the calibration source of truth. Sections:
- **§1–10 signal calibration** (BM25 k1=1.5/b=0.75; BLA `ln(Σ count·t^−0.5)`, default −5, floor −10;
  decay `−factor·log10(days)` factor 0.5, **grace 1h**, **cap 90d**, floor −2; **DECAY_BY_TYPE**:
  function/code 0.40, class 0.20, kb 0.05, **doc 0.02**, toc 0.01; **churn** `+0.1·log10(commits+1)`;
  spreading `Σ w·0.7^hop` max 3, bidirectional; context boost `(|q∩kw|/|q|)·0.5`; total `BLA+spread+
  boost−|decay|`; hybrid code weights **(0.5,0.3,0.2)** kb (0.3,0.3,0.4); FTS5 stage-1 top-100; git
  cold-start = same BLA on commit timestamps, fallback 0.5; complexity `branch/(branch+10)·100`; risk
  HIGH files≥10∣refs≥50∣cx≥60 / MED ≥3∣≥10∣≥30).
- **§11 language-def + edge pipeline (carry vs correct).** CARRY: LanguageConfig registry pattern;
  `function_def_types` (Py {function_definition,class_definition}; JS {function_declaration,
  method_definition,arrow_function,class_declaration}; TS +{interface,type_alias}), `call_node_type`
  (Py `call`, JS/TS `call_expression`), `branch_types`, `skip_names` (builtin stoplists),
  entry_points/patterns/decorators, callback_methods; batched `rg -F -w --json -f` (24×); tree-sitter
  node-type matching. CORRECT/DROP: whole LSP tier (~300ms/sym, only Py "full"); dead
  `_identify_dependencies` (extracted deps then discarded); 3× duplicated complexity; mixed backends.
  **KEY CORRECTION:** over-counting is a *design choice* (risk bucket, not ref list) → no binding
  resolution / no LSP needed. Pipeline: defs(ts) → candidate refs(`rg -F -w --json`, parse
  `submatches[].start/end`) → confirm via AST → edges+impact. **TWO edge types required:** `calls`
  (sym→sym) AND `imports` (file→file = aurora `get_imported_by`/"files connected to this file", from
  tree-sitter import nodes). Dead-code = inverse impact, **candidate not assertion** (aurora fast mode
  ~85%, never trusted for delete; over-count bias = safe false-negative direction; exports = roots).
  LSP→litectx coverage table (drop lint/hover/def + import-vs-usage NON-GOAL).
- **§12 indexing-speed playbook.** ★ **git blame per-function was aurora's killer → file-level cache,
  slice per function = 336×** (slice 4 must do this, never per-symbol). SQLite pragmas (applied now).
  Parallel parsing (ThreadPoolExecutor min(8,cpu)) → slice 2 only if bench demands. litectx
  **sidesteps aurora's 9.7s BM25-pickle rebuild** (native FTS5 in db). Embeddings lazy/bg/batch-32 =
  opt-in tier only (cold 15–19s = why off by default).

## PRD CORRECTIONS (`ca94ad4`) — drift from aurora source, now fixed
- §4 decay: "1-day grace"→**1h**, "365d cap"→**90d**, "kb/doc 0.05"→kb 0.05 **doc 0.02**.
- §4.1 cold-start: removed false "aurora used 0.5^age_in_years" — `git.py` already uses unified
  `ln(Σ t^−d)` on commit timestamps → reframed as **borrowed, not invented**.
- §4 added a **"what we expect from the memory" recalibration box**: memory = ACT-R activation layer
  over the graph (hot via BLA+spreading+boost+type-decay/churn), git-seeded v1, bar = dual-hybrid beats
  plain BM25 on both repos with the FULL BLA formula, embeddings optional tier, engine kind-agnostic
  (fact/episode ratchet later). "reimplemented in JS" (was TS).

## OPEN QUESTIONS ANSWERED THIS SESSION (user's 3 + speed)
1. **fact/episode the right kinds?** YES — canonical declarative split (semantic/episodic), maps to
   ACT-R kind-decay, realizes "long-running agent memory". Caveats: mechanism-not-policy (adopter
   writes them in, no built-in extractor); sequence AFTER access-log BLA (no git history for non-code);
   defer procedural/skill. Schema reservation already free/done.
2. **deadcode "0 called-by"=dead safe?** NO assertion — "likely-unused candidate". Free as inverse
   impact; over-count bias is the safe direction; exports/entry/callbacks mandatory; dynamic dispatch
   invisible. (Captured in ledger §11.)
3. **all LSP→ripgrep fns covered?** Verified vs `facade.py` → found+fixed the **`imports` edge gap**
   (get_imported_by). calls/callers/callees/usage/impact ✅; drop lint/hover/def.
4. **indexing speed?** Investigated → ledger §12 (git-blame 336× is the lesson; pragmas applied).

## NEXT (in order)
1. **Slice 2 — tree-sitter symbol-level chunking** (TS/JS/Python + md section chunker). Where recall
   numbers should first jump; also gives slice-4 the line-ranges block-level git-blame needs.
   **POC-first:** throwaway chunking POC — pick binding (**lean web-tree-sitter/WASM** for adopter
   install-portability), settle **`.scm` queries vs inline node-type** (lean .scm for chunking +
   node-type config for edges), confirm symbol-granularity beats file-granularity on BOTH repos. Then
   build with tests. tree-sitter = justified 2nd prod dep (core doctrine). Keep `npm run bench` ≥
   baseline on both repos.
2. Slice 3 code-aware BM25 (camelCase body-split — slice-0 Store does path-doubling but NOT body split).
3. Slice 4 activation (FULL formula per ledger: BLA + type-decay + churn + spreading + context-boost;
   git cold-start; file-level blame cache 336×). Validate on both repos BEFORE BLA gets weight.
4. Slice 5 edges (calls + imports per ledger §11) → spreading in recall. Slice 6 impact view.

## KEY CONTEXT FOR RESUMING
- **Gate = `npm run bench`** (`poc/bench-lib.mjs`, runs real lib). Baseline both repos above. Every
  slice holds-or-beats on BOTH.
- **aurora paths:** `/home/hamr/PycharmProjects/aurora` (git, HEAD `750a39d`). Ledger pinned to it.
- **Borrow doctrine:** read aurora source FIRST, carry calibration (file:line), correct mistakes, don't
  port. Ledger is the contract; re-validate every borrowed weight on both repos before it earns weight.
- **Untracked, NOT mine (leave alone):** `docs/00-context/ctx-ifra.md` (user's CE course transcript),
  `docs/01-product/litectx-ce-requirements.md` (appeared this session — user's, not reviewed).
  `poc/.barebrowse/` now gitignored.
- **Memories:** `borrow-aurora-dont-restart`, `litectx-absorbs-all-ce-primitives`,
  `ce-tree-and-skill-map-project` (in `~/.claude/projects/-home-hamr-PycharmProjects-litectx/memory/`).
- **Slice 1 src seams:** `src/indexer.js` `diffFiles()` (mtime+size→hash diff), `classify()` (ext→
  kind/format); `src/store.js` `loadIndex()`/`applyChanges()` + pragmas; `src/index.js` `index(opts)`.
