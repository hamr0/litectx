# Session 10 — Build B (assemble COMPRESS tier) shipped + real-data validated · bareguard flags respec · Tier-B questions

**Date:** 2026-06-13 · **Branch:** `build-b-compress-tier` (2 commits, **local — not pushed**)
**Next action (decided):** stash (this file) → build the **write-gate emitter**.

---

## What shipped this session

### 1. Build B — `assemble()` COMPRESS budget tier (commit `df8fdd6`)
- **What:** when FIT would DROP a parseable `code`/`doc` unit, recover it as its `compress()` **signature**
  before evicting. `compressed:true` on the kept unit; full body restorable by id (like a drop).
  Rank/recency-driven (reuses FIT's order, **NOT positional** — lost-in-the-middle refuted at scale);
  fires only when the signature both **saves** and **fits**.
- **`assemble` is now ASYNC** (`Promise<AssembleResult>`) — only await is `compress()` (pure tree-sitter
  render; stays deterministic + cache-stable). Compatible with the live consumer: bareagent's adapter
  already `await`s (`bareagent/src/context-units.js:217`). Consumers pinning `^0.11.0` need a minor bump.
- **Implementation:** `src/assemble.js` — two-pass; Pass 1 (FIT) **unchanged/byte-identical**, Pass 2 =
  rescue would-be-dropped compressible units in recency order. Candidate = `!keep && !pinned && !atomic &&
  kind∈{code,doc} && format && content`. 5 new tests (`test/assemble.test.js`, now 17).
- **SELECT stays OUT** (auto-inject POC-killed earlier; `ctx.task` reserved). The original RT-1 framing
  (SELECT+COMPRESS+FIT) is superseded by the POCs: SELECT dead, COMPRESS is the buildable.

### 2. Real-data validation (the user pushed hard on prove-don't-assert)
- New POC `poc/assemble-compress-seam-poc.mjs`: 8 REAL functions from `litectx/src` + `bareguard/src`,
  fed through the SHIPPED verb, live `claude -p` model.
- **Result: seam mechanic 8/8; PARAMS retrieval signature 8/8 vs drop 0/8** (holds for doc-less
  bare-header fns); **mean real saving 81%** (51–97%).
- **A measurement bug was caught + fixed, not glossed:** first run scored 6/8 because a lazy-regex
  extractor captured MULTI-DEF spans → `signatureOf` described the WRONG (first) function; also inflated
  the saving. Diagnosed by inspection (not assumed), fixed (anchor on decl + adjacent-doc + one-function
  guard), re-ran → 8/8. The too-good saving number triggered the recheck. Recorded in `poc/RESULTS.md`.
- A body-literal metric mis-scored (verbatim 0/8, ambiguous question) → **dropped**, not dressed up;
  compress-middle's body-needle (sig 0/2 = drop) already covers that limit.
- FIT path verified byte-identical post-async (19%/3.8% on 1059 real deps, `assemble-verify-shipped.mjs`).

### 3. bareguard flags seam respec (folded into commit `df8fdd6`, docs)
- Triggered by user: "bareguard should build for litectx." Found the real gap: §10.1 says "bareguard
  gates the flag by shape" but bareguard had **no structured-field gate** — only `action.type` (allowlist)
  and `JSON.stringify` regex (content). Routing a verdict through JSON-regex violates the §8.2 boundary.
- **The one net-new bareguard build = a generic `flags` field-value gate** (reads `action.provenance` /
  `injectionRisk` directly, deny/ask, BEFORE the allowlist for floor supremacy). NOT `memory.*` type
  recognition (the floor is already type-generic — confirmed in `bareguard/src/gate.js`, proven by
  `test/seam-contract.test.js`). bareguard has since BUILT `flags`; it's now idle-by-design.
- **Refinement to §10.1:** litectx emits the **SOURCE** (`provenance:"web"`), NOT a trust verdict
  (`"untrusted"`); the policy renders the verdict. Spec lives in `baresuite-litectx-prd.md §5B` (+ §2②, §8),
  reconciled into `CE-PRD §10.1`.

### 4. Adopter docs (commit `238af01`)
- `litectx.context.md` + `README.md` updated: assemble = FIT + COMPRESS + async (were "FIT only;
  deferred"). Unit shape gains `format?`/`symbol?`.

### 5. Stale-doc corrections found while auditing
- `getNode`/`related` are **SHIPPED** (2026-06-12, `src/index.js:440/454`, `test/graph.test.js`) — the
  baresuite-prd §2③/§3 calling them "absent" was stale (predated the graph build); CORRECTED. My earlier
  "build getNode next" recommendation was wrong because of that stale doc.
- CHANGELOG's "no live consumer yet" was FALSE (bareagent is one) → corrected.

---

## Cross-repo state (verified this session)
- **bareagent:** shipped v0.13.0 "litectx-runtime seam set — assemble + RT-3 + RT-4". Adapter awaits
  assemble (async-compatible). Pins `litectx ^0.11.0` (needs bump for COMPRESS). Does NOT emit gate actions.
- **bareguard:** `flags` field-gate built; idle-by-design. Its swap-point (synthetic→real seam test) waits
  on litectx emitting real `memory.write`/`memory.inject` — i.e. the **write-gate emitter**, unbuilt.

---

## NEXT: the write-gate emitter (the decided next build)
- **What:** litectx's own minimal, optional **write-gate hook** that turns a write/inject into a gate-able
  `{type:"memory.write"|"memory.inject", kind, provenance, text, id, injectionRisk?}` action, with its own
  standalone audit-log + `redact` (adapt from `bareguard/primitives/audit.js`, `secrets.js`). §10.1 / §5B.
- **Unblocks:** bareguard's flags swap-point + the integration bench, end-to-end.
- **Honest caveat (told the user):** DEMAND-GATED — no consumer emits gate actions yet (bareagent doesn't).
  User chose to build it anyway to light up the seam. Currently `memory.inject` has no producer at all
  (SELECT killed); `memory.write` producer = this hook around `remember`.
- **POC-first per AGENT_RULES:** validate the hook's value/shape before building (the §6 line: litectx
  emits source+shape-flag, NEVER content judgment).

## Pending after that — Tier-B (adopter-pulled, blocked on bareagent answers, NOT on litectx coding)
What I need from bareagent (the §5C asks, detailed this session — offered to fold into §5C):
- **R-W3 session/state:** state schema (fields+types); per-field LLM-visible vs isolated (R-I2);
  lifecycle (1:1 run? spans runs?); durability (survive restart?); concurrency (versioned vs LWW?).
- **R-C6 summaryWindow:** trigger (turn-count/token threshold?); N verbatim to keep; confirm the LLM seam
  (litectx returns `{keep, toSummarize}`, host does prose, litectx splices — litectx never calls an LLM).
- **R-S6 selectTools:** NEEDS DATA before build — tool-def format + a real corpus + (intent→tools-used)
  traces to bench the RAG-over-tools lift (rerank idea was falsified topic-blind; re-validate on real data).
- **R-C3 clear / R-C5 trim — SUBSUMPTION CHECK FIRST:** assemble FIT + COMPRESS already do view-level
  elision. Ask: need DESTRUCTIVE transcript mutation, or does per-call fitting suffice? If destructive →
  need trigger ("spent" = when?) + stub contract.
- **R-W4 note store — SUBSUMPTION CHECK:** likely covered by `remember(kind:episode)` + `stash`. Ask if a
  distinct append-only `note` primitive is really needed.

Dropped — do NOT rebuild: R-S8 quality, R-G5 supersede, SELECT auto-inject, R-W7 recordUseful-as-score.

## Loose ends
- Branch `build-b-compress-tier` is LOCAL (2 commits) — not pushed, no PR. User said "commit for now."
- **Uncommitted, NOT mine:** `docs/01-product/benches-prd.md` (+89 lines, a session-8 live-A/B findings
  section) + 4 untracked `.claude/stash/` files (sessions 7/8/8/9). Left for the user to handle.
- Package still at v0.12.0; Build B is `[Unreleased]` in CHANGELOG. Version bump = a release decision (not
  taken). README intentionally does NOT claim a v0.13.0 release.
- Optional polish (not on critical path): bareguard cookbook sample 9 (flags recipe) — hold until the
  emitter exists to demo a real end-to-end flow.
