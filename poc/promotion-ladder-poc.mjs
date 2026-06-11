// THROWAWAY POC — slice 5b "episode promotion ladder".
//
// Goal: prove the promotion ladder COMPOSES through the real public API *before* adding any
// src/ method. The ladder is:
//   agent episode → (recalled enough, still fresh) → promotionCandidate → distil to fact →
//   (recalled enough) → reviewCandidate → human promotes → falls out of the candidate set.
//
// What's actually being validated here that the existing src can't yet do:
//   1. The promotionCandidates query — the NEW logic — mirrors reviewCandidates but over
//      kind='episode', provenance='agent', with a 30-day soft-decay floor on occurred_at.
//      Run INLINE here (no src change) to confirm the query selects exactly the hot, fresh,
//      agent episode and excludes warm / stale / human.
//   2. The downstream rungs use only SHIPPED public API (remember + the real reviewCandidates),
//      proving the new rung hands off cleanly into what already exists, and that "acting on a
//      candidate removes it from the set" holds (human re-remember flips provenance off 'agent').
//
// Run: node poc/promotion-ladder-poc.mjs

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const DAY = 86_400_000;
const now = Date.now();

// ── stage tracking, for the final summary table ───────────────────────────────────────────
/** @type {Record<string, string[]>} */
const surfaced = {};
let pass = 0;
let fail = 0;
/** @param {string} label @param {boolean} ok @param {string} [detail] */
function check(label, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}${detail ? `  — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ""}`);
  }
}

// ── 1. in-memory LiteCtx ──────────────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "litectx-promo-poc-"));
const ctx = new LiteCtx({ root, dbPath: ":memory:" });

// ── 2. write 4 agent (and one human) episodes ─────────────────────────────────────────────
await ctx.remember("ep:hot", "deployed the auth rollout to prod and it held", {
  kind: "episode",
  by: "agent",
  occurredAt: now,
});
await ctx.remember("ep:warm", "rotated the staging api key once", {
  kind: "episode",
  by: "agent",
  occurredAt: now,
});
await ctx.remember("ep:stale-hot", "the great migration of last month, much recalled", {
  kind: "episode",
  by: "agent",
  occurredAt: now - 31 * DAY, // soft-decayed: older than the 30-day floor
});
await ctx.remember("ep:human", "human-noted the incident retro", {
  kind: "episode",
  by: "human", // NOT an agent episode
  occurredAt: now,
});

// ── 3. inject recall demand directly into the audit log ───────────────────────────────────
/** @param {string} path @param {number} n */
function recallTimes(path, n) {
  for (let i = 0; i < n; i++) {
    ctx.store.logRecall([{ path, kind: "episode" }], now, "recall");
  }
}
recallTimes("ep:hot", 12); // above threshold 10
recallTimes("ep:warm", 3); // below threshold 10
recallTimes("ep:stale-hot", 12); // above threshold but soft-decayed
recallTimes("ep:human", 12); // above threshold but wrong provenance

// ── 4. INLINE promotionCandidates query (the logic being validated) ───────────────────────
// Mirrors store.reviewCandidates exactly, with three deltas:
//   m.kind='episode' (not 'fact'), and an added soft-decay floor on m.occurred_at.
const cutoff = now - 30 * DAY;
const promotionCandidates = ctx.store.db
  .prepare(
    "SELECT m.path AS path, count(r.id) AS hits FROM mem m JOIN recall_log r ON r.path = m.path " +
      "WHERE m.kind = 'episode' AND m.provenance = 'agent' AND r.action = 'recall' " +
      "AND m.occurred_at >= ? " +
      "GROUP BY m.path HAVING hits >= 10 ORDER BY hits DESC, m.path"
  )
  .all(cutoff);

const promotedPaths = promotionCandidates.map((c) => c.path);
surfaced["promotionCandidates(threshold=10, decay=30d)"] = promotedPaths;

console.log("\n-- stage 1: promotionCandidates --");
console.log(JSON.stringify(promotionCandidates));

