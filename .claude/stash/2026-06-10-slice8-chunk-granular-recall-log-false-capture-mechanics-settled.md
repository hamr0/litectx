# Stash: Slice 8 shipped (chunk-granular recall + log:false) · capture mechanics settled · all committed & pushed

**Date:** 2026-06-10 (second stash today; continues `2026-06-10-slice7-write-path-7b-stemming-capture-design.md`)
**State:** CLEAN — everything committed and pushed. `main` @ `89daaef`. Three commits this session:
`33c819a` (slices 7+7b+8 code/tests/docs) · `b14c544` (stash notes) · `89daaef` (software-factory PRD draft).

---

## What shipped this session

### Slice 8 — chunk-granular recall + `log: false` (committed in `33c819a`)
- **Every hit carries `chunk: { symbol, nodeType, startLine, endLine } | null`** — the best-matching
  chunk INSIDE the already-ranked file. Attached **after** ranking, final hits only (≤ n per kind,
  never the pool) → localizes, never reorders → **all gates byte-identical** (aurora 0.552 /
  gitdone 0.425 / memory 1.000·0.722·0.000-pinned / impact 0+0).
- **Scoring:** `splitIdent` both sides (the indexing convention), score = distinct query terms
  present (symbol + body), plus the **containment rule** (see validation finding below): the winner
  may not strictly contain another scoring chunk; ties named > anonymous > smaller span; anonymous
  winners (arrows) labeled with nearest named container. `null` = honest (written memory has no
  chunks — the row IS the unit; filename-only matches name none).
- **`recall_log` gained `symbol` column** → recalled∧edited join at the SAME grain when the
  access-log tier's edit-bind lands. `logRecall` records `h.chunk?.symbol ?? null`.
- **`recall(q, { log: false })`** — the demand-signal opt-out. Spec (user's framing, now doctrine):
  *the recall log is a demand signal; anything that isn't real demand must not write to it*
  (dashboards, CI, batch tooling, read-only db opens). Default true; both flat + grouped modes.
- **CLI** prints the pointer: `→ symbol:start-end` column (bin/litectx.js `fmtChunk`).
- **Store schema self-heal on open** (constructor): `docs` without `source` = ≤0.1.0 db, cannot
  contain written memory → `reset()` (re-indexable only); `recall_log` without `symbol` = additive
  → `ALTER TABLE`, data preserved. Rule: preserve when possible; only ever drop what `index()` rebuilds.
- **87/87 tests** (+8: second-function localization, md section, filename-only→null,
  class-never-beats-method, written-memory→null, log:false both modes, symbol-in-log,
  pre-0.2-db self-heal); `tsc` clean.

### Validation round (user: "validate what you just delivered, ground it") — found 3 real issues
1. **Container trap (precision bug):** live probe on litectx itself returned `chunk: Store class,
   lines 106–560` (455 lines) instead of the 41-line `attachChunks` method — containers' term sets
   are supersets of their children's, so naive max-count can never pick a method over its class.
   Fixtures (top-level functions only) missed it. Fix = the containment rule. Probe receipt after:
   `src/store.js → attachChunks:491-532 (method_definition)`.
2. **0.1.0 upgrade crash:** stale pre-slice-7 db → `table docs has no column named source` on
   `index()` — the exact crash every published v0.1.0 adopter hits on upgrade (CREATE IF NOT
   EXISTS leaves stale tables). Fix = self-heal. (Deleted the repo's stale `.litectx/index.db`
   dev artifact during probing — rebuildable.)
3. **CLI blind to the feature** (tested-vs-built gap again): hit printer didn't show `chunk`. Fixed.

---

## Design settled this session (all in PRD now)

- **PRD §3.3 (NEW)** — "The memory model at a glance": 4 kinds × 6 operations × 2 frozen weights;
  Table 1 (kinds), Table 2 (operations), the day-by-day story. The user's anti-spaghetti readout.
- **PRD §14 #4 SETTLED block (2026-06-10)** — capture mechanics:
  - **Harvest-at-recall** (user's design): at recall() start, stat only recall_log-window files —
    O(window), no cron, no host cooperation. BLA decay = read-time formula over timestamps
    (`ln(Σ age^-d)`), nothing mutates in background.
  - **File hash = trigger, chunk diff = attribution** — no equal boost; old chunk text in `nodes`.
    Join-grain caveat now CLOSED (slice 8 logs the symbol).
  - **`forget` is NOT a scored signal — DROPPED** (user's simplification): hard delete removes
    row+embedding+log → nothing left to demote; only corrective re-`remember` carries weight.
  - **Trust ≠ activation:** provenance durable, activation perishable (power-law decay).
  - **Impressions on probation:** may earn tiny bounded log-scale boost ONLY via bench ("earn its
    place over tens of retrievals" — user-endorsed). Survived-exposure = candidate, unproven.
  - **Wrongness out of scope for ranking** — guards are structural (impressions powerless,
    unreviewed ≠ promoted, correction outweighs any impression count, decay starves un-refueled).
- **No facts-embedding default** (closed): embedder = optional peer dep + 15–19s cold load →
  defaults can't depend on it; facts ride the ONE tier switch; para hole accepted + documented
  (write facts in query words; id is indexed). Memory bench's para queries measure lift free when on.
- **Stage-2 ranking explained & pinned:** additive boosts, never averages — convex blend was
  measured to tax well-ranked files (aurora's treadmill); two knobs only (SPREAD_WEIGHT 0.3
  hardcoded, embedWeight 1.0), frozen by 4-repo bench.
- **Impressions defined:** appearance in results (ad-tech sense); scoring them = ranker grading
  its own homework.

## Docs state (all synced + committed)
PRD (§3.2/§3.3 NEW/§5.1/§9/§11.2 slice-8 entry/§14 #4 settled/§15 resequenced) · CHANGELOG
(slice 8 + struck log:false open item) · litectx.context.md (Hit.chunk, log opt, upgrade-self-heal
gotcha, rewritten recall-writes gotcha) · README (87 tests, chunk pointer) · project memory
(`slice7-write-path.md` + MEMORY.md index).

## Next builds (user-confirmed order, PRD §15)
1. **`get(id)` / body access** — pre-MCP (recall returns fact ids; no way to read text). Fetch
   logging = tagged weak signal only (demoted fetch-toll, never foundation).
2. **MCP/CLI parity** (§14 #5) — separate `litectx-mcp` pkg, stdio, client-spawned;
   tools: index/recall/impact/remember/forget/get.
3. **Access-log tier** (§4, §14 #4) — edit-bind (harvest-at-recall) + corrective re-remember;
   episodes-first; trust-weighting; **requires building the action-signal bench (the biggest IOU)**.
   Every signal type earns weight there or ships at zero. Activation re-ranks, NEVER gates.

## Session lessons (meta)
- "Validate what you delivered, ground it" caught 2 real bugs + 1 surface gap that 85 green tests
  missed → **live-probe the real repo, not just fixtures, before claiming shipped**. Fixtures
  shaped like the happy path (top-level functions) can't catch structural cases (nesting).
- Test-count drift: counts cited in docs went stale twice in one session (79→85→87) — sweep
  numeric claims across README/MEMORY.md/CHANGELOG after any test add.
- User wants ONE simple mental model (tables + story), not five angles on one deferred tier —
  the §3.3 at-a-glance readout is the template for future "how does X work" moments.
