# Session 11 — write-gate emitter + summaryWindow SHIPPED & RELEASED · Tier-B resolved · tri-repo seams lit

**Date:** 2026-06-14 · **Branch:** `main` (all pushed) · **Published:** `litectx@0.14.0` on npm
**Prior:** continued from session-10 stash (Build B / COMPRESS shipped, write-gate emitter teed up next).

---

## What shipped this session (two features, two releases)

### 1. Write-gate emitter (CE-PRD §10.1) → released in **v0.13.0** (with Build B COMPRESS)
- **What:** opt-in `writeGate` hook on `remember()`. When a `LiteCtxConfig.writeGate` (duck-typed
  `{check(action)}`) is wired, `remember` emits `{type:"memory.write", kind, provenance, text, id, meta?,
  injectionRisk?}` via `toWriteAction` and `await`s `writeGate.check` **before** persisting — a `deny`
  throws `WriteDeniedError`, the write does NOT commit; `allow`/`ask` proceed. Default unset = byte-identical.
- **§6 line in code:** litectx states the SOURCE (`provenance`) + an optional guardrails `injectionRisk`
  shape flag; never the content verdict. `injectionRisk` is an optional pass-through opt on `remember`
  (litectx core never computes it). Audit/redact ship standalone: `WriteAudit` carries **NO** secret
  patterns — host supplies `redact` (a real POC finding: bare `redact` is a no-op by design).
- **Files:** `src/writegate.js` (new: `toWriteAction`/`WriteAudit`/`WriteDeniedError`), wired in
  `src/index.js` (config `writeGate`/`writeAudit`; gate in `remember`), exported from package root.
  `test/writegate.test.js` (8 tests).
- **POC `poc/write-gate-emitter-poc.mjs` (13/13) — GATE PASS** on the REAL bareguard `Gate`: emitted shape
  is load-bearing (strip `provenance`/`injectionRisk` → decision flips back to allow), floor supremacy
  holds (`injectionRisk:"high"` denies THROUGH an allowlist). F5 actually FAILED first (wrong redact
  assumption) → fixed understanding, not the bar. POC reconciled to import the SHIPPED `toWriteAction`.
- **Demand-gated** (told user): no consumer emits gate actions in normal flow; `memory.inject` reserved
  in the type union, no producer (SELECT killed). User chose to build anyway to light the seam.

