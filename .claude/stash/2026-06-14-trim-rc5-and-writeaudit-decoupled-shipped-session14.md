# Session 14 — `trim` (R-C5) + `WriteAudit` decoupled, both shipped & published

**Date:** 2026-06-14 · **Branch:** main (clean, in sync with origin) · **Published:** litectx@**0.16.1** live on npm

## TL;DR

Two releases cut this session, both consumer-facing and published via the OIDC `publish.yml` workflow:

- **0.16.0 — `trim(units, policy)` (R-C5)** — the transcript-truncation verb, litectx half of the RT-2
  harvest-before-evict interlock.
- **0.16.1 — `WriteAudit` decoupled from `writeGate`** — the standalone write paper-trail now actually
  works without a gate.

litectx-side work for the bareagent RT-seam is now **complete**; everything remaining is bareagent-side.

## Commits (HEAD = 6a3218f)

- `6a3218f release(0.16.1)` — decouple WriteAudit from writeGate
- `bb23e1a release(0.16.0)` — trim R-C5
- `f7a3081 test(trim)` — cover COUNT-path atomic-with-pinned force-keep
- `328564d feat(trim)` — R-C5 verb

## What shipped — `trim` (0.16.0)

`src/assemble.js` (with `assemble`/`summaryWindow`), exported from `index.js`. A **thin verb** (the
`summaryWindow` pattern):
- **SIZE** (`maxTokens`) → delegates wholesale to `assemble`'s fit (POC C1: `===` unit-for-unit).
- **COUNT** (`keepLastN`) → net-new turn-granular policy; no token budget reproduces "keep last N turns"
  when sizes vary (POC C2a). `maxTokens` wins if both set; neither → no-op.
- Preserves `pinned`/`atomic`; **eviction contract** = `harvest[]` (dropped units, content intact) = the
  harvest-before-evict worklist.
- POC `poc/rc5-trim-poc.mjs` (C1/C2 use an in-file prototype; **C3 tight cases use the SHIPPED verb** —
  caught a prototype-vs-shipped drift on negative `keepLastN`). `test/trim.test.js` (15).
- Code-review finding (fixed): the COUNT-path atomic-with-pinned force-keep (`assemble.js:300`) was
  untested → added regression.

## What shipped — `WriteAudit` decouple (0.16.1)

`src/index.js` `remember()`: the write block now runs on `if (this.writeGate || this.writeAudit)`. Gate
checked only when present; absent → synthetic `{ outcome: "allow", reason: "no-gate" }`. Audit emits
whenever a sink is set. **Strictly additive** (audit-without-gate previously did nothing).
- **Why it mattered:** `WriteAudit` is documented as the standalone paper-trail, but the emit was nested
  inside the `if (this.writeGate)` branch → an audit trail *required* also wiring a gate. Real gap, not
  just "demand-gated."
- **Adapter writes covered for free:** `liteCtxAsStore(lc).store()` → `lc.remember()` (verified
  memory-store.js:65), so a `writeAudit` wired once on `lc` audits adapter writes too. bareagent stays
  transparent.
- `test/writegate.test.js` (+3 → 12): audit-without-gate logs synthetic allow + write commits; redact
  without gate; one line per write.

## Docs propagated (the user audited this twice — be thorough)

trim: README Sockets/verbs, `litectx.context.md` (full section + table + exports), CHANGELOG, CE-PRD
(RT-1→SHIPPED, RT-2 trip-wire fired, RT-4→CLOSED, R-C5→SHIPPED, §263/§10.5).
WriteAudit: `litectx.context.md` (cap-table 87, config 145, prose 404-, **a copy-pasteable
`new WriteAudit({sink,redact})` recipe**, **adapter-is-audited note** in the `liteCtxAsStore` section),
README Sockets row, CHANGELOG, CE-PRD §10.1, baresuite-PRD §②. **Lesson reinforced
([[verify-shipped-against-poc-data]] / prove-dont-assert): first doc pass missed README + both PRDs +
context:87 — propagate to ALL of {README, context, CHANGELOG, both PRDs} and verify with a grep.**

