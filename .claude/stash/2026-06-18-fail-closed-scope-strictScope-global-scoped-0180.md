# Fail-closed multi-tenant doc scope — strictScope + GLOBAL + ctx.scoped() — built, reviewed, shipped 0.18.0

**Date:** 2026-06-18 · **Branch:** main · **Heads:** `6566734` (feat 0.18.0) → `72e85bb` (diff-review rename) → `<chore>` (stash sync) · all pushed · **tree CLEAN**
**Published:** `litectx@0.18.0` via OIDC `publish.yml` (trusted publishing, no token).
**Ask:** `~/PycharmProjects/multis/docs/01-product/litectx-asks/fail-closed-scope-default.md` (multis M3 security follow-up — `null` must stop meaning "all" on a multi-tenant doc store).

## The problem (multis' diagnosis, confirmed in source)
`null` doc `scope` was overloaded three ways: write-global (intentional KB), read-all (admin), forgot-to-pass (a bug). The third collapsing into the second = a silent cross-tenant leak the moment a store carries scopes. R2 fenced a *set* scope correctly; the *default* was litectx's single-tenant origin leaking through (`store.js:1103` `:scope IS NULL → no filter`). The memory axis (owner/session) was already safe because it BINDS ONCE on the instance — the real safety property is bind-once, not fail-closed. The doc axis made scope a forgettable per-call arg.

## What shipped (3 additive pieces, doc/blob axis ONLY)
- **`new LiteCtx({ strictScope: true })`** (default false → byte-identical legacy) — a missing scope on `recall({kind:'doc'})` / `get` / `ingest` / `remember({kind:'doc'})` THROWS, read AND write (un-scoped ingest silently publishing to the shared tier is a *persistent* leak → write fails closed too, fail-fast before parse).
- **`GLOBAL`** (exported `symbol`) — unambiguous shared-tier opt-in so "deliberately global" ≠ "forgot." A read/write SENTINEL, never stored (maps to `doc_scope.scope IS NULL`) → no migration, `scope ∪ NULL` union intact.
- **`ctx.scoped(scope)` → `ScopedView`** — binds scope once over recall/get/ingest/remember; no per-call scope to forget (doc-axis analogue of instance owner/session). Bad bind throws at creation.

## Architecture / decisions
- **Policy lives in the FACADE** (`_resolveReadScope`/`_resolveWriteScope` in index.js); store stays policy-free. Store gets a tri-state read filter `{scope, seeAll, now}`.
- **Tri-state SQL** (`store.js` search): `AND (:seeAll = 1 OR ds.scope IS NULL OR (:scope IS NOT NULL AND ds.scope = :scope))`. seeAll=1→all (legacy); seeAll=0+scope NULL→global-only (GLOBAL); seeAll=0+scope set→union. `seeAll` defaults to `scope==null` so any direct Store caller is byte-identical pre-strict.
- **`getItem` gains `globalOnly`** (renamed from `global` in diff-review — shadowed the Node builtin): hides any tenant row when GLOBAL-fetching.
- **Axis-correct:** recall enforces strict only when `kind` touches `'doc'`; `get` always throws bare under strict (can't fence a guessable id without fetching); `fact`/`episode`/`code` untouched (non-goal: don't flip the memory-axis default — it's already bind-once-safe).
- Symbol can't reach SQL: every resolve maps GLOBAL→null and a non-string/non-GLOBAL scope THROWS before any store call.

## Files
- `src/store.js`: tri-state search predicate + `seeAll` bind; `getItem(id, now, scope, globalOnly)`.
- `src/index.js`: `export const GLOBAL`; `strictScope` config+field; `_resolveReadScope`/`_resolveWriteScope`; `scoped()`; `ScopedView` class; wired recall/get/ingest/remember (scope type widened to `string|symbol`).
- `test/strict-scope.test.js`: 15 tests, each w/ a negative control. **304 total, 303 pass, 1 pre-existing skip.**
- Docs: README, litectx.context.md, CHANGELOG 0.18.0, memory-prd. CE-PRD/baresuite-PRD untouched (boundary docs, zero scope refs).

## Verification (prove-don't-assert)
- POC'd the tri-state predicate against a real DB w/ negative controls BEFORE wiring (seeAll leaks cross-tenant = the control).
- **Mutation-verified BOTH ways:** neutering the read throw → 4 tests fail; forcing the fence open (`seeAll=1`→`1=1`) → 7 fail; reverted → 15 green.
- tsc clean, build:types clean, GLOBAL/strictScope/scoped()/ScopedView in generated `.d.ts`.
- `/security`: clean (parameterized SQL, IDOR closed under strict, no symbol→SQL, no new deps). 2 LOW informational caveats (secure mode opt-in; raw `Store` bypasses the facade) — both by-design + documented.
- `/diff-review`: Ready=Yes. 1 fix (global→globalOnly); ScopedView ternary = intentional tsc narrowing (false positive).

## Friction / lessons
- **Reverting a sed MUTATION with `git checkout <file>` wiped all uncommitted work on that file** (store.js survived, index.js lost — had to re-apply 10 edits). Revert a sed mutation WITH sed, never `git checkout` on a file with live uncommitted changes.
- User said "npm publish" → the repo's publish is OIDC `gh workflow run publish.yml` (trusted publishing), never local `npm publish`.

## Open / not-mine (multis lane)
- multis may flip the ask doc Status to "IMPLEMENTED in litectx@0.18.0" and adopt `strictScope: true` + `ctx.scoped(scope)` (supersedes their wrapper `toRecallScope`/`forScope` reimplementation). Their call, their repo.
