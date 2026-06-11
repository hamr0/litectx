# Stash: v0.3.0 published + access-log tier DESIGN SETTLED + edit-bind POC passed

**Date:** 2026-06-11 (continues `2026-06-11-slice11-knn-union-paraphrase-recall.md`)
**State:** `main` @ `69ddc46`, pushed. **v0.3.0 PUBLISHED to npm** (tag `v0.3.0`, OIDC workflow
green run 27329636639, `npm view litectx version` → 0.3.0, `latest`). "The paraphrase release"
(slice 11).

**HANDOFF (current):** Access-log tier **DESIGN FULLY SETTLED with user + written to PRD** (§14 #4
"the access-log tier" block, §15 5a/5b/5c, with stale forward-refs reconciled in §3.3/§4/§11.2/§14
item 6). Three POCs run + the naive integration FALSIFIED (edit→recall ships at zero). **No `src/`
change yet — nothing built.** **IMMEDIATE NEXT: build 5a "what was I working on" view**, starting
with a quick POC to pin what `recentActivity()` returns — awaiting user's go (last msg offered it).
POC files uncommitted/throwaway: `poc/edit-bind-poc.mjs`, `poc/edit-pollution-poc.mjs`,
`poc/access-bench.mjs`.

---

## v0.3.0 cut + published (this session)
- Slice 11 (KNN union) re-validated at HEAD before cut — grounding pass #2: 113 tests (112 pass /
  1 env-skip), tsc clean, 3 code gates byte-identical to v0.2.0, `--embeddings` bench reproduces
  1.000/0.889/0.574 + gate mutation-checked (para floor 0.99 → exit 1), live public-API probe
  ("money back guarantee period" → fact:refund-policy first tier-on / 0 hits tier-off).
- Docs cut: CHANGELOG `[0.3.0]`, README/PRD §15 status → v0.3.0, package.json/lock 0.3.0. Commit
  `69ddc46`, tag `v0.3.0`. npm publish via manual OIDC `gh workflow run publish.yml --ref v0.3.0`.

## Access-log tier — ORACLE CHOSEN + POC PASSED (2026-06-11)

**The bench's hard problem:** unlike recall/impact (static oracle baked in code), the action-signal
bench's claim is "scoring real usage history improves ranking" — but litectx has no usage history yet
(that's why the tier was deferred). Danger = circularity (synthesize log as "relevant→accessed more"
→ bench rubber-stamps anything = rich-get-richer in bench form).

**ORACLE = git-replay next-edit (chosen w/ user over synthetic-task-cluster / real-captured-traces).**
Replay a repo's commit history as the real temporal edit stream; non-circular (edit stream AND
prediction target both from git, independent of any relevance label). Honest INVERSION of the
falsified git-SEEDING (§4.1): not seeding cold-start ranking, but testing whether past edits predict
future use — which is the literal base-level-activation claim.

**POC RESULT (`poc/edit-bind-poc.mjs`, file-grain, AUC = P[edited-next file outscores not-edited],
0.5=chance):**
```
              aurora(Py)  gitdone(JS)
freq          0.7502      0.9111      (raw count, no decay — the naive prior)
recency       0.8391      0.9756      (age_last^-0.5 — the "half formula")
bla (full)    0.8563      0.9717      (ln(Σ age^-0.5) — aurora base_level.py)
```
- **Signal is real + strong** on both repos (AUC 0.75–0.98 >> 0.5). Edit-bind anchor earns weight.
- **Decay matters** (recency >> freq: +0.09 aurora / +0.065 gitdone) — VINDICATES the ledger thesis
  that the original "BLA doesn't generalize" came from a crude half-formula (recency-only, no churn,
  no type-decay), not the idea. Use the FULL formula.
- **Full BLA ≥ baselines** (beats recency on aurora AUC + recall@10 both repos; gitdone AUC −0.004 =
  noise). Combining freq+recency the ACT-R way is justified.
