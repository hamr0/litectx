# Stash — litectx Tier-A CE well CLOSED (R-S8 + R-G5 dropped on evidence) · `evict()` SHIPPED · v0.8.0 published (2026-06-12, session 2)

- **Date:** 2026-06-12 (continues from `2026-06-12-rc7-compress-shipped-overclaims-corrected-v070-released.md`).
- **Repo:** `/home/hamr/PycharmProjects/litectx` (`~/Documents/PycharmProjects` = symlink, same tree). Branch `main`.
- **HEAD:** `9ac64c8`. **Pushed** to `github.com/hamr0/litectx` (push reports "Changes must be made through a pull request" — user has bypass, normal). **Tag `v0.8.0` pushed. `litectx@0.8.0` PUBLISHED to npm** (`npm view litectx version` → 0.8.0, `latest`), verified independently.
- **Working tree:** clean except two untracked prior-session stash files (`…rc7…` + this one).
- **Gates:** **167 tests** (166 pass / 1 skip = absent optional embeddings dep) via `npm test` (= `node --test`, NOT vitest) · `npx tsc --noEmit` clean · `npm run build:types` clean. CI re-ran typecheck+test before publish.

---

## The arc this session — "what's next?" → close Tier-A on evidence, ship the one real survivor

Started from the prior stash's open question: pick the next **Tier-A CE primitive** (CE-PRD §8.1) — `evict` / `quality` (R-S8) / `supersede` (R-G5). User pushed hard on **duplication / re-opening closed issues / overclaiming** throughout. Net result: **Tier-A is now fully closed** — two dropped on evidence, one (evict) built + shipped.

### Verdicts (all grounded in source / PRD / POC, not assertion)

1. **R-G5 `supersede` → DROPPED (duplicative).** Retire = `forget(id)`; replace-in-place = `remember(sameId,…)` (upsert, `store.js:395`); auto-freshness = `pruneStaleEpisodes` on every episode write; supersede-by-promotion = the `reviewCandidates` re-`remember` flow. `supersede(old,new)` = `forget(old);remember(new)` with a ribbon. Only uncovered sliver (audit forward-pointer) nobody asked for + content-verdict ceded to bareguard.

2. **R-S8 `recall().quality` → DROPPED, POC-FALSIFIED.** Three nested premises each fell:
   - moat ("off the **activation distribution**, only we hold those scores") is **void** — base-level activation was never shipped into recall (memory-PRD §4 / §14 #1/#4 falsified it repo-dependent; only BM25 + code import-spreading ship).
   - fallback (threshold raw BM25 magnitude) = the repo/query-length-dependent prior §4 forbids.
   - last candidate (label off **top raw embeddings cosine**) **POC-falsified** (`poc/confidence-poc.mjs`): AUC **0.92** (separates in aggregate) **but no usable threshold** — para/morph *real answers* sit in the **same 0.21–0.54 cosine band** as the *unanswerable* queries (≤0.36), so any τ catching "nothing here" (~0.40) falsely flags ~25% of real answers "weak", worst on the para/morph hits the label exists for. Most wrong where most used; τ is MiniLM-specific. **Same shape as the §4 activation result: real for aggregate, useless per-query.** At most a coarse garbage flag (τ≈0.25–0.30) — not built.

3. **R-G7 `evict` → BUILT + SHIPPED v0.8.0.** The one real survivor. See below.

### Overclaim I caught and RETRACTED mid-session (prove-don't-assert, again)
I floated "the access-log base-level tier was deferred only for lack of data; slice 7 records it now, so we could revive the differentiator." **FALSE** — grounding §14 #4 + §15 showed the access-log tier was **already built+shipped (v0.4.0, 5a/5b/5c)** and base-level-into-recall was **POC-falsified on real edits** (`poc/access-bench.mjs`) and ships at zero by decision. No revival pending. Don't re-open.

---

## `evict()` — how it's built (so you don't re-derive)

**The design fork (user drove it):** why not extend `forget` to stash instead of a new verb? **Decisive reason = surface boundary:** `forget` is **model-facing** (on MCP/CLI — "drop this wrong fact"); stash deletion is **runtime-only plumbing** (§10.5, API-only). Folding stash-evict into `forget` would either expose it on MCP (breaks §10.5) or split forget's behavior per-surface. Plus a **footgun**: an age/size bulk selector must NEVER reach durable facts (§4: facts don't age-decay) — `evict` touching only the `stash` table makes that **structural**, not guarded. So: **`forget` = memory-only; `evict` = stash-only.** Revised R-C4 trio `stash/get/forget` → **`stash/peek/get/evict`**.

