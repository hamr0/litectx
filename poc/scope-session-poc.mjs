// THROWAWAY POC — §4.5 gate #1: is `session` load-bearing for episode recall?
//
// The Isolate scope model (bare-suite-buildable-now.md §4.4) wants a `session` column to
// isolate volatile `episode`/`stash` between concurrent runs. But litectx recall is
// RELEVANCE-RANKED (BM25 + ACT-R activation + optional embeddings) — so off-session
// episodes might simply SINK on their own, making the column bloat. This POC tests that.
//
// Method (the column does not exist yet, so simulate it): tag every episode with
// meta:{session}, store ALL sessions in one db, recall a query issued "in" one session,
// and compare the top-K the agent would act on:
//   - UNFILTERED  (all sessions present — today's behaviour)
//   - SESSION      (filtered to the home session — what the column would give)
// If the two top-Ks match → relevance already isolates → the column is BLOAT.
// If foreign-session episodes INTRUDE and DISPLACE own-session ones → LOAD-BEARING.
//
// Riskiest case (aimed at, per prove-don't-assert): CONCURRENT sessions on the SAME topic
// ("two reviewers of one checkout") — relevance cannot separate them; only a session key can.
// We also test DISTINCT-topic sessions (the easy case) to show the contrast.
//
// Run: node poc/scope-session-poc.mjs   (embeddings ON — the realistic memory config)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const MIN = 60_000;
const NOW = Date.now(); // episodes are from the *current* concurrent runs — minutes old, not years
const TOPK = 5;

// ── episode corpus ────────────────────────────────────────────────────────────────────────
// Each entry: [session, text]. occurredAt is assigned INTERLEAVED across sessions below, so
// recency cannot stand in for session (the concurrent-run reality).
//
// Regime DISTINCT: sessions da/db/dc work on unrelated areas.
// Regime OVERLAP:  sessions oa/ob BOTH work the same auth-refactor task, similar wording.
const EPISODES = [
  // -- DISTINCT: da = auth, db = billing, dc = search --
  ["da", "started the auth rollout; flipped the login feature flag on for 10% of users"],
  ["da", "found a null-pointer in the session-token refresh and added a guard"],
  ["da", "auth rollout held overnight; bumped the flag to 50%"],
  ["da", "wrote a regression test for the expired-token refresh path"],
  ["db", "reconciled the monthly billing run; three invoices were double-charged"],
  ["db", "patched the proration math for mid-cycle plan upgrades"],
  ["db", "added a billing webhook retry with exponential backoff"],
  ["dc", "reindexed the search corpus after the schema change"],
  ["dc", "tuned BM25 k1/b on the search relevance benchmark"],
  ["dc", "fixed a crash when the search query was empty"],

  // -- OVERLAP: oa and ob are two agents on the SAME auth-refactor checkout, same topic --
  ["oa", "refactoring the auth middleware to pull the user from the JWT claims"],
  ["oa", "moved token validation into a shared verifyToken() helper"],
  ["oa", "the auth middleware now rejects expired tokens with a 401"],
  ["oa", "added a test: middleware passes the decoded claims downstream"],
  ["ob", "refactoring auth middleware so the JWT claims populate the request user"],
  ["ob", "extracted token checks into a reusable verifyToken function"],
  ["ob", "middleware returns 401 on an expired auth token now"],
  ["ob", "covered the claims-passthrough behaviour of the middleware with a test"],
];

// queries: [homeSession, queryText, regimeLabel]
const QUERIES = [
  ["da", "how far did we get on the auth rollout flag", "DISTINCT"],
  ["da", "what did we do about the token refresh bug", "DISTINCT"],
  ["db", "the double-charged invoice fix", "DISTINCT"],
  ["dc", "search relevance tuning work", "DISTINCT"],
  ["oa", "how does the auth middleware get the user from the token", "OVERLAP"],
  ["oa", "where did token validation move", "OVERLAP"],
  ["ob", "what happens on an expired token in the middleware", "OVERLAP"],
  ["ob", "the claims passthrough test", "OVERLAP"],
];

