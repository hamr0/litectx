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

// R-I3 peek (handle / lazy-load): the read-half of stash. A cheap preview of a parked blob WITHOUT
// rehydrating it — head prefix + true byte size + parked-at + a truncation flag, never the whole body.

test("peek previews a stash without rehydrating it — bounded head+tail, get() has the full body", () => {
  const c = ctx();
  c.stash("stash:big", BIG); // BIG is ~34KB
  const h = c.peek("stash:big");
  assert.ok(h, "peek returns a handle");
  assert.equal(h.id, "stash:big");
  assert.ok(h.head.length <= 160 && h.tail.length <= 80, "head/tail capped at the fixed preview budget");
  assert.ok(h.head.length + h.tail.length < BIG.length, "preview is a slice, not the whole payload");
  assert.equal(h.truncated, true, "truncated flags that a middle span is elided");
  assert.equal(h.bytes, Buffer.byteLength(BIG), "bytes is the true full octet size");
  assert.ok(BIG.startsWith(h.head), "head is the verbatim leading slice");
  assert.ok(BIG.endsWith(h.tail), "tail is the verbatim trailing slice");
  // the full body is one get() away — peek never destroys or replaces it
  assert.equal(c.get("stash:big").text, BIG);
  c.close();
});

test("peek's tail captures the conclusion at the END of the payload (head-only would miss it)", () => {
  const c = ctx();
  const log = "START build\n" + "compiling module ".repeat(3000) + "\nFATAL: Process exited with code 1";
  c.stash("stash:log", log);
  const h = c.peek("stash:log");
  assert.ok(h.head.startsWith("START build"), "head shows the beginning");
  assert.ok(h.tail.endsWith("Process exited with code 1"), "tail shows the verdict at the end");
  assert.ok(!h.head.includes("exited with code 1"), "the conclusion is NOT in the head — only the tail carries it");
  c.close();
});

test("peek reports OCTET bytes for multibyte text (not character count)", () => {
  const c = ctx();
  const utf8 = "ERREUR: le pool est épuisé — 接続プール枯渇 🔥\n" + "x".repeat(50);
  c.stash("stash:utf8", utf8);
  const h = c.peek("stash:utf8");
  assert.equal(h.bytes, Buffer.byteLength(utf8), "bytes counts UTF-8 octets, matching Buffer.byteLength");
  assert.notEqual(h.bytes, [...utf8].length, "and is distinct from the character count for multibyte text");
  // substr is char-based, so the head never splits a codepoint
  assert.equal(Buffer.from(h.head, "utf8").toString("utf8"), h.head, "head is valid UTF-8");
  c.close();
});

test("peek on a payload shorter than the budget is not truncated; head == full text", () => {
  const c = ctx();
  c.stash("stash:small", "short payload");
  const h = c.peek("stash:small");
  assert.equal(h.head, "short payload");
  assert.equal(h.tail, "", "no tail when the head already holds the whole payload");
  assert.equal(h.truncated, false);
  c.close();
});

test("peek is stash-only and null-safe — written memory and unknown ids return null", async () => {
  const c = ctx();
  await c.remember("fact:x", "a written fact, not a stash", { kind: "fact", by: "human" });
  assert.equal(c.peek("fact:x"), null, "peek does not reach into memory (recall owns that)");
  assert.equal(c.peek("stash:nope"), null, "unknown id is null, parity with get()");
  c.close();
});

test("peek surfaces the parked-at timestamp; re-stash refreshes it", () => {
  const c = ctx();
  c.stash("stash:t", "first");
  const t1 = c.peek("stash:t").createdAt;
  assert.equal(typeof t1, "number");
  c.stash("stash:t", "second payload");
  const h2 = c.peek("stash:t");
  assert.ok(h2.createdAt >= t1, "re-stash advances the parked-at time");
  assert.ok(h2.head.startsWith("second"), "and previews the new payload");
  c.close();
});