- **`src/store.js` `evictStash(sel)`** — one selector per call: `{id}` → `WHERE path=?`; `{olderThan}` → `WHERE created_at < ?`; `{maxCount}` → `WHERE path IN (SELECT path FROM stash ORDER BY created_at DESC LIMIT -1 OFFSET ?)` (keep newest N). Cleans the evicted ids' `recall_log` rows (parity with forget's old cascade). Transaction. Returns count.
- **`src/index.js` `evict(sel)`** — `string` → by id; object → applies `olderThan` then `maxCount` in turn (compose), summed; empty policy throws. API-only (no MCP/CLI — verified both bins reference none of stash/peek/evict).
- **BREAKING:** removed the stash `DELETE` branch from `forgetMemory` (was `store.js:466`). `forget`/`forgetMemory` now memory-only. Migration: `forget(stashId)` → `evict(stashId)`. **Blast radius ~zero** — stash/evict are library-only plumbing, **no live consumer** (confirmed: NO `stash` table exists in any of 5 live `.litectx/index.db` files incl. `~/.litectx`).
- **Intended caller = a runtime orchestration loop (bareagent), NOT the model.** Policy (which/when) = bareagent; mechanism (delete) = litectx. `assemble()` stays the only open CE primitive (Tier-B, adopter-pulled).

## Validation (grounded ladder, the session's recurring theme)
- **POC `poc/evict-poc.mjs`** — exact SQL against a real `:memory:` store w/ controlled `created_at`; incl. the **never-touch-memory invariant** (most-aggressive `{olderThan:now, maxCount:0}` sweep, fact survives). But validated *candidate SQL*, not shipped code.
- **`test/stash.test.js`** — 6 evict tests by name pass against the **shipped** methods: by-id, by-age, by-count, `forget-is-memory-only` seam, `evict-never-touches-memory` invariant, throws. Migrated old `forget(id)`-stash test → `evict(id)`.

---

## Files this session
- **src (committed `9ac64c8`):** `src/store.js` (`evictStash` + removed stash branch from `forgetMemory` + JSDoc), `src/index.js` (`evict` method + forget/stash JSDoc).
- **tests:** `test/stash.test.js` (+5 net, header updated).
- **POCs (committed):** `poc/evict-poc.mjs` (new), `poc/confidence-poc.mjs` (new — the R-S8 falsification).
- **docs:** CHANGELOG (`[0.8.0]` + BREAKING note), README (v0.8.0, 167 tests, evict, forget→evict in stash desc), `litectx.context.md` (new `evict` section, forget memory-only, R-C4 trio), CE-PRD (R-G7 **SHIPPED**, R-C4 trio, R-S8/R-G5 struck w/ POC cite, Tier-A status "closed"), memory-PRD (§14 #7 confidence falsification, §15 stash line).
- **package:** `package.json` + `package-lock.json` → 0.8.0.

## Memory written/updated
- `rs8-confidence-label-falsified.md` (NEW — don't re-propose a recall confidence label) + `MEMORY.md` index line.

---

## OUTSTANDING / what's next
- **Tier-A CE well is CLOSED.** compress (v0.7.0) + evict (v0.8.0) shipped; R-S8 + R-G5 struck on evidence. The only open CE primitive is **`assemble()`** (Tier-B) — **adopter-pulled, stays DEFERRED** until a real consumer (bareagent) pins its intent/budget/ordering shape. Do NOT build speculatively.
- **bareagent is the pending consumer** of stash/peek/evict/compress (the runtime loop that parks+evicts context around the model). evict's *policy* lives there; when it exists, first question is "does `forget(id)`/`evict(id)` already cover it?".
- **Prior-session untracked stash files** (`…rc7…`, and this one) — commit whenever; left out of the release commit deliberately.
- **Roadmap remainders (all trigger-gated, NOT mandates):** persist call edges, edge-confidence, jina-code model (MiniLM was the deliberate choice — smaller, code+facts fit; jina = suggestion only), graph accessors (`getNode`/`related`).

## Carry-forward gotchas
- Push to `main` bypasses PR-protection (user has bypass) — every push says "Changes must be made through a pull request". Normal, the push lands.
- `store.js` NUL byte ~L248 → Read/node-scan, not grep.
- Test runner = `node --test` via `npm test` (NOT vitest, despite CLAUDE.md).
- npm publish = **manual `gh workflow run publish.yml`** (workflow_dispatch, OIDC trusted publishing, no token). Done this session.
- Embeddings POC/bench needs `@huggingface/transformers` (PRESENT in this env; pin dtype `q8`). The 1 skipped test = its absence-guard.
- **The user's standing bar: prove don't assert, don't re-open closed issues, don't overclaim fixes.** Validate against source/PRD/POC before claiming. This session caught: a self-overclaim (access-log revival), an imprecise mechanism claim (min–max "destroys signal" — true only for the code+spreading path, facts return raw BM25), and the R-S8 cosine sliver (POC-falsified).