async function run(embeddings) {
  const root = mkdtempSync(join(tmpdir(), "litectx-scope-poc-"));
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings });
  try {
    // interleave occurredAt across sessions: episode i happened i*2min ago (newest = last index),
    // all within the last ~40min — the concurrent-runs reality, so recency can't stand in for session.
    for (let i = 0; i < EPISODES.length; i++) {
      const [session, text] = EPISODES[i];
      await ctx.remember(`ep:${i}`, text, {
        kind: "episode",
        by: "agent",
        occurredAt: NOW - (EPISODES.length - i) * 2 * MIN,
        meta: { session },
      });
    }

    let bloatCount = 0; // queries where UNFILTERED top-K == SESSION top-K (column changes nothing)
    let intrusionTotal = 0; // foreign-session hits appearing in unfiltered top-K, summed
    let displaceCount = 0; // queries where a foreign hit pushed an own-session episode out of top-K
    const perRegime = { DISTINCT: { n: 0, bloat: 0, intrusion: 0 }, OVERLAP: { n: 0, bloat: 0, intrusion: 0 } };

    console.log(`\n========== embeddings: ${embeddings ? "ON" : "OFF (BM25-only)"} ==========`);
    for (const [home, q, regime] of QUERIES) {
      const hits = await ctx.recall(q, { kind: "episode", n: TOPK });
      const sessions = hits.map((h) => h.meta?.session ?? "?");
      const topUnfiltered = sessions.slice(0, TOPK);
      const ownInTop = topUnfiltered.filter((s) => s === home).length;
      const foreignInTop = topUnfiltered.filter((s) => s !== home).length;

      // SESSION-filtered top-K = the same ranked list, keep only home-session hits, take K
      const sessionFiltered = sessions.filter((s) => s === home).slice(0, TOPK);
      // total own-session episodes that exist (the ceiling the agent could see)
      const ownTotal = EPISODES.filter(([s]) => s === home).length;

      // "answer changes" if the agent's own-session view differs: did foreign hits occupy slots
      // that own-session episodes would otherwise fill?
      const ownAvailableButCrowdedOut = Math.min(ownTotal, TOPK) - ownInTop;
      const changed = foreignInTop > 0 && ownAvailableButCrowdedOut > 0;

      if (foreignInTop === 0) bloatCount++;
      if (changed) displaceCount++;
      intrusionTotal += foreignInTop;
      perRegime[regime].n++;
      if (foreignInTop === 0) perRegime[regime].bloat++;
      perRegime[regime].intrusion += foreignInTop;

      console.log(
        `[${regime}] home=${home}  "${q}"\n` +
          `   top-${TOPK} sessions: [${topUnfiltered.join(", ")}]  own=${ownInTop} foreign=${foreignInTop}` +
          `  ${changed ? "← FOREIGN DISPLACED OWN" : foreignInTop ? "(foreign present, no own crowded out)" : "(clean — own only)"}`,
      );
    }

    const n = QUERIES.length;
    console.log(`\n  -- aggregate (embeddings ${embeddings ? "ON" : "OFF"}) --`);
    console.log(`  queries where column changes NOTHING (no foreign in top-${TOPK}): ${bloatCount}/${n}`);
    console.log(`  queries where foreign episode DISPLACED an own-session one:        ${displaceCount}/${n}`);
    console.log(`  total foreign intrusions across all top-${TOPK}s:                  ${intrusionTotal}`);
    for (const [r, v] of Object.entries(perRegime)) {
      console.log(`    ${r}: ${v.bloat}/${v.n} clean, ${v.intrusion} foreign intrusions`);
    }
    return { embeddings, bloatCount, displaceCount, intrusionTotal, perRegime, n };
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const off = await run(false);
const on = await run(true);

console.log(`\n================= VERDICT =================`);
for (const r of [off, on]) {
  const tag = r.embeddings ? "embeddings ON " : "embeddings OFF";
  const od = r.perRegime.OVERLAP;
  console.log(
    `${tag}: DISTINCT ${r.perRegime.DISTINCT.bloat}/${r.perRegime.DISTINCT.n} clean · ` +
      `OVERLAP ${od.bloat}/${od.n} clean (${od.intrusion} intrusions) · displaced ${r.displaceCount}/${r.n}`,
  );
}
const onOverlapDirty = on.perRegime.OVERLAP.n - on.perRegime.OVERLAP.bloat;
console.log(
  `\nRead: if DISTINCT is clean but OVERLAP intrudes/displaces, relevance isolates ONLY when\n` +
    `topics differ — the concurrent same-topic case needs the session key (LOAD-BEARING).\n` +
    `If OVERLAP is also clean, the column is BLOAT. (embeddings-ON OVERLAP dirty queries: ${onOverlapDirty}/${on.perRegime.OVERLAP.n})`,
);
