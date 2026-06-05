# Stash — litectx: Slice 4 COMPLETE (import edges + additive spreading + gitsig), all pushed

- **Date:** 2026-06-05
- **Repo:** `/home/hamr/PycharmProjects/litectx` (git, `main`, public GitHub `hamr0/litectx`).
- **Continues:** `.claude/stash/2026-06-05-litectx-slice4-design-settled-edges-spreading-next.md`
  (that one was START of slice-4 build; this is slice 4 DONE). Chain: slice3 → slice4-step0 →
  slice4-design-settled → **this (slice4 built + shipped)**.
- **Mode:** BUILD (not POC). Real `src/` written, tested, benched, committed, pushed. This session
  also did adversarial validation + 4-repo robustness + a fusion correction + doc reconciliation.
- **Governing:** `.claude/memory/AGENT_RULES.md` + `LIBRARY_CONVENTIONS.md`. SoT engine =
  `docs/01-product/litectx-memory-prd.md`. CLAUDE.md doctrine (no LSP; ripgrep+tree-sitter; over-count
  safe; embeddings off; better-sqlite3+FTS5; borrow aurora calibration).

## Commits pushed this session (all on `main`, local==remote==`6b9cfdb`)
- `97c308d` Slice 4: import edges + additive spreading recall (BM25 + graph).
- `43fa366` Slice 4: gitsig — file-level git activity metadata on hits.
- `6e4093b` test(gitsig): cover incremental refresh on a new commit.
- `6b9cfdb` docs: gitsig validation + access-vs-appearance distinction. **HEAD.**