## RT-seam state (CE-PRD §8.2 — all litectx obligations now done)

- **RT-1 assemble** ✅ SHIPPED (0.11.0 + COMPRESS).
- **RT-2** — litectx half = `trim` ✅ SHIPPED. Durability POC passed earlier (crash@hop3 kept hops 1-2;
  batch lost all). Correction recorded: "transcript stays intact" is a bareagent-runtime assumption
  litectx can't enforce → 2nd justification = **durability** (crash/overflow, not just `trim`).
- **RT-3** ✅ SHIPPED (body flag / meta passthrough / `liteCtxAsStore`).
- **RT-4** ✅ CLOSED — **bareagent shipped its own mount** (`tools/litectx-mcp.js` `liteCtxMcpBridgeConfig`
  + CLI `cfg.mcp`, 13/13 — that's *bareagent's* repo, NOT litectx; litectx 0.13.0 was write-gate+COMPRESS).
  Zero litectx code. My earlier RT-4 handoff was a pre-landing spec — stale.
- **RT-5** — litectx `owner`/`session` predicate built; harness threading deferred (bareagent-side).

Memory `bareagent-rt-seam-contract.md` updated with all of the above.

## OPEN THREAD — bareagent-side only (no litectx work)

**RT-2 loop wiring — user selected Option 2 (full in-loop interlock); I agreed.** The decision and
reasoning to hand bareagent:
- Build `new Loop({ trim: unitTrimmer({trim, onHarvest, policy}) })`: trim each round before assemble,
  **residual flush of survivors at loop:done** (F2 — without it, harvest-on-evict diverges from batch),
  `result.msgs` becomes the TRIMMED transcript (evicted turns live in the store, restorable by id).
- **Why Option 2, not a thin seam:** F1 (stable dedup id must come from `tool_call_id`/content-hash off
  the unit's `_msgs` — bareagent-grammar-specific, can't be ceded to consumers without leaking grammar)
  and F2 (residual flush is a correctness invariant, not policy) **both belong in the framework**.
- **5 guardrails:** (1) opt-in, default off (bare Loop = RT-1 non-destructive); (2) fail-open —
  harvest throws → DON'T evict; (3) flush loop-owned + idempotent; (4) writes via `lc.remember(id,…)`
  NOT `mem.store(content,{id})` (the latter seals id into opaque meta, not the key); (5) document that
  `result.msgs` becomes lossy-but-restorable-by-id when trim engaged.
- **F1 bug it corrected in my handoff:** `mem.remember` doesn't exist (adapter is `{store,search,get,
  delete}`); and unit ids from `toUnits` `_seq++` are NOT stable across rounds → double-write. Use a
  stable turn property + `lc.remember` upsert.

**For the user's own use:** trying litectx with multi-user chatbot. Audit = wire `writeAudit` sink;
per-user isolation = `owner`/`session` scope; injection defense = optional `writeGate`
(`injectionRisk` + floor supremacy). All host-side config, all against shipped litectx.

## Process notes for next session

- Every `main` push **bypassed branch protection** (user's perms allow it) — expected, flag it each time.
- Publish = manual `gh workflow run publish.yml --ref main`; idempotent + registry-verify. The 0.16.0
  run hit a transient `ECONNRESET` on `npm install -g` (before any gate) → `gh run rerun <id> --failed`
  fixed it. 0.16.1 was green first try.
- Tests: `node --test` (NOT vitest despite CLAUDE.md); typecheck `tsc --noEmit`; build = `build:types`.
  Suite at 261 (260 pass, 1 pre-existing skip).
- The user repeatedly audits: "did you validate?" / "surface everywhere it fits?" — run the suite + grep
  ALL doc locations before claiming done. POC tight/no-fit cases are mandatory (AGENT_RULES).
