# Stash: access-log tier views 5a + 5b SHIPPED + PUSHED (recentActivity + promotionCandidates)

**Date:** 2026-06-11 (continues `2026-06-11-access-log-tier-design-edit-bind-poc.md`)
**State:** `main` @ `7fb764c`, pushed (HEAD == upstream). v0.3.0 is the published npm version; 5a/5b
are in-tree on top of it (NOT yet released/published — no new version cut). Two slices shipped this
session, both access-log-tier READ views, both isolated from recall ranking.

**HANDOFF (current):** Access-log tier is 2/3 done. **NEXT = 5c trust/stability property** — the LAST
access-log-tier slice. Per PRD §15 5c: per-chunk volatility (churn on real edit history) + a
validated/used tie-breaker AMONG already-relevant results; **bench-gated so it never becomes a global
prior**. Cold-start is NOT what 5c solves. No work started on 5c. Nothing uncommitted (working tree
clean except throwaway pocs listed below).

---

## Slice 5a SHIPPED (commit 3fa857f) — `recentActivity()` "what was I working on"
- New `chunk_edits` table (path, symbol, kind, ts) + edit-detection in `store.applyChanges`: each
  incremental `index()` diffs new chunk bodies vs stored `nodes`, logs new/modified chunks. **Cold
  first build / `force` records NOTHING** (gated on `prev.size>0`; loading isn't editing).
- `recentActivity({days=7, since?, limit=20})`: recency-windowed chunks, `{id,symbol,kind,
  lastEditedAt,edits}`. `edits` = `count(DISTINCT ts)` = index passes that changed it (the eyeball
  FORCED distinct-pass over count(*) so a file's anonymous/null-symbol chunks collapse to ONE honest
  per-file row, not an inflated count).
- ISOLATED: reads `chunk_edits`, never the ranking path; writes nothing to recall_log. Cannot regress
  search. Scoped to **code+md chunk-edit SPINE** — user caught the over-scope ("what brings episodes
  here? code+md?"), so episodes deferred to 5b.
- Window default = 7 days (user chose over unbounded — without a window all-time churn leaks in).
- Surfaces: API + `litectx recent [--since <days>] [-n]` + MCP `recent` tool.
- Eyeballed on aurora/gitdone/litectx (`poc/recent-activity-eyeball.mjs`, committed): clean
  tree-sitter symbol-grain (gitdone surfaced buildRawMessage/sanitizeHeader/layout), fixing the
  git-funcContext bluntness the throwaway build-POC surfaced. 9 tests.

## Slice 5b SHIPPED (commit 7fb764c) — `promotionCandidates()` episode promotion ladder
- `promotionCandidates(threshold=10)`: agent episodes recalled >= threshold within a **30-DAY ROLLING
  WINDOW**. Mirrors `reviewCandidates` (recall_log demand join, `{path,hits}`) + `kind='episode'` +
  `occurred_at >= since` window gate. (store.promotionCandidates({threshold, since}) / index facade
  computes since = now-30d.)
- **The ladder:** agent reads candidate (`get`) → distils a `fact` (by:agent) via `remember` →
  existing `reviewCandidates(5)` → human validates → durable. litectx FLAGS, never summarizes (no
  LLM). Count gates **DISTILLATION, never rank** (no feedback loop). Threshold 10 > facts' 5 (episodes
  noisier/more numerous).
- **Ephemerality = OPTION A** (user chose over a 90d+count-cap variant: "30 days is long enough to
  promote and prove, one knob, no count cap"): (1) episodes >30d soft-decay out of the candidate set
  (the read gate); (2) each episode `remember()` **AUTO-PRUNES** (hard-delete cascading
  text/embedding/recall_log via `store.pruneStaleEpisodes(before)`) episodes past the window —
  self-bounding, NO cron. **Pruned BEFORE the write** so an explicit/backdated episode the caller just
  authored is always honored (its own write never deletes it; only a LATER episode write would).
  Anything that mattered became a durable fact (facts never prune).
- Distilling does NOT remove the episode (no provenance to flip like facts) — it ages out / consumer
  may `forget` it; re-distilling is harmless (fact id is a stable upsert handle).
- Surfaces: API + `litectx promotions [--threshold]` + MCP `promotions` tool. (reviewCandidates stays
  API-only as before; promotions added to MCP because the AGENT is the actor on it.)

## KEY REFRAME (5b has NO falsification gate) — now in PRD §15 5b + CHANGELOG
5b touches no ranking, so there is no predictive claim to falsify. Synthesising a "this episode
deserved promotion" oracle would be the **circularity trap** the prior stash warned of. So the
"hand-scripted scenario bench" the PRD asked for is realised as a scenario **INTEGRATION TEST** that
scripts the ladder end-to-end — NOT a floored MRR bench. POC-first (`poc/promotion-ladder-poc.mjs`,
committed) proved the ladder composes through the real API before any src/ change.

## GROUNDING CAUGHT A REAL BUG (user pushed "validate and ground, no handwaving")
`poc/datasets/memory-facts.mjs` wrote its 5 episodes with HARDCODED June-2026 `occurredAt`. Today
(7 days old) they survive, so bench:memory passed — but once they age past 30 days, the new
prune-on-write would EVICT ALL-BUT-LAST on each subsequent episode write → break the 3 episode-EXACT
queries → break the EXACT>=0.8 floor. **A latent time-bomb my feature introduced.** Proved it
(5 old episodes → 1 survives; recent → 5 survive). FIXED by making the dataset `occurredAt`
RELATIVE-to-now (recall never ranks on occurredAt → MRR byte-identical). This is why
poc/datasets/memory-facts.mjs is in the 5b diff. LESSON: any episode-writing fixture/consumer is now
coupled to the 30-day prune — keep episode timestamps recent.

## VALIDATION (fully grounded this session, no handwaving)
- tsc clean; **126 tests, 125 pass / 1 inverse env-skip (the "fails-loudly-when-dep-absent" test skips
  BECAUSE @xenova/transformers IS installed here) / 0 fail**. 5b added 5 tests
  (`test/promotion.test.js`): gate + 3 exclusions (below-threshold / human-provenance / decayed),
  10-vs-5 threshold asymmetry, self-prune cascade, full ladder composes, ranking isolation.
- **MUTATION-CHECKED load-bearing:** drop `occurred_at` gate → test 1 red (only); prune no-op → test
  3 red (only); revert → 5/5 green + store.js byte-identical.
- **All 4 bench gates RAN and PASS byte-identical to baseline:** recall aurora 0.552 (floor 0.550) /
  gitdone 0.425 (0.420); impact 100% caller-recall, 0 safety/iso failures; memory BM25
  1.000/0.722/0.000; memory **embeddings** 1.000/0.889/0.574 (ran the model, dep present).
- Live CLI + MCP smoke for both `recent` and `promotions` (threshold default/override, hot-episode
  flagging) — passed.

## Files (this session)
- src: `src/store.js` (chunk_edits schema + edit-detection; recentActivity; promotionCandidates;
  pruneStaleEpisodes), `src/index.js` (consts ACTIVE_EPISODE_DAYS=30/EPISODE_PROMOTE_THRESHOLD=10/
  DAY_MS; recentActivity + promotionCandidates facades; prune-before-write hook in remember()).
- bins: `bin/litectx.js` (recent + promotions cmds, --since/--threshold), `bin/litectx-mcp.js`
  (recent + promotions tools; now 8 tools).
- tests: `test/recent.test.js` (NEW, 9), `test/promotion.test.js` (NEW, 5), `test/mcp.test.js`
  (tools-list assertion → 8).
- docs: README, CHANGELOG ([Unreleased] 5a+5b), PRD §15/§14, litectx.context.md — all current-state
  consistent at 8 surfaces. (PRD slice-10 historical block still says "six tools" — correct as
  history, left as-is.)
- committed pocs (referenced by docs = standing artifacts): `poc/recent-activity-eyeball.mjs`,
  `poc/promotion-ladder-poc.mjs`. Plus prior-session `poc/access-bench.mjs`, `poc/edit-bind-poc.mjs`.

## Throwaway pocs still UNTRACKED (left out, true throwaway — same practice as before)
`poc/recent-activity-poc.mjs` (superseded by the eyeball) and `poc/edit-pollution-poc.mjs` were
deleted last commit cycle. Check `git status` — should be clean now.

## Standing notes
- **Push ruleset advisory:** both 5a (3fa857f) and 5b (7fb764c) pushes printed remote "Changes must be
  made through a pull request" but the ref UPDATED anyway → branch ruleset is in evaluate/advisory
  mode, NOT enforcing. Flagged to user; they may want to make it actually block (or not).
- Memory ledger updated: `slice7-write-path.md` tail carries 5a + 5b shipped detail + next=5c.
- Calibration available if 5c needs it (aurora ledger): churn coeff 0.1·log10(commits+1); decay
  factor 0.5 / cap 90d / floor −2.0 / grace 1h; type rates code 0.40 / class 0.20 / md 0.05.

## Access-log tier scoreboard
- 5a recentActivity — ✅ SHIPPED (3fa857f)
- 5b promotionCandidates + episode ephemerality — ✅ SHIPPED (7fb764c)
- 5c trust/stability tie-breaker — **NEXT, not started** (bench-gated; per-chunk churn + validated/used
  tie-breaker among already-relevant; never a global prior).
- Edit→recall RE-RANKING — ⊘ DROPPED permanently (POC repo-dependent; reopen only via
  `poc/access-bench.mjs` if a fundamentally different non-topic-blind conditioning appears).
