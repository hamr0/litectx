// RT-1 `assemble(units, ctx)` — budget-fit a neutral transcript, recency-anchored, preserving the
// pinned/atomic invariants (CE-PRD §8.2). Pure function → unit tests (Testing Trophy: pure algorithm).
// The invariants under test ARE the contract the budget-fit POC cleared:
//   1. no budget → identity (keep all, nothing dropped, order preserved);
//   2. pinned never drops, even over budget; budget is the un-pinned room ("pin, don't hide");
//   3. recency-anchored — a tight budget keeps the NEWEST un-pinned, drops the oldest;
//   4. atomic groups are kept-or-dropped WHOLE, never split (broken grammar unrepresentable);
//   5. cache-stable — output is input order minus drops, byte-identical on re-run;
//   6. no silent loss — kept ∪ dropped == input, exactly;
//   7. tokens ≤ budget when pinned fit; pinned-over-budget is kept best-effort (no hard cap);
//   8. tokensApprox falls back to chars/4 when absent;
//   9. a pinned member force-keeps its whole atomic group.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assemble } from "../src/index.js";

/** Build a unit. tokensApprox defaults so a "tok" is one cheap unit of budget in these tests. */
function u(id, { role = "tool", content = "x", pinned = false, atomic = null, tok = 10, kind = null } = {}) {
  return { id, role, content, kind, pinned, atomic, tokensApprox: tok };
}
const ids = (arr) => arr.map((x) => x.id);

test("no budget → identity: keep everything, nothing dropped, order preserved", () => {
  const units = [u("a"), u("b"), u("c")];
  const r = assemble(units, {});
  assert.deepEqual(ids(r.units), ["a", "b", "c"]);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.tokens, 30);
});

test("recency-anchored: a tight budget keeps the NEWEST un-pinned and drops the oldest", () => {
  const units = [u("old1"), u("old2"), u("mid"), u("new1"), u("new2")]; // 10 tok each
  const r = assemble(units, { budget: 25 }); // room for 2
  assert.deepEqual(ids(r.units), ["new1", "new2"], "newest two survive");
  assert.deepEqual(r.dropped.map((d) => d.id), ["old1", "old2", "mid"]);
  assert.equal(r.tokens, 20);
  assert.ok(r.tokens <= 25);
});

test("cache-stable: kept units stay in ORIGINAL order, never reordered; deterministic on re-run", () => {
  const units = [u("a"), u("b"), u("c"), u("d")];
  const r1 = assemble(units, { budget: 25 });
  const r2 = assemble(units, { budget: 25 });
  // newest-fit picks c,d but they must emit in original order c-then-d (not d-then-c)
  assert.deepEqual(ids(r1.units), ["c", "d"]);
  assert.deepEqual(r1, r2, "byte-identical on re-run (no Date/random)");
});

test("pinned never drops even when it alone exceeds budget; budget is the un-pinned room", () => {
  const units = [u("sys", { pinned: true, tok: 100 }), u("task", { pinned: true, tok: 50 }), u("t1"), u("t2")];
  const r = assemble(units, { budget: 20 }); // pinned (150) already over budget
  assert.ok(ids(r.units).includes("sys") && ids(r.units).includes("task"), "pinned kept regardless");
  // un-pinned room = budget - pinned = negative → no un-pinned units fit
  assert.deepEqual(r.dropped.map((d) => d.id), ["t1", "t2"]);
  assert.ok(r.tokens >= 150, "best-effort, not a hard cap");
});

test("pinned in place + recency fit of the rest", () => {
  const units = [u("sys", { pinned: true, tok: 5 }), u("a"), u("b"), u("c")];
  const r = assemble(units, { budget: 25 }); // 5 pinned + room for 2 un-pinned (b,c)
  assert.deepEqual(ids(r.units), ["sys", "b", "c"], "sys stays first, newest two of a/b/c kept");
  assert.deepEqual(r.dropped.map((d) => d.id), ["a"]);
});

test("atomic group is kept WHOLE — never split", () => {
  // call+result bundled as group g1; budget allows the bundle but not the older lone unit
  const units = [u("old"), u("call", { atomic: "g1", role: "assistant", tok: 10 }), u("result", { atomic: "g1", tok: 10 })];
  const r = assemble(units, { budget: 20 });
  assert.deepEqual(ids(r.units), ["call", "result"], "both members of g1 survive together");
  assert.deepEqual(r.dropped.map((d) => d.id), ["old"]);
});

test("atomic group is dropped WHOLE when it doesn't fit — never half-kept", () => {
  const units = [u("call", { atomic: "g1", role: "assistant", tok: 30 }), u("result", { atomic: "g1", tok: 30 }), u("new", { tok: 10 })];
  const r = assemble(units, { budget: 15 }); // only the lone newest fits; the 60-tok bundle can't
  assert.deepEqual(ids(r.units), ["new"]);
  const droppedIds = r.dropped.map((d) => d.id).sort();
  assert.deepEqual(droppedIds, ["call", "result"], "both bundle members drop together");
});

test("a pinned member force-keeps its whole atomic group", () => {
  const units = [u("p", { pinned: true, atomic: "g1", tok: 5 }), u("sibling", { atomic: "g1", tok: 1000 }), u("other", { tok: 10 })];
  const r = assemble(units, { budget: 12 }); // sibling is huge, but the group is forced by its pinned member
  assert.ok(ids(r.units).includes("p") && ids(r.units).includes("sibling"), "whole forced group kept");
});

test("no silent loss: kept ∪ dropped == input exactly", () => {
  const units = [u("a"), u("b", { atomic: "g" }), u("c", { atomic: "g" }), u("d", { pinned: true }), u("e")];
  const r = assemble(units, { budget: 15 });
  const accounted = [...ids(r.units), ...r.dropped.map((d) => d.id)].sort();
  assert.deepEqual(accounted, ["a", "b", "c", "d", "e"], "every input unit is either kept or dropped, once");
});

test("tokensApprox falls back to chars/4 when absent", () => {
  const big = { id: "big", role: "tool", content: "x".repeat(400) };   // ~100 tok
  const small = { id: "small", role: "tool", content: "x".repeat(40) }; // ~10 tok
  const r = assemble([big, small], { budget: 50 });
  assert.deepEqual(ids(r.units), ["small"], "big (~100 tok via chars/4) excluded, small (~10) kept");
});

test("throws on a non-array units argument (consumer misuse → bareagent fails open)", () => {
  assert.throws(() => assemble(null, { budget: 10 }), TypeError);
  assert.throws(() => assemble("nope", {}), TypeError);
});

test("the re-read invariant: a needed-recent unit survives a budget that keeps recency", () => {
  // models the POC's edit-after-read: the file Read (needed) is recent; a budget keeping the tail keeps it.
  const units = [u("noise1"), u("noise2"), u("readResult", { tok: 10 }), u("assistantPlan", { role: "assistant", tok: 5 })];
  const r = assemble(units, { budget: 16 });
  assert.ok(ids(r.units).includes("readResult"), "the recent needed read is preserved within budget");
});
