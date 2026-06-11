// Facts-side trust tie-break POC (PRD §15 5c). The CODE half is settled — stability can't reorder
// recall (trust-tiebreak-poc.mjs: exact-tie = no-op, any band = repo-dependent pollution). This
// probes the FACTS half, which has its OWN ranking domain (the stemmed `mem` table) and DIFFERENT
// trust signals: provenance (human > agent) + recall use. There is NO stability signal for facts
// (no chunks → no churn), so "stable" never applies here.
//
// Two questions, kept apart:
//   (1) EMPIRICAL — do short prose facts actually TIE on BM25 often enough for an exact-tie rule to
//       fire? (code files almost never tied; this is the untested assumption the design rests on.)
//   (2) POLICY — when facts DO tie, does "human-verified first, then more-used" order them the way
//       we want? (a design choice, not an oracle — like 5b's ladder, demonstrated, not floored.)
// Real LiteCtx, :memory:, no embeddings. Use counts are seeded through the real recall log.
import { LiteCtx } from "../src/index.js";

// A small knowledge base: overlapping facts so queries hit MORE THAN ONE — the only time a
// tie-break matters. Provenance mixed on purpose. `use` = how many recall hits we seed (real log).
const FACTS = [
  { id: "fact:refund-window", by: "human", use: 1, text: "Refunds are issued within 5 business days to the original payment method." },
  { id: "fact:refund-eta", by: "agent", use: 6, text: "Refund requests usually take about a week to process." },
  { id: "fact:session-expiry", by: "human", use: 0, text: "Login sessions expire after 30 minutes of inactivity." },
  { id: "fact:session-idle", by: "agent", use: 3, text: "Sessions time out after half an hour idle." },
  { id: "fact:deploy-oidc", by: "human", use: 2, text: "Deploys run on merge to main through the OIDC trusted publisher." },
  { id: "fact:deploy-auto", by: "agent", use: 2, text: "Publishing happens automatically when code lands on main." },
  { id: "fact:ratelimit-key", by: "agent", use: 1, text: "The API allows 100 requests per minute per key." },
  { id: "fact:ratelimit-short", by: "agent", use: 9, text: "Rate limit is 100 requests per minute." },
];

const QUERIES = [
  "how long do refunds take",
  "when do login sessions expire",
  "how does publishing to npm happen on merge",
  "what is the api rate limit per minute",
];

const ctx = new LiteCtx({ root: "/tmp/litectx-trust-facts-poc-nonexistent", dbPath: ":memory:" });
for (const f of FACTS) await ctx.remember(f.id, f.text, { kind: "fact", by: f.by });
// seed real recall-log rows so `used` is a genuine count, not a fixture field.
for (const f of FACTS) for (let i = 0; i < f.use; i++) ctx.store.logRecall([{ path: f.id, kind: "fact" }], i + 1);

const prov = new Map(FACTS.map((f) => [f.id, f.by]));
const near = (a, b) => Math.abs(a - b) < 1e-9; // exact-score tie (float-safe equality)

let tiedQueries = 0, reordered = 0;
console.log("Facts-side trust tie-break — do facts tie, and does human→used order them right?\n");
for (const q of QUERIES) {
  const hits = await ctx.recall(q, { kind: "fact", n: 10, log: false });
  // annotate each hit with its trust signals
  const rows = hits.map((h) => ({ id: h.path, score: h.score, by: prov.get(h.path), use: ctx.store.recallCount(h.path) }));

  // tie groups = maximal runs of equal score (the only place a tie-break may act)
  const groups = [];
  for (const r of rows) {
    const g = groups[groups.length - 1];
    if (g && near(g[0].score, r.score)) g.push(r);
    else groups.push([r]);
  }
  const multiTie = groups.some((g) => g.length > 1);
  if (multiTie) tiedQueries++;

  // apply the tie-break INSIDE each exact-score group: human before agent, then more-used.
  const tb = groups.flatMap((g) => [...g].sort((a, b) => (a.by === b.by ? b.use - a.use : a.by === "human" ? -1 : 1)));
  const changed = tb.some((r, i) => r.id !== rows[i].id);
  if (changed) reordered++;

  console.log(`Q: "${q}"  ${multiTie ? "[TIE]" : "[no tie]"}${changed ? " reordered" : ""}`);
  const fmt = (list) => list.map((r) => `${r.by === "human" ? "H" : "a"}·u${r.use}·${r.id.replace("fact:", "")}@${r.score.toFixed(4)}`);
  console.log("   as-ranked : " + fmt(rows.slice(0, 4)).join("  "));
  if (changed) console.log("   tie-broken: " + fmt(tb.slice(0, 4)).join("  "));
  console.log();
}

console.log(`SUMMARY: ${tiedQueries}/${QUERIES.length} queries had an exact-score tie; tie-break changed order on ${reordered}.`);
console.log(tiedQueries ? "Facts DO tie → an exact-tie human→used rule fires." : "Facts do NOT tie → exact-tie rule is a no-op here too (reconsider).");
ctx.close();
