// Integration tests — the configurable episode retention window (`episodeWindowDays`, retention model
// 2026-06-27). The hardcoded 30-day window became a LiteCtxConfig knob; 30 stays the safe default. These
// pin the failable claims the POC settled (poc/episode-window-config-poc.mjs):
//   - default (unset) is byte-identical to the historic hardcoded 30d;
//   - ONE window drives BOTH consumer sites — the promotion floor AND the write-time prune — so a short
//     window starves the ladder (earned-but-too-old episode never promotes) and a long window retains +
//     promotes older episodes;
//   - a non-positive / non-finite window is rejected loudly (it would silently destroy the scratchpad).
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
/** @param {Record<string, unknown>} [cfg] */
function ctx(cfg = {}) {
  const root = mkdtempSync(join(tmpdir(), "litectx-window-"));
  const c = new LiteCtx({ root, dbPath: ":memory:", ...cfg });
  roots.set(c, root);
  return c;
}
/** @param {LiteCtx} c */
function done(c) {
  c.close();
  const root = roots.get(c);
  if (root) rmSync(root, { recursive: true, force: true });
}
/** Inject `n` recall-demand events for a written id (drives the promotion count without recall()). */
function hit(c, path, n) {
  for (let i = 0; i < n; i++) c.store.logRecall([{ path, kind: "episode" }], Date.now(), "recall");
}
/** Backdate a written row's occurred_at WITHOUT triggering the write-time prune. */
function backdate(c, path, ageMs) {
  c.store.db.prepare("UPDATE mem SET occurred_at = ? WHERE path = ?").run(Date.now() - ageMs, path);
}

test("default (unset) episodeWindowDays reproduces the historic 30-day window exactly", async () => {
  const c = ctx(); // no episodeWindowDays → ACTIVE_EPISODE_DAYS = 30
  assert.equal(c.episodeWindowDays, 30, "the resolved default is 30");
  await c.remember("ep:in", "earned, inside the window", { kind: "episode", by: "agent" });
  await c.remember("ep:out", "earned, just outside the window", { kind: "episode", by: "agent" });
  hit(c, "ep:in", 12);
  hit(c, "ep:out", 12);
  backdate(c, "ep:in", 29 * DAY);
  backdate(c, "ep:out", 31 * DAY);
  assert.deepEqual(c.promotionCandidates(), [{ path: "ep:in", hits: 12 }], "29d in, 31d out — the 30d floor");
  done(c);
});

test("a SHORT window starves the ladder: an earned episode older than the window can't promote", async () => {
  const wide = ctx(); // 30d default
  const narrow = ctx({ episodeWindowDays: 7 });
  for (const c of [wide, narrow]) {
    await c.remember("ep:mid", "earned 12×, 10 days old", { kind: "episode", by: "agent" });
    hit(c, "ep:mid", 12);
    backdate(c, "ep:mid", 10 * DAY);
  }
  // identical earned episode, identical age — only the window differs.
  assert.deepEqual(wide.promotionCandidates(), [{ path: "ep:mid", hits: 12 }], "promotable inside the 30d window");
  assert.deepEqual(narrow.promotionCandidates(), [], "below the 7d floor → never a candidate (the starvation edge)");
  done(wide);
  done(narrow);
});

test("the SAME short window also prunes the earned-but-too-old episode on the next write", async () => {
  const c = ctx({ episodeWindowDays: 7 });
  await c.remember("ep:mid", "earned, 10 days old", { kind: "episode", by: "agent" });
  hit(c, "ep:mid", 12);
  backdate(c, "ep:mid", 10 * DAY);
  assert.ok(c.get("ep:mid", { log: false }), "present before the next episode write");

  await c.remember("ep:fresh", "today", { kind: "episode", by: "agent" }); // triggers the 7d prune

  assert.equal(c.get("ep:mid", { log: false }), null, "pruned at the 7d window — prune + floor share the knob");
  assert.ok(c.get("ep:fresh", { log: false }), "the fresh episode survives");
  done(c);
});

test("a LONG window retains and promotes an episode the 30-day default discards", async () => {
  const def = ctx(); // 30d
  const long = ctx({ episodeWindowDays: 90 });
  for (const c of [def, long]) {
    await c.remember("ep:old", "earned 12×, 40 days old", { kind: "episode", by: "agent" });
    hit(c, "ep:old", 12);
    backdate(c, "ep:old", 40 * DAY);
  }
  assert.deepEqual(def.promotionCandidates(), [], "40d is past the 30d default floor");
  assert.deepEqual(long.promotionCandidates(), [{ path: "ep:old", hits: 12 }], "rescued by the 90d window");

  // and it survives the write-time prune at 90d (the set retains more — the documented trade-off)
  await long.remember("ep:new", "today", { kind: "episode", by: "agent" });
  assert.ok(long.get("ep:old", { log: false }), "retained past 30d under a 90d window");
  done(def);
  done(long);
});

test("a non-positive or non-finite episodeWindowDays is rejected at construction", () => {
  for (const bad of [0, -1, -30, NaN, Infinity]) {
    assert.throws(
      () => ctx({ episodeWindowDays: bad }),
      /episodeWindowDays must be a positive number of days/,
      `episodeWindowDays=${bad} must throw (it would silently destroy the scratchpad)`
    );
  }
  // a valid fractional/large value is accepted (litectx owns no upper policy)
  const c = ctx({ episodeWindowDays: 0.5 });
  assert.equal(c.episodeWindowDays, 0.5);
  done(c);
});