- Non-circular by construction; cheap; reuses existing corpora.

## SETTLED DESIGN (discussion w/ user, "keep it simple" — 2026-06-11)

**Through-line principle:** lean on mechanisms that already exist or fall out of ACTIONS; REFUSE new
hand-tuned weights; route every "should this count?" through the bench so nothing becomes a forgotten
special-case rule. (= PRD §14 #4 safety stance + user's simple-over-clever instinct.)

1. **Bench gate = "does edit-activation lift the KNOWN-RELEVANT chunk's rank?"** — chunk-grain,
   hold-or-beat. This MERGES open-q #3+#4: next-edit-prediction (the POC) is only a PROXY for the
   real goal (query-relevance ranking); the gate instead uses labeled `{query → target chunk}` (like
   the recall bench), replays edits up to that point, and measures whether the target's rank LIFTS.
   That closes the proxy gap. Chunk-grain (file-grain "too blunt", PRD) — needs old-vs-new chunk-text
   diff per commit (old text already in `nodes`); POC was file-grain so the build re-validates finer.
2. **Facts:** corrective re-`remember` (an ACTION) moves rank. Impressions KEEP their existing job =
   **review-gating** (`reviewCandidates` threshold 5 → HITL → human validate → durable), NOT ranking.
   NO special impression weight for facts (that's the rich-get-richer reach AND the "small rule
   likely forgotten" the user flagged). "Durable" = TRUST axis (provenance, doesn't decay), separate
   from activation — already covered by the promotion path.
3. **Episodes:** same as facts, PLUS a "hot agent-episode (recalled > ~10) → HITL" trigger — but the
   ACTION is **distill into a fact**, not "make episode durable" (an episode is a time-stamped event,
   not an assertion to bless). Threshold asymmetry (facts 5 / episodes 10) justified — episodes
   noisier/more numerous.
4. **Impressions-as-RANKING (code + facts):** bounded + decaying + default ZERO + bench-gated. Quick
   POC: does an impression term ON TOP of the edit signal help next-edit/relevance or just add noise
   to code? Honest bet: ships at zero (circularity) — a fine outcome, the bench decides.

**Activation re-ranks, NEVER gates** (a zero-match item stays invisible). Calibration from aurora
ledger: BLA d=0.5, default/floor −5/−10; decay factor 0.5 / cap 90d / floor −2.0 / grace 1h; type
rates code 0.40 / class 0.20 / doc-md 0.05 / fact 0.02 / episode 0.40; churn 0.1·log10(commits+1).

## DECISIVE FINDING — flat edit-weight is REPO-DEPENDENT → ships at ZERO (2026-06-11)

**litectx self-test (user ask) + production `poc/access-bench.mjs` across all 3 repos.** Folding
edit-activation into recall as a FLAT global re-rank weight (sweep w), MRR vs baseline:
```
aurora   0.543 → 0.667  LIFTS    (hot files happen to be the relevant ones)
gitdone  0.411 → ~0.40  neutral
litectx  0.707 → 0.461  POLLUTES (adversarial: stable targets, freshly-edited slice-11 files leapfrog)
```
**Repo-dependent = the §4.1 git-seeding falsification, now reproduced on REAL edits.** Base-level
activation is **topic-blind** — it floats the same hot chunks for every query, so it helps only when a
repo's hot files coincide with its relevant ones. A repo-dependent prior is the one thing recall must
not ship. (Note: litectx labels were deliberately adversarial — stable targets queried right after
editing unrelated files = the real active-agent scenario; aurora/gitdone used neutral committed
labels.) **Reconciles with the next-edit POC, doesn't contradict it:** the signal predicts EDITS
universally but predicts query-RELEVANCE only repo-dependently — "what's edited next" ≠ "what answers
this query."

**Query-conditioned form ALSO tested** (`recall + w·norm(recall)·norm(bla)` — activation amplifies
only already-relevant hits): REDUCES but does NOT remove pollution (aurora lifts 0.543→0.624; gitdone
+litectx still net-negative). "hot==relevant" is itself the repo-dependent premise → no simple weighted
form passes.

**SETTLED (firm):** the edit→recall RE-RANKING term ships at ZERO — both flat and conditioned forms
fail the every-corpus rule. The edit signal's value is **next-use prediction** (robust, universal) and
the **non-topic-blind fact/episode action signals**, NOT recall re-ranking of code. PRD updated:
§14 #4 POC-VALIDATED block (both forms), §11.3 action-signal row, §15 item 5. `poc/access-bench.mjs` =
standing gate (reopen only if a fundamentally different conditioning passes on all 3).

## SETTLED four-part design (2026-06-11, full detail now in PRD §14 #4 "the access-log tier" block +
§15 item 5). Governing line: **use → trust/stability/a-separate-view, NEVER a global rank boost.**
1. **Search untouched** (BM25+stemming+KNN). No activation in ranking. Only ranking touch = bounded
   tie-breaker among already-relevant; episodes may recency-sort WITHIN their kind only.
2. **Trust/stability property** (use + low chunk-edit + human-validation). recall-count → review/
   promotion, NOT rank. Code volatility = per-chunk churn on real edits; facts/episodes whole-row.
   recall-count is the honest indicator (matched+in-context = the event; "was it used" = harness's job).
3. **"What was I working on" view** — separate isolated query over recent episodes + chunk-edits;
   uses recency/edits freely, zero pollution (never touches recall). Home of the next-use signal.
4. **Episode life-cycle** (agent scratchpad → graduates by USE, changing kind+trust not rank):
   `promotionCandidates(10)` NEW (mirrors reviewCandidates) flags hot agent-episodes → consumer's
   agent distils a fact (litectx FLAGS, never summarizes — no LLM) → existing `reviewCandidates(5)` →
   human validates → durable. Episodes soft-decay at 30 days (drop from active set), hard-GC later.
   Per-episode (no chunks). Chunk-edit detection KEPT (nodes diff old-vs-new) but feeds (2)+(3), NOT
   recall. Facts/episodes "edit" = corrective re-`remember` (whole row, explicit API action).

## BUILD ORDER (PRD §15 5a/5b/5c)
- **5a — "what was I working on" view (NEXT, recommended):** new read op (API + CLI + MCP) over recent
  episodes + chunk-edits; isolated from recall (cannot regress search); highest value, zero pollution.
- **5b — episode promotion ladder:** `promotionCandidates(threshold)` + 30-day decay/GC; reuses
  reviewCandidates template. Needs hand-scripted fact/episode action-signal scenario bench (no git oracle).
- **5c — trust/stability property:** per-chunk volatility + validated/used tie-breaker (bench-gated).
- Edit→recall re-ranking: DROPPED permanently (ships at zero). Reopen only via `poc/access-bench.mjs`
  if a fundamentally different (non-topic-blind, e.g. query-specific access history) conditioning appears.

NOTE on bench artifact: access-bench baseline MRR (w=0) reads slightly under the recall floors
(aurora 0.543 vs 0.55, gitdone 0.411 vs 0.42) — an n=10/findIndex methodology diff vs bench-lib, NOT a
recall regression. The FINDING is the SHAPE (repo-dependent lift/pollution), not the baseline-vs-floor.

## POC files (uncommitted, throwaway): `poc/edit-bind-poc.mjs`, `poc/edit-pollution-poc.mjs`,
`poc/access-bench.mjs`. No `src/` change — nothing shipped; the finding gates the build.

## Open / to-confirm
- Does ANY query-conditioned form lift aurora without polluting litectx/gitdone? (POC #1 decides.)
- Impression term: still bench-gated default-zero (untested; lower priority than the conditioned form).
- Episode→fact distillation HITL: action verb confirmed (distil, not bless) — build with the tier.
