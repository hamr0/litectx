// R-C4 restorable compression — stash(): the keyed agent-context store. Behavior tests against an
// in-memory DB. The load-bearing invariants: a stashed payload round-trips by id (get rehydrates it
// verbatim), is NEVER surfaced by recall (no FTS home, on any kind), survives the episode rolling-
// window prune (restore must always work), and is evictable by an explicit forget. A stash is NOT
// memory — it coexists with facts/episodes without polluting their ranking.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

/** A LiteCtx over a throwaway in-memory DB (embeddings off — deterministic). */
function ctx() {
  return new LiteCtx({ root: mkdtempSync(join(tmpdir(), "litectx-stash-")), dbPath: ":memory:" });
}

const BIG = "FATAL: connection pool exhausted at worker 7\n" + "routine log line ".repeat(2000);

test("stash → get rehydrates the payload verbatim by id", () => {
  const c = ctx();
  c.stash("stash:toolresult-1", BIG);
  const back = c.get("stash:toolresult-1");
  assert.ok(back);
  assert.equal(back.text, BIG, "verbatim round-trip");
  assert.equal(back.kind, "stash");
  assert.equal(back.source, "direct");
  c.close();
});

test("a stash is NEVER surfaced by recall — not by default, not by an explicit kind", async () => {
  const c = ctx();
  c.stash("stash:toolresult-1", BIG);
  // default recall groups over KINDS = code/doc/fact/episode — stash isn't one of them
  const grouped = await c.recall("connection pool exhausted at worker");
  for (const k of Object.keys(grouped)) {
    assert.ok(!grouped[k].some((h) => h.path === "stash:toolresult-1"), `stash leaked into recall kind "${k}"`);
  }
  // even an explicit kind:"stash" query finds nothing — there is no FTS home to match against
  const explicit = await c.recall("connection pool exhausted at worker", { kind: "stash" });
  assert.deepEqual(explicit, [], "kind:stash recall returns empty — stash is unindexable");
  c.close();
});

test("a stash survives the episode rolling-window prune (restore always works)", async () => {
  const c = ctx();
  c.stash("stash:keepme", BIG);
  // a backdated episode + a fresh episode write triggers pruneStaleEpisodes — which must not touch stash
  await c.remember("episode:old", "old observation", { kind: "episode", by: "agent", occurredAt: Date.now() - 365 * 24 * 3600 * 1000 });
  await c.remember("episode:new", "new observation", { kind: "episode", by: "agent" });
  const back = c.get("stash:keepme");
  assert.ok(back && back.text === BIG, "stash payload still restorable after a prune-triggering write");
  c.close();
});

test("stash upserts by id — re-stashing the same id replaces the payload", () => {
  const c = ctx();
  c.stash("stash:x", "first");
  c.stash("stash:x", "second");
  assert.equal(c.get("stash:x").text, "second");
  c.close();
});

test("forget(id) evicts a stash; get then returns null", () => {
  const c = ctx();
  c.stash("stash:gone", BIG);
  const removed = c.forget("stash:gone");
  assert.equal(removed, 1, "forget reports the stash removed");
  assert.equal(c.get("stash:gone"), null, "evicted — no longer rehydratable");
  c.close();
});

test("stash coexists with real memory without polluting its recall", async () => {
  const c = ctx();
  c.stash("stash:noise", "the auth token is validated in validateToken with a connection pool");
  await c.remember("fact:auth", "auth uses JWT validated in validateToken", { kind: "fact", by: "human" });
  const facts = await c.recall("how is auth validated", { kind: "fact" });
  assert.ok(facts.some((h) => h.path === "fact:auth"), "the real fact is recalled");
  assert.ok(!facts.some((h) => h.path === "stash:noise"), "the stash never competes in recall");
  // but the stash is still directly rehydratable
  assert.ok(c.get("stash:noise"));
  c.close();
});
