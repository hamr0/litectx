# Stash — litectx: Slice 5a COMPLETE (impact view + impact bench gate + decorator fix), all pushed

- **Date:** 2026-06-05
- **Repo:** `/home/hamr/Documents/PycharmProjects/litectx` (git, `main`, public `hamr0/litectx`).
  Note: CLAUDE.md says `/home/hamr/PycharmProjects/litectx`; the live checkout this session is the
  `Documents/` path (a symlink/alt clone — both resolve). aurora/mcprune likewise exist under both.
- **Continues:** `.claude/stash/2026-06-05-litectx-slice4-complete-edges-spreading-gitsig.md`
  (slice 4 done). Chain: slice3 → slice4 → **this (slice 5a built + shipped + gated)**.
- **Mode:** BUILD. Real `src/` written, tested, benched, committed, pushed. Plus adversarial
  validation (mutation checks) and a new E2E gate.
- **Governing:** `.claude/memory/AGENT_RULES.md` + `LIBRARY_CONVENTIONS.md`. SoT = `docs/01-product/
  litectx-memory-prd.md`. CLAUDE.md doctrine (no LSP; ripgrep+tree-sitter; over-count safe; embeddings
  off; better-sqlite3+FTS5; borrow aurora calibration).

## HEAD == upstream == `9010834` (everything pushed). Commits this session (all on `main`):
- `472446a` cli: surface git grounding column on recall hits (slice-4 loose end).
- `7d49190` Slice 5a: impact view — called-by/calling → risk bucket + complexity.
- `9010834` impact bench gate + decorator confirmation (§11.3). **HEAD.**

## What shipped — Slice 5a = the impact view (the LSP-replacement bet)
- **`src/impact.js` (new)** — `computeImpact(store, root, include, symbol)` + `riskBucket(n)`.
  **On-demand, NOT persisted** (§7.1): callees = tree-sitter walk of the symbol body; callers =
  `rg -F -w --json` sweep → tree-sitter confirm (with enclosing symbol). `risk =
  riskBucket(max(confirmed, mentions))`, **aurora thresholds ≤2 low / 3–10 med / 11+ high** (borrowed
  from aurora `lsp_tool._calculate_risk` — carry the numbers, drop the LSP). complexity = AST branch
  count. `type='call'` edge row stays RESERVED (on-demand chosen over persisting a noisy call graph).
- **§7.2 safety is the whole point** — over-count safe, under-count dangerous. `refCount` takes the
  LOOSER signal (resolution is BY NAME only — no receiver typing). "isolated/low-risk" is NEVER
  silent: unconfirmed mention = counted-not-dropped ("unresolved≠absent"); exported/public name
  hedged; zero-ref = hedged review candidate. `looksExternallyReachable` heuristic (py non-underscore
  / js-ts `export` in body). Cut a dead `stringLiteralMention` (rg -w already catches string mentions).
- **`langdef`** +`callTypes`/`branchTypes`/`decoratorTypes` (py/js/ts). **`chunker`** +`analyzeBody`
  (callees+complexity) +`callSitesOf` (ts-confirm, incl. **bare `@decorator` branch** — skips `@x()`
  call form to avoid double-count). **`store`** +`symbolDefs`/`allSymbolNames`. **`index`** +`impact()`.
  **CLI** `impact <symbol>`.
- **Tests:** `test/impact.test.js` (10) incl. a bare-decorator regression. **47/47 total, typecheck clean.**

## What shipped — the impact bench GATE (PRD §11.3, the E2E validation strategy)
- **`poc/impact-bench.mjs`** (`npm run bench:impact`) — impact analogue of the recall bench
  (`poc/bench-lib.mjs`). Indexes a STABLE repo through real `LiteCtx`, runs hand-audited symbols
  through `impact()`, scores the **§7.2 PAIR**: **SAFETY** = a `used` symbol must never read isolated
  (`refCount>0`; **target ZERO** false-isolations; sets `process.exitCode`) · **QUALITY** =
  confirmed-caller-FILE recall. **Precision/over-count deliberately NOT gated.**