## What shipped (slice 4 = recall's graph signal + git grounding)
- **`src/edges.js` (new)** — resolves import specifiers → **intra-repo** target files only (python
  module-suffix match through any source-root prefix; JS/TS relative+index). A miss → no edge (recall
  makes no isolation claim; the §7 safety net is the impact view's job, slice 5).
- **`src/chunker.js`** — `chunkAndImports()` collects import specifiers in the **same tree-sitter
  parse** as slice-2 chunks (no double parse). Python import/from abs+rel, ES import, CJS require().
  `chunkFile()` kept as thin wrapper (old tests untouched).
- **`src/langdef.js`** — per-lang `importTypes` (+ `requireCalls` for CJS).
- **`src/store.js`** — directed `edges(type, src_path, dst_path)` (`type` reserved for `'call'`,
  slice 5); `git_sig(path, commits, last_commit)`. `search()` blends BM25 + spreading; `attachGit()`
  joins gitsig onto hits **without reordering**. Incremental: edges refreshed per-importer & dropped
  both ends on delete; git_sig upserted/deleted per file.
- **`src/gitsig.js` (new)** — `collectGitSig()`: ONE `git log --name-only` pass, SOH(0x01)-prefixed
  commit headers so `@types/x`-style paths can't be misparsed. Returns Map<path,{commits,lastCommit}>.
- **`src/index.js`** — resolves edges vs full file list each pass; one gitsig pass per index-with-changes.
  `SPREAD_WEIGHT = 0.3`.
- **`poc/datasets/multis.mjs` (new)** — 3rd repo (CJS, ~31 src files), Explore-agent-built labels
  (caveat: not hand-audited like aurora/gitdone; trust the DELTA not the absolute MRR).
- **Tests:** `test/edges.test.js` (6), `test/gitsig.test.js` (5). **37/37 pass, typecheck clean.**

## The two findings that mattered (build-time corrections, evidence of record)
1. **Fusion: additive `own + w·spread` beats convex `(1−w)·own + w·spread`.** Diagnosed two convex
   regression modes (the tax on strong hits with weak neighbours): *collateral dilution* &
   *weak-neighbour demotion*. Additive only lifts, never taxes → fewer regressions (multis 2→0).
2. **Weight = 0.3, chosen against overfit on FOUR repos.** Sweep: additive@0.3 is the ONLY setting
   positive everywhere (aurora +0.027 / gitdone +0.010 / aurora-mixed +0.008 / multis +0.014).
   **Overfit cliff:** additive@0.7 = +0.044 aurora but **−0.024 multis** (below baseline); the two
   non-tuning repos (gitdone, multis) peak low. **LIMIT documented: 1-hop import-spreading is at its
   robust optimum — more recall gain needs the deferred tiers, not graph tuning.** (Calls don't help
   recall; more hops dilute.) One irreducible regression: a genuinely poorly-connected true answer
   (gitdone `classifier`) is demoted by ANY graph prior — intrinsic cost, not a tunable.

## Shipped bench numbers (recall gate — additive@0.3, hold-or-beat baseline ✓)
aurora 0.525→0.552 · gitdone 0.415→0.425 · aurora-mixed 0.545→0.553 · multis 0.443→0.457.
gitsig is **byte-identical** to without (proves grounding, not scored).

## Design clarifications captured in docs this session
- **gitsig = displayed grounding, NEVER scored.** Step-0 POC rejected git as a ranking prior (git =
  EDIT frequency, not ACCESS frequency). `Hit.git = {commits, lastCommit} | null`; `null` = no commit
  history (non-git tree OR tracked-but-uncommitted). File-level only (no per-block blame).
- **"Search boost" = base-level activation = the access-log tier (deferred).** Three distinct boosts:
  context-boost (query match — folded into BM25, shipped) · spreading (graph — shipped) · base-level
  (access freq+recency — DEFERRED). **An access = a retrieval that was USED, not a mere appearance in
  results** (appearance-boost = degenerate rich-get-richer feedback, explicitly not the design).
  Needs a real access log (v1 has none → deferred; `activations` table schema-reserved).

## Validation done (answering "real validations, no handwaving")
- Edges: real & sparse (aurora 1164 @ 0.47%, gitdone 153 @ 1.55% density); resolution spot-correct.
- Spreading lift causal & pool-controlled (limit=200 both sides); per-query traces; mutation kills 5/6.
- gitsig: counts cross-checked vs raw `git log` on aurora AND gitdone (exact, incl 68-commit file);
  no-reorder PROVEN (ranking byte-identical with/without git_sig); incremental refresh 1→2→3.

## NEXT — Slice 5: impact view (the LSP-replacement risk actually bites here)
- `calls` edge type (ripgrep `-w` + tree-sitter call-queries over slice-2 symbols) → called-by/calling
  → reference count → **risk bucket + complexity**, under the §7 over-count-safe / under-count-hedged
  safety contract. **Calls feed impact ONLY — they don't help recall** (Step-0 POC).
- **PREREQUISITE (POC-first): add a TS fixture repo to the bench** so the alias/barrel
  anti-false-isolation mitigations (§7.2) are testable before building them. v1 bench has 0 TS.
- Recall makes no isolation claim → carries none of this risk; impact is where "isolated→safe" is
  load-bearing. Natural pause point before starting.

## Carry-overs / debt
- **NOT MINE / leave alone (untouched all session):** `docs/01-product/barecontext-prd.md` (M),
  `docs/00-context/*`, `docs/01-product/litectx-ce-prd.md`, and stash
  `.claude/stash/2026-06-05-litectx-ce-doc-set-and-prd.md` (all uncommitted, someone else's work).
- **Doc debt (out of scope this session):** `poc/RESULTS.md` + borrow-ledger §4/§8/§11 not updated
  with the additive-fusion / 4-repo / gitsig findings (only CHANGELOG/PRD/context were).
- **Optional small follow-up:** surface `git` (commits/recency) in the CLI — `bin/litectx.js` prints
  only score/kind/format/path and silently ignores the new `git` field.
- Pre-1.0: CI (`ci.yml`/`publish.yml`), trusted-publishing OIDC.

## Throwaway scripts used & removed (not shipped)
All validation/sweep scripts (`verify.mjs`, `fusion.mjs`, `fusion2.mjs`, `valgit.mjs`, `wbench.mjs`,
`probe.mjs`) were written to repo root, run, and `rm`'d. Evidence lives in this stash + the bench.
