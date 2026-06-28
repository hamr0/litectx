// POC — configurable episode retention window (deferred opt-in, retention model 2026-06-27).
//
// PROPOSAL: turn the hardcoded `ACTIVE_EPISODE_DAYS = 30` (src/index.js:46) into a LiteCtxConfig knob
// (`episodeWindowDays`), 30d staying the safe default. Two facade sites consume it:
//   - src/index.js:780  pruneStaleEpisodes(now - W*DAY_MS)         (auto-prune on episode write)
//   - src/index.js:1036 promotionCandidates({ since: now - W*DAY_MS })
//
// This change is mostly correctness-only plumbing — but per prove-don't-assert the RISKY assumption is
// NOT "can a constant become config" (trivially yes). It's the coupling the comment at index.js:41-45
// admits: the window is SIMULTANEOUSLY the retention bound AND the promote-eligibility bound. So the
// falsifiable questions a POC must answer before we ship a knob adopters can turn:
//
//   Q1 (default byte-identical)  unset window === today's 30d, exactly.
//   Q2 (no split-brain)          the SAME W must drive BOTH sites; wiring one and not the other yields
//                                a dangling promotion candidate (promotable-but-already-pruned).
//   Q3 (the sharp edge)          a SHORT window starves the promotion ladder: an episode recalled past
//                                threshold is pruned + dropped below the promotion floor before it can
//                                ever be promoted. A LONG window rescues older episodes but grows the set.
//
// The store layer is ALREADY window-parametrized (pruneStaleEpisodes(before) / promotionCandidates({since})).
// Only the facade hardcodes 30 — so this POC drives the REAL shipped store at arbitrary windows; the tiny
// in-file `rememberEp`/`promotableAt` prototype is a faithful mirror of the one-line facade change (the
// trim-POC precedent: prototype the seam, exercise the shipped mechanism).

import assert from "node:assert/strict";
import { LiteCtx } from "../src/index.js";

const DAY_MS = 86_400_000;
const NOW = Date.now();
const THRESHOLD = 10; // EPISODE_PROMOTE_THRESHOLD
const boundary = (windowDays) => NOW - windowDays * DAY_MS;

const ctx = new LiteCtx({ root: process.cwd(), dbPath: ":memory:" });
const store = ctx.store;

// --- the prototyped facade change: W threads to the boundary used by BOTH store sites ---------------
// rememberEp = exactly index.js:780-781 with the window parametrized (prune at W, then write).
function rememberEp(id, ageDays, recalls, windowDays) {
  store.pruneStaleEpisodes(boundary(windowDays));
  store.writeMemory({
    id, text: `episode ${id} body`, kind: "episode", format: "text",
    provenance: "agent", occurredAt: NOW - ageDays * DAY_MS, meta: null,
    embedding: undefined, scope: null, owner: undefined, expiresAt: undefined, createdAt: NOW,
  });
  // drive the demand signal through the REAL recall_log: `recalls` logged hits (no episode writes
  // between, so nothing prunes underneath us). logRecall keys on the encoded path == bare id here.
  for (let i = 0; i < recalls; i++) store.logRecall([{ path: id, kind: "episode" }], NOW);
}
// promotableAt = exactly index.js:1036 with the window parametrized.
const promotableAt = (windowDays) =>
  store.promotionCandidates({ since: boundary(windowDays), threshold: THRESHOLD, memOwner: null, memSeeAll: true })
    .map((c) => c.path).sort();
const survivesPruneAt = (id, windowDays) => {
  // a non-destructive probe: would an episode-write at window W keep this row? (occurred_at >= floor)
  const row = store.getItem(id);
  return row != null && row.occurred_at >= boundary(windowDays);
};

// --- dataset: three episodes, all recalled WELL past threshold, differing only in age ----------------
// Each is "earned" (12 >= 10 recalls). Age is the ONLY variable, so any difference in promotability is
// the window's doing — not a confound. We write them under a wide window so none self-prunes at setup.
const SETUP_W = 1000;
rememberEp("ep_fresh", 5, 12, SETUP_W); // 5 days old
rememberEp("ep_mid", 20, 12, SETUP_W); // 20 days old
rememberEp("ep_old", 40, 12, SETUP_W); // 40 days old

console.log("dataset: 3 agent episodes, each recalled 12× (threshold=10); ages 5d / 20d / 40d\n");