### 2. `summaryWindow(units, ctx)` — R-C6 rolling-summary read-path → released in **v0.14.0**
- **What:** a SEPARATE verb composing the UNCHANGED `assemble` (kept assemble's complexity flat). Under
  budget pressure: keep last-N transcript turns verbatim, roll OLDER into one rolling summary, budget-fit
  via `assemble`. litectx owns trigger (only when over budget) + N (`ctx.summaryKeep`, default 8) + splice;
  **host owns the model** (`ctx.summarize`, `(messages)=>Promise<string>` — litectx never calls one).
- **Design that worked (after two dead-ends):** summary is a SYNTHETIC unit placed as the FRESHEST content
  (cache-stable dynamic suffix; verbatim prefix stays byte-identical for prefix caching) so the recency fit
  keeps it. Restorable: folded turns → `dropped` with `reason:"summarized"` + listed on summary unit's
  `summarizes`, recoverable by id. **Never overflows** (summary fits the fit or is dropped like any unit),
  **never worse than FIT** (falls back to plain assemble when unwired / no pressure / <2 older turns).
- **Dead-ends rejected (don't retry):** (a) forcing the summary on top of a budget-full FIT → +33% OVERFLOW
  (bad for a context fitter); (b) reserve-via-eviction + re-summarize → UNSTABLE (enlarged fold grows the
  summary past the freed room → rollback to nothing). The freshest-unit-over-assemble design avoids both.
- **Files:** `summaryWindow` added to `src/assemble.js` (separate export, `assemble` untouched), exported
  from `src/index.js`. `test/summarywindow.test.js` (8 tests). `poc/rc6-summarywindow-poc.mjs`.
- **POC GATE PASS** (live model): at equal budget, summaryWindow retained dropped-turn answers FIT-drop
  lost — discriminator **3/3 vs 0/3** (5/5 vs 2/5 overall), control green, stays WITHIN budget (379≤399).
  A confound caught + fixed before trusting (summary exceeding a last-N-only budget → silently dropped →
  fake 0/5; budget now computed after the summary). POC reconciled to drive the SHIPPED verb.

---

## Cross-repo state (VERIFIED against source, not trusted from feedback)
- **litectx:** `main` @ `281c283`, **v0.14.0 on npm**. v0.13.0 (write-gate) + v0.14.0 (summaryWindow) both
  published via OIDC `gh workflow run publish.yml`. Fully clear on the agreed set.
- **bareguard** v0.5.2: `flags` field-gate on main (`738ab20`); seam-contract test repinned to the REAL
  emitter + published `litectx@^0.13.0` (`ebeb075`), docs synced (`e6d33c4`) — **pushed, seam CLOSED both
  sides, nothing owed.** Idle-by-design.
- **bareagent** v0.13.1: RT-1/3/4 shipped, RT-2/5 deferred. **`ctx.summarize(excerpt, opts?)` SHIPPED**
  (loop.js ~307, spec §23.1.5) — **contract VERIFIED compatible**: its `renderForSummary` reads
  `m.role`/`m.content`, exactly the `[{role,content}]` litectx's `summaryWindow` passes. Committed on
  bareagent main but **LOCAL, not pushed/released** (their call — I recommended push: low-risk, lights the
  seam end-to-end; litectx doesn't depend on it being pushed).

## Tier-B RESOLVED (folded into `baresuite-litectx-prd.md §5C`; scratch `_TEMP` deleted)
Of 5 adopter-pulled asks: **R-C6 = the one real build (SHIPPED)**; **R-W3 / R-C3-C5 / R-W4 = subsumed,
no build** (state on opaque `ctx`; view-level elision via assemble; `remember(kind:"episode")`);
**R-S6 = data-blocked** (~15-20 native tools → RAG lift ≈0; needs a real corpus + intent→tools traces).
Ownership rule that settled them: a seam needing a model call or provider grammar is NOT litectx's.

## Canonical board
`docs/02-engineering/baresuite-litectx-prd.md §3.1` = the tri-repo ownership matrix + build order (the
single source of truth so the user stops bouncing between repos). §5C = resolved Tier-B contracts.

---

## Verification (final, re-run)
- `npm run typecheck`: clean · `npm test`: **235 tests, 234 pass, 0 fail, 1 skip** (pre-existing embeddings
  missing-dep skip; clean HEAD was 219 → +8 writegate +8 summarywindow = 235). No regression: `assemble`
  reverted to clean v0.13.0 then summaryWindow added separately → assemble tests byte-identical.
- **Benches:** no update NEEDED for the new verbs (recall/impact/memory benches don't touch CE-verb code →
  can't regress; CE verbs validated by live-model POCs). Added a SUGGESTION to `benches-prd.md §A2b`: add one
  `summaryWindow` replay row driven by a STUB summarizer (deterministic gate); write-gate stays OUT of the
  MRR bench (it's a gate, not a quality signal). **NOT run this session:** the external-corpus MRR benches
  (aurora/gitdone checkouts) — flagged honestly; my changes touch no recall/ranking path.

## Loose ends / not mine
- `docs/01-product/benches-prd.md` is now COMMITTED (was session-8 uncommitted; user asked to add the A2b
  suggestion this session). 5 untracked `.claude/stash/` files (sessions 7/8/8/9/10) still dangling — left
  for the user.
- Optional (flagged, not done): an end-to-end integration test wiring `summaryWindow` ↔ a real
  `ctx.summarize` — needs bareagent as a dev-dep or a thin cross-repo harness (deliberate not-done; litectx
  is the lower layer and shouldn't depend upward; POC + source-verified contract already cover it).

## Next actions (if resumed)
1. **bareagent:** push/release `ctx.summarize` (their call) → live seam fully usable end-to-end.
2. **litectx:** nothing required. Optional: e2e integration test (above); R-S6 only when its data trip-wire
   fires; the standing pre-1.0 last-call review when wanted.
