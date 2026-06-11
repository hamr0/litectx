// Slice 5b integration tests — the episode promotion ladder (§14 #4 view #4). Episodes are the
// agent's ephemeral scratchpad; they graduate by USE into durable facts. These pin: the
// promotionCandidates gate + its three exclusions (below threshold / wrong provenance / decayed out
// of the window), the 10-vs-5 threshold asymmetry, episode self-pruning on write (with cascade
// cleanup), the full ladder composing into the existing reviewCandidates→human path, and the
// load-bearing isolation invariant — recall ranking never reads the promotion/demand signal.
// Behavior, not implementation; pure-memory store (no index()).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const DAY = 86_400_000;

/** @type {WeakMap<LiteCtx, string>} */
const roots = new WeakMap();
/** A throwaway in-memory store with a real (unused) root. */
function ctx() {
  const root = mkdtempSync(join(tmpdir(), "litectx-promo-"));
  const c = new LiteCtx({ root, dbPath: ":memory:" });
  roots.set(c, root);
  return c;
}
/** @param {LiteCtx} c */
function done(c) {
  c.close();
  const root = roots.get(c);
  if (root) rmSync(root, { recursive: true, force: true });
}

/** Inject `n` recall-demand events for a written id (cheaper than driving recall() n times). */
function hit(c, path, kind, n) {
  for (let i = 0; i < n; i++) c.store.logRecall([{ path, kind }], Date.now(), "recall");
}
/** Backdate a written row's occurred_at WITHOUT triggering the write-time prune. */
function backdate(c, path, ageMs) {
  c.store.db.prepare("UPDATE mem SET occurred_at = ? WHERE path = ?").run(Date.now() - ageMs, path);
}

test("promotionCandidates flags hot agent episodes — and excludes below-threshold, human, and decayed ones", async () => {
  const c = ctx();
  await c.remember("ep:hot", "auth tokens expire after one hour, not one day", { kind: "episode", by: "agent" });
  await c.remember("ep:warm", "the staging deploy needs the VPN on", { kind: "episode", by: "agent" });
  await c.remember("ep:human", "the CEO wants dark mode by Q3", { kind: "episode", by: "human" });
  await c.remember("ep:stale", "the old migration script double-charged on retries", { kind: "episode", by: "agent" });

  hit(c, "ep:hot", "episode", 12);
  hit(c, "ep:warm", "episode", 3);
  hit(c, "ep:human", "episode", 12);
  hit(c, "ep:stale", "episode", 12);
  backdate(c, "ep:stale", 31 * DAY); // outside the 30-day rolling window

  assert.deepEqual(c.promotionCandidates(), [{ path: "ep:hot", hits: 12 }]);
  done(c);
});

test("threshold asymmetry: 6 recalls promotes a fact for review but is NOT an episode promotion candidate", async () => {
  const c = ctx();
  await c.remember("ep:six", "the rate limiter resets at midnight UTC", { kind: "episode", by: "agent" });
  hit(c, "ep:six", "episode", 6);

  assert.deepEqual(c.promotionCandidates(), [], "6 < 10 (the episode default) → no candidate");
  assert.deepEqual(c.promotionCandidates(5), [{ path: "ep:six", hits: 6 }], "an explicit lower threshold catches it");
  done(c);
});

test("an episode write self-prunes episodes past the rolling window, cascading to the side tables", async () => {
  const c = ctx();
  await c.remember("ep:old", "a finding from last month", { kind: "episode", by: "agent" });
  hit(c, "ep:old", "episode", 4);
  backdate(c, "ep:old", 31 * DAY);
  assert.ok(c.get("ep:old", { log: false }), "still present before the next episode write");

  await c.remember("ep:new", "a finding from today", { kind: "episode", by: "agent" }); // triggers the prune

  assert.equal(c.get("ep:old", { log: false }), null, "decayed episode is hard-pruned");
  assert.equal(
    /** @type {{ n: number }} */ (c.store.db.prepare("SELECT count(*) AS n FROM recall_log WHERE path = 'ep:old'").get()).n,
    0,
    "its recall-log rows are cascaded away"
  );
  assert.ok(c.get("ep:new", { log: false }), "the fresh episode survives");
  done(c);
});

test("the ladder composes: hot episode → promotionCandidates → distil fact → reviewCandidates → human promote drops it", async () => {
  const c = ctx();
  // rung 1: a hot agent episode is flagged for distillation
  await c.remember("ep:gotcha", "webhook retries are not idempotent — dedupe on event id", { kind: "episode", by: "agent" });
  hit(c, "ep:gotcha", "episode", 12);
  assert.deepEqual(c.promotionCandidates(), [{ path: "ep:gotcha", hits: 12 }]);

  // the consumer's agent distils a durable fact (litectx flags; the agent writes)
  await c.remember("fact:webhook-idempotency", "Webhook handlers must dedupe on event id; retries are not idempotent.", { kind: "fact", by: "agent" });

  // rung 2: the agent-fact rides the existing reviewCandidates(5) path
  hit(c, "fact:webhook-idempotency", "fact", 6);
  assert.ok(c.reviewCandidates(5).some((r) => r.path === "fact:webhook-idempotency"), "agent fact past 5 → review candidate");

  // a human validates it → provenance flips → it leaves the review set ("acting removes it")
  await c.remember("fact:webhook-idempotency", "Webhook handlers must dedupe on event id; retries are not idempotent.", { kind: "fact", by: "human" });
  assert.ok(!c.reviewCandidates(5).some((r) => r.path === "fact:webhook-idempotency"), "validated (human) fact is no longer a candidate");
  done(c);
});

test("promotion is isolated from ranking — recall order is identical no matter the recall-hit count", async () => {
  const c = ctx();
  // two agent episodes that match the same query equally (identical body, different id → BM25 tie)
  await c.remember("ep:a", "blue green deploy strategy rollback", { kind: "episode", by: "agent" });
  await c.remember("ep:z", "blue green deploy strategy rollback", { kind: "episode", by: "agent" });

  const before = (await c.recall("blue green deploy", { kind: "episode", n: 5, log: false })).map((h) => h.path);
  const logRowsBefore = /** @type {{ n: number }} */ (c.store.db.prepare("SELECT count(*) AS n FROM recall_log").get()).n;

  hit(c, before[1], "episode", 40); // pour demand onto the lower-ranked one
  c.promotionCandidates(); // a read — must not write demand either

  const after = (await c.recall("blue green deploy", { kind: "episode", n: 5, log: false })).map((h) => h.path);
  assert.deepEqual(after, before, "recall ranking ignores recall-hit count — no rich-get-richer feedback");
  assert.equal(
    /** @type {{ n: number }} */ (c.store.db.prepare("SELECT count(*) AS n FROM recall_log").get()).n,
    logRowsBefore + 40,
    "only the injected hits were logged — promotionCandidates is a pure read"
  );
  done(c);
});