check("exactly one promotion candidate", promotionCandidates.length === 1, `got ${promotionCandidates.length}: [${promotedPaths.join(", ")}]`);
check("ep:hot IS a candidate (hot + fresh + agent)", promotedPaths.includes("ep:hot"));
check("ep:warm EXCLUDED (3 hits < threshold 10)", !promotedPaths.includes("ep:warm"));
check("ep:stale-hot EXCLUDED (occurred 31d ago > 30d decay floor)", !promotedPaths.includes("ep:stale-hot"));
check("ep:human EXCLUDED (provenance=human, not agent)", !promotedPaths.includes("ep:human"));

// Hard equality assertion — the exact-set claim the design rests on.
try {
  assert.deepEqual(promotedPaths, ["ep:hot"]);
  check("ASSERT promotedPaths deepEqual ['ep:hot']", true);
} catch (e) {
  check("ASSERT promotedPaths deepEqual ['ep:hot']", false, `expected ['ep:hot'], actual ${JSON.stringify(promotedPaths)}`);
}

// ── 5. exercise the rest of the ladder via SHIPPED public API ─────────────────────────────
console.log("\n-- stage 2: distil to fact, then real reviewCandidates --");

// distil the hot episode into an agent fact
await ctx.remember("fact:distilled", "auth rollout is safe to deploy to prod", {
  kind: "fact",
  by: "agent",
});

// the distilled fact earns its own recall demand (6 > review threshold 5)
for (let i = 0; i < 6; i++) {
  ctx.store.logRecall([{ path: "fact:distilled", kind: "fact" }], now, "recall");
}

const reviewBefore = ctx.reviewCandidates(5);
const reviewBeforePaths = reviewBefore.map((c) => c.path);
surfaced["reviewCandidates(5) — fact is agent"] = reviewBeforePaths;
console.log("reviewCandidates(5) after distil:", JSON.stringify(reviewBefore));

check("fact:distilled appears in reviewCandidates (agent fact past 5)", reviewBeforePaths.includes("fact:distilled"));
try {
  assert.ok(reviewBefore.some((c) => c.path === "fact:distilled" && c.hits >= 5));
  check("ASSERT fact:distilled present with hits>=5", true);
} catch {
  check("ASSERT fact:distilled present with hits>=5", false, `actual ${JSON.stringify(reviewBefore)}`);
}

// ── human promotion: re-remember the same id as human → provenance flips off 'agent' ──────
console.log("\n-- stage 3: human promotes → candidate falls out of the set --");
await ctx.remember("fact:distilled", "auth rollout is safe to deploy to prod", {
  kind: "fact",
  by: "human",
});

const reviewAfter = ctx.reviewCandidates(5);
const reviewAfterPaths = reviewAfter.map((c) => c.path);
surfaced["reviewCandidates(5) — after human promote"] = reviewAfterPaths;
console.log("reviewCandidates(5) after human promote:", JSON.stringify(reviewAfter));

check("fact:distilled GONE from reviewCandidates (provenance flipped to human)", !reviewAfterPaths.includes("fact:distilled"));
try {
  assert.ok(!reviewAfter.some((c) => c.path === "fact:distilled"));
  check("ASSERT fact:distilled absent after promotion", true);
} catch {
  check("ASSERT fact:distilled absent after promotion", false, `actual ${JSON.stringify(reviewAfter)}`);
}

// sanity: confirm the row really is human now (the upsert replaced provenance, not duplicated)
const item = ctx.get("fact:distilled", { log: false });
check("get('fact:distilled').provenance === 'human'", item?.provenance === "human", `provenance=${item?.provenance}`);

// ── 6. final summary table ────────────────────────────────────────────────────────────────
console.log("\n-- ladder surface, per stage --");
const rows = Object.entries(surfaced).map(([stage, paths]) => ({
  stage,
  surfaced: paths.length ? paths.join(", ") : "(none)",
}));
for (const r of rows) {
  console.log(`  ${r.stage.padEnd(44)} → ${r.surfaced}`);
}

ctx.close();

console.log(`\n==== ${fail === 0 ? "ALL PASS" : "FAILURES PRESENT"} — ${pass} passed, ${fail} failed ====`);
process.exit(fail === 0 ? 0 : 1);