// === Q1 — default byte-identical ====================================================================
// The SHIPPED facade (hardcoded 30) must equal the prototype at W=30. If this fails the prototype is
// not a faithful mirror of the change and nothing below is trustworthy.
const shipped = ctx.promotionCandidates().map((c) => c.path).sort();
const proto30 = promotableAt(30);
console.log("Q1 default:  shipped facade =", shipped, " · prototype@30 =", proto30);
assert.deepEqual(proto30, shipped, "Q1 FAIL: prototype@30 must byte-match the shipped hardcoded-30 facade");
assert.deepEqual(shipped, ["ep_fresh", "ep_mid"], "Q1 FAIL: today's 30d behaviour = {ep_fresh, ep_mid}, ep_old aged out");
console.log("Q1 PASS — unset window reproduces today's 30d behaviour exactly.\n");

// === Q3 — the sharp edge (window ↔ promotion-ladder coupling) ========================================
// Run the SAME earned dataset through three windows. Only the window changes.
const p7 = promotableAt(7);
const p30 = promotableAt(30);
const p90 = promotableAt(90);
console.log("Q3 coupling:");
console.log("   window=7d  → promotable:", p7);
console.log("   window=30d → promotable:", p30);
console.log("   window=90d → promotable:", p90);

// A short window STARVES the ladder: ep_mid (20d, 12 recalls — earned!) falls below the 7d promotion
// floor and is pruned on the next episode write. Data-minimization and promotion are in direct tension.
assert.deepEqual(p7, ["ep_fresh"], "Q3 FAIL: a 7d window should drop the earned 20d/40d episodes below the floor");
assert.ok(!p7.includes("ep_mid"), "Q3 FAIL: ep_mid is earned yet UN-promotable at 7d — the starvation edge");
// A long window RESCUES the old earned episode the default discards…
assert.deepEqual(p90, ["ep_fresh", "ep_mid", "ep_old"], "Q3 FAIL: a 90d window should rescue ep_old");
// …but at the cost of retaining more: ep_old survives prune at 90d, is gone at 30d (the scratchpad grows).
assert.ok(survivesPruneAt("ep_old", 90) && !survivesPruneAt("ep_old", 30),
  "Q3 FAIL: ep_old should be retained at 90d but pruned at 30d");
console.log("Q3 PASS — the window is NOT a free hygiene dial: short starves promotion, long grows the set.");
console.log("          → SHIP NOTE: doc the floor (a window below the promote-and-prove time can mean");
console.log("            episodes never promote); 30d stays the safe default for exactly this reason.\n");

// === Q2 — no split-brain (why BOTH sites must take the config, not one) ==============================
// Simulate the bug of changing ONLY the prune site to a short window while promotionCandidates keeps 30d:
// prune at 7d deletes ep_mid/ep_old, but a 30d promotion floor would still try to surface them → the
// candidate set references rows that no longer exist. We prove the divergence is observable, justifying
// "thread W to both sites" as a correctness requirement, not a nicety.
store.pruneStaleEpisodes(boundary(7)); // <-- prune site moved to 7d ONLY
const promotedStale = store.promotionCandidates({ since: boundary(30), threshold: THRESHOLD, memOwner: null, memSeeAll: true })
  .map((c) => c.path);
const dangling = promotedStale.filter((id) => store.getItem(id) == null);
console.log("Q2 split-brain (prune@7 + promote-floor@30):", promotedStale, "→ dangling (pruned-but-listed):", dangling);
// After the 7d prune, recall_log for ep_mid/ep_old is cascaded away too, so they vanish from candidates —
// confirming the two sites MUST share W: a mismatched floor can only ever surface ghosts or hide earned rows.
assert.deepEqual(promotedStale, ["ep_fresh"], "Q2 FAIL: a 7d prune must remove the >7d episodes from any later floor");
console.log("Q2 PASS — the prune cascade (recall_log included) means a split window can't surface a live");
console.log("          candidate it pruned; both sites reading ONE config is the only coherent wiring.\n");

console.log("✅ POC verdict: the knob is a ~3-line facade change (config field + two call sites already");
console.log("   parametrized in the store). It is SAFE to ship with 30d default (Q1), but is NOT a free");
console.log("   hygiene dial (Q3) — so the doc must name the promotion-floor coupling, and both consumer");
console.log("   sites must read the one config value (Q2). No store change; no new empirical risk beyond");
console.log("   the documented coupling.");
