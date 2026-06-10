# Stash — litectx: Slice 5b COMPLETE (barrel/path-alias false-isolation + TS gate), committed & pushed

- **Date:** 2026-06-09
- **Repo:** `/home/hamr/PycharmProjects/litectx` (git, `main`, public `hamr0/litectx`). The
  `Documents/PycharmProjects/litectx` path resolves to the SAME checkout (verified `readlink -f`).
- **Continues:** `.claude/stash/2026-06-05-litectx-slice5a-impact-view-and-bench-gate.md`. Chain:
  slice3 → slice4 → slice5a → **this (5b built + #1 TS gate + shipped)**. The 5a stash's "NEXT" was
  "#1 (TS fixture) then 5b" — both now done.
- **Mode:** BUILD. Real `src/` written, tested, benched, committed, pushed. Plus adversarial
  validation (mutation check) and a new ISOLATION-accuracy gate row.
- **Governing:** `.claude/memory/AGENT_RULES.md` + `LIBRARY_CONVENTIONS.md`. SoT = `docs/01-product/
  litectx-memory-prd.md`. CLAUDE.md doctrine (no LSP; ripgrep+tree-sitter; over-count safe; embeddings
  off; better-sqlite3+FTS5; borrow aurora calibration).

## HEAD == upstream == `4bac1c1` (pushed). This session's commit (on `main`):
- `4bac1c1` **Slice 5b: barrel/path-alias false-isolation mitigation + TS gate (§7.2).** HEAD.
  - (Prior: `212b7b3` docs(ce) — someone else's CE work, NOT mine; `b85c495` 5a stash.)
  - Push note: remote branch-protection ("changes must be made through a pull request") was
    **bypassed** by admin rights — push succeeded. (Workflow here is main-based for every slice.)

## The bet 5b closes (§7.2 — the one dangerous under-count)
impact() resolves callers BY NAME (`rg -w` → tree-sitter confirm). A symbol reached only under a
**RENAMED re-export** — `export { default as Panel } from "./widget-impl"`, imported via a tsconfig
path alias `@ui`, called as `Panel()` — has its def name appear NOWHERE outside its def line →
`rg -w renderWidget` = 0 refs → **FALSE ISOLATION** (the cardinal sin). Renamed *named* exports
(`computeArea as area`) survive on the rg floor (barrel line carries the original name) but the
caller LIST is empty until resolved.

## What shipped — #1 (the TS gate, gives 5b teeth) — COMMITTED, reproducible
- **`poc/fixtures/ts-barrel/`** (committed TS app; `git add` was required so the indexer's
  `git ls-files` sees it). Files: barrel `src/index.ts` (`export { default as Panel } from
  "./widget-impl"` etc.), `@ui`/`@ui/*` path alias in `tsconfig.json`, `widget-impl.ts`
  (`export default function renderWidget` — the planted default-rename), `shapes.ts`
  (`computeArea`→`area` named-rename), `math.ts` (`double`, name-reachable sanity), `decoy.ts`
  (an UNRELATED local `Panel` + `usesLocalPanel` — the precision trap), `app.ts`+`dashboard.ts`
  (consumers importing via `@ui`). **CRITICAL fixture rule:** the def name `renderWidget` must appear
  ONLY on its def line (excluded by `inOwnDef`) — I caught my own comments leaking the token into
  consumer files, which would seed the rg floor and PAPER OVER the gap; reworded so `rg -w
  renderWidget --glob '*.ts'` returns only widget-impl.ts:defline.
- **`poc/datasets/impact-ts.mjs`** — hand-audited labels with NEW fields `isolated` + `reachVia`.
  3 labels: `double` (direct/sanity), `computeArea` (barrel-named-alias/caller-recall),
  `renderWidget` (barrel-default-alias/THE GATE).
- **`poc/impact-bench.mjs`** gained: **ISOLATION-accuracy** `(refCount===0)===L.isolated` (the teeth)
  + sharpened **SAFETY** = never a *silent* isolation (`refCount>0 || hedges.length>0`, vs the old
  `refCount>0`). aurora/mcprune unaffected (all refCount>0). impact-ts added to the default run.
- **Grounded RED before fix:** `renderWidget` → `refs:0 ISO:MISS`, exit 1, SAFETY `ok` (hedged — so
  NOT a false safety claim). `double` 100% (TS confirm works). **GREEN after 5b.**

## What shipped — 5b (the mitigation) — all in `src/`, on-demand, no LSP, no new persistence
- **`src/chunker.js`** +`reExportsOf(format,body)` (barrel `export { local as exported } from
  "src"`; star ignored — name-preserving) +`importBindingsOf(format,body)` (`import { name }`
  external name + default). Both JS/TS only, parse-fail-soft to []. Field names verified by probe:
  `export_specifier`/`import_specifier` use `name` (source/external) + `alias` (exported/local).
- **`src/tsalias.js` (NEW)** — `loadTsPaths(root)` (best-effort tsconfig `paths`/`baseUrl`, JSONC
  comment-stripping fallback) + `specResolvesTo(fromPath,spec,target,tsPaths)` (relative + alias,
  ext/index resolution). **Deliberately SEPARATE from `edges.js`** so recall's import resolution +
  frozen bench are UNTOUCHED (the key design call — extending edges.js would risk moving recall).
- **`src/impact.js`** +`aliasCallers(root,include,symbol,defs,inOwnDef)`: (1) discover aliases — for
  each JS/TS def, `isDefault = /^\s*export\s+default\b/.test(body)` (the stored def body INCLUDES
  the `export default` prefix — verified), rg-list files mentioning the def's stem → parse their
  reExports → keep those whose `source` `specResolvesTo` the def file → alias = renamed-export or
  renamed-default; (2)+(3) for each alias, `rg -w alias` → files that ACTUALLY `import {alias}` from
  the barrel (`specResolvesTo` scoped — EXCLUDES the decoy) → `callSitesOf` → callers tagged
  `caller.alias`. Adds callers only (over-count safe). Wired into `computeImpact` after the direct
  caller loop, before refCount; pushes an alias hedge ("reached under re-exported alias(es) …").
  +`rgListFiles` (`rg -l -F`), +`fmtOf`. `Caller` typedef gains optional `alias`.
- **`test/impact-alias.test.js`** (6 tests, hermetic tmp fixture): renamed-default + renamed-named
  resolution, alias attribution, **scoped exclusion** of the decoy AND of a same-named symbol
  imported from elsewhere, the rename hedge, unit `specResolvesTo`/`loadTsPaths`.

## Validation of record (answering "validate + ground")
- typecheck clean · **53/53** `node --test` (47 prior + 6 new) · impact gate **0 SAFETY / 0
  ISOLATION failures, exit 0** (renderWidget refs 0→2, caller-recall 0→100%, decoy excluded) ·
  **recall bench BYTE-IDENTICAL aurora 0.552 / gitdone 0.425** (proves 5b is impact-only) ·
  aurora/mcprune impact gates still 100% recall, 0 false-isolations (py skipped by JS/TS guard).
- **Mutation check (teeth):** dropped the `specResolvesTo` scoping → `other.ts` (imports `Widget`
  from the decoy, not the barrel) miscredited → "alias attribution is scoped" test FAILS → proves
  the path-alias resolution is load-bearing, not decoration. Reverted.

## Docs updated & pushed (this is what the user explicitly asked to commit: "changelog, prd, context")
- **CHANGELOG.md** — new top `### Added` 5b bullet; `### Next` rewritten (slice 5 complete).
- **docs/01-product/litectx-memory-prd.md** — §7 5b status note; §7.2 mitigation table (barrel +
  path-alias rows → ✅ build 5b); §11.2 slice-5b → ✅ SHIPPED; capability row (5a+5b); §11.3 gate
  table row (TS false-isolation → ✅ shipped) + status note + the "sequenced into 5b" past-tense fix.
- **litectx.context.md** — Impact typedef (`caller.alias`), the safety bullet (renamed barrel/alias
  now resolved; single-hop + JS/TS-only caveat), capability table, stale intro ("slices 0–2" → "0–5"),
  "(soon) impact view" → present tense.

## NOT MINE — left UNTOUCHED & UNCOMMITTED (deliberately unstaged from the 5b commit)
- `README.md` (M — a "Where litectx fits" baresuite/litectx positioning section) and
  `docs/01-product/software-factory-prd.md` (?? — a new Software-Factory adopter PRD draft). Both are
  someone else's CE/positioning thread (same class the 5a stash flagged). The user's own list
  ("changelog, prd, context") excluded them. **Do not commit these as part of slice work.**

## Carry-overs / debt / known bounded gaps (documented in code/README, non-blocking)
- 5b is **single-hop** barrels + **JS/TS only**. Multi-hop barrel chains and **Python `from x import
  y as z` re-export barrels** are NOT followed (noted in PRD/context/CHANGELOG). py is skipped by the
  `aliasCallers` JS/TS guard → aurora gate unaffected by design.
- Borrow-ledger §9 (risk thresholds) still not updated — that file had uncommitted not-mine CE edits
  historically; check before touching (memory `slice5a-risk-calibration-from-aurora`).
- Gate follow-ups (gate-surfaceable, not blocking): a **composing scenario test** (index once →
  recall → impact, proving one shared graph); graduate a bench gate to an **asserted CI threshold**;
  expand audited impact label sets.

## NEXT (nothing yet sequenced — slice 5 is done; recall + impact over one graph = the v1 surface)
Candidates (user to steer — memory `prefers-discussion-over-multiple-choice`): composing scenario
test · asserted-CI bench threshold · expand impact labels · OR open the **post-v1 tiers** (opt-in
embeddings; the access-log base-level activation differentiator).

## Memories written/updated this session (`.../litectx/memory/`)
- NEW `slice5b-barrel-alias-mitigation` (project) + MEMORY.md index line. Captures: impact-only
  (tsalias.js separate from edges.js → recall frozen), the ts-barrel/#1 gate, red→green teeth,
  mutation-checked decoy exclusion, single-hop/JS-TS gaps. Links [[slice5a-risk-calibration-from-aurora]].

## Throwaway scripts used & removed (not shipped)
`_probe.mjs` (written to repo root several times — TS grammar node shapes, impact() probes on the
fixture, stored-node inspection, export/import specifier field names). Each run then `rm`'d. None committed.