- **`poc/datasets/impact-aurora.mjs`** (3 labels: topological_sort_tasks, ParsedTask, handle_errors)
  + **`impact-mcprune.mjs`** (6 labels). **HAND-AUDITED real call sites** (git grep → read each line;
  exclude imports/`__all__`/type-positions/object-key-shorthand/`JSON.parse`/self-applications). NOT
  derived from impact() (would be circular). **Result: 100% confirmed-caller recall, 0 false-isolations.**
- **Corpus:** aurora (`/home/hamr/PycharmProjects/aurora`, 497 py) + **mcprune**
  (`/home/hamr/PycharmProjects/mcprune`, 15 pure-JS files, frozen ~2026-05-29). Both archived → stable
  call-graph oracle. mcprune is **JS not TS** → can't serve the TS-isolation gate (that needs #1).

## The two findings the gate produced on first run (evidence of record)
1. **Drove a tool fix:** bare `@handle_errors` (no parens) is NOT a `call` node → was 0% confirmed
   (mention-floor safe but list-incomplete). Added `decoratorTypes` + the callSitesOf decorator
   branch → handle_errors 0%→100%. Mutation check: disabling it kills BOTH the test and the gate
   metric while SAFETY stays ok (proves the mention floor is independent of confirmation).
2. **Caught my own over-inclusive label:** `errors.py:652 @handle_errors` is INSIDE handle_errors'
   own def (self-application) → correctly excluded like recursion. Removed errors.py from the label
   (reason recorded in the dataset). The gate earning its keep + the "audit your labels" lesson.

## Validation done (answering "did you validate")
- typecheck clean; 47/47 `node --test`; recall bench **byte-identical** (aurora 0.552 / gitdone 0.425)
  — impact doesn't touch recall (calls don't help recall, Step-0 POC).
- aurora cross-check (now durable via `npm run bench:impact`, not the deleted throwaway): hubs bucket
  high with correct fan-in (SQLiteStore 235 refs/109 callers/cx107, BaseLevelActivation 47/36).
- Mutation checks proved teeth on BOTH the §7.2 max() rule (under-count kills tests 4&6) and the
  decorator branch.

## NEXT — the agreed dependency order (memory: sequence-plans-by-dependency)
**#1 TS bench fixture → 5b alias/barrel mitigations + TS-isolation gate.**
- **#1 (next):** small TS repo with a deliberate **barrel** (`index.ts` re-export) + a planted
  **path-alias** import, PLUS labeled isolation ground truth (`isolated:false` for a symbol reached
  ONLY through the barrel) so 5b's mitigations have teeth before they're built. POC-first. Neither
  aurora nor mcprune is TS → this fixture is the only thing gating 5b.
- **5b:** §7.2 alias/barrel anti-false-isolation mitigations (the dangerous under-count modes), proven
  against the #1 TS-isolation gate. The export-root/reflection/unresolved-≠-absent hedges already ship.

## Carry-overs / debt
- **NOT MINE / leave alone (untouched, uncommitted all session):** `docs/01-product/barecontext-prd.md`,
  `docs/00-context/*`, `docs/01-product/litectx-ce-prd.md`, `docs/02-engineering/aurora-borrow-ledger.md`
  (someone's §13 CE work), `docs/02-engineering/copy-pattern-studies.md`,
  `docs/02-engineering/ce-eval-harness-scenario.md`, and two `.claude/stash/*ce-*` files.
- **Doc debt:** borrow-ledger §9 (risk thresholds) not updated — that file has uncommitted not-mine
  CE edits, so deferred to avoid collision (noted in memory `slice5a-risk-calibration-from-aurora`).
- **Possible quality follow-ups (gate-surfaceable, not blocking):** expand label sets beyond the
  audited seed (3 aurora + 6 mcprune); graduate a bench gate to an ASSERTED threshold in CI; a
  composing scenario test (index once → recall → impact) to prove views share one graph.

## Memories written this session (`.../litectx/memory/`)
- `sequence-plans-by-dependency` (feedback: deliver plans in true execution order; never offer to skip
  a known fix).
- `slice5a-risk-calibration-from-aurora` (project: risk = max(tree-sitter, rg -w) bucketed ≤2/3-10/11+,
  borrowed from aurora lsp_tool, drops LSP).

## Throwaway scripts used & removed (not shipped)
`poc-calls.mjs` (5a calls POC), `impact-val.mjs` (aurora cross-check — superseded by the committed
`poc/impact-bench.mjs`). Both written to root, run, `rm`'d.
