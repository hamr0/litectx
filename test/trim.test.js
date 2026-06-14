// R-C5 `trim(units, policy)` — the transcript-truncation seam (CE-PRD §8.2 / RT-2 interlock). A thin
// verb: SIZE delegates to `assemble`, COUNT is the net-new turn-granular policy, and the eviction
// contract (`harvest` = the dropped units, content intact) is what makes harvest-before-evict safe.
// Pure function → unit tests (Testing Trophy). The invariants under test ARE the POC's verdict
// (`poc/rc5-trim-poc.mjs`): C1 SIZE===assemble · C2a COUNT≠budget · C2b dropped===harvest worklist.

import { test } from "node:test";
import assert from "node:assert/strict";
import { trim, assemble } from "../src/index.js";

/** Build a unit. tokensApprox defaults so a "tok" is one cheap unit of budget. */
function u(id, { role = "tool", content = "x", pinned = false, atomic = null, tok = 10, kind = null } = {}) {
  return { id, role, content, kind, pinned, atomic, tokensApprox: tok };
}
const ids = (arr) => arr.map((x) => x.id);

test("neither policy → no-op: keep all, nothing dropped or harvested", async () => {
  const units = [u("a"), u("b"), u("c")];
  const r = await trim(units, {});
  assert.deepEqual(ids(r.units), ["a", "b", "c"]);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.harvest, []);
});

test("SIZE policy === assemble fit, unit-for-unit (C1: delegate, don't reimplement)", async () => {
  const units = [u("sys", { pinned: true }), u("a"), u("b"), u("c"), u("d")];
  const budget = 25;
  const a = await assemble(units, { budget });
  const r = await trim(units, { maxTokens: budget });
  assert.deepEqual(ids(r.units), ids(a.units), "kept set matches assemble");
  assert.deepEqual(r.dropped.map((d) => d.id), a.dropped.map((d) => d.id), "dropped set matches assemble");
  assert.ok(r.dropped.every((d) => d.reason === "size"));
});

test("SIZE policy harvest = the dropped units, content intact (C2b eviction contract)", async () => {
  const units = [u("a", { content: "alpha" }), u("b", { content: "bravo" }), u("c", { content: "charlie" })];
  const r = await trim(units, { maxTokens: 15 }); // keeps newest ~1-2, drops oldest
  assert.deepEqual(r.harvest.map((h) => h.id).sort(), r.dropped.map((d) => d.id).sort(), "harvest ids === dropped ids");
  for (const h of r.harvest) assert.ok(typeof h.content === "string" && h.content.length > 0, `${h.id} has content`);
});

test("COUNT policy keeps the N most-recent un-pinned items; pinned always kept", async () => {
  const units = [u("sys", { pinned: true }), u("a"), u("b"), u("c"), u("task", { pinned: true })];
  const r = await trim(units, { keepLastN: 2 });
  assert.deepEqual(ids(r.units), ["sys", "b", "c", "task"], "pinned kept + last 2 un-pinned");
  assert.deepEqual(r.dropped.map((d) => d.id), ["a"]);
  assert.ok(r.dropped.every((d) => d.reason === "count"));
});

test("COUNT keepLastN=0 drops every un-pinned unit, keeps only pinned", async () => {
  const units = [u("sys", { pinned: true }), u("a"), u("b")];
  const r = await trim(units, { keepLastN: 0 });
  assert.deepEqual(ids(r.units), ["sys"]);
  assert.deepEqual(r.harvest.map((h) => h.id), ["a", "b"]);
});

test("COUNT never splits an atomic group — kept or dropped whole", async () => {
  // last 2 ITEMS = {u3} and the atomic pair {tc,tr} as one item ⇒ keep both members; drop the older u1.
  const units = [
    u("u1"),
    u("tc", { atomic: "g", role: "assistant" }),
    u("tr", { atomic: "g", role: "tool" }),
    u("u3"),
  ];
  const r = await trim(units, { keepLastN: 2 });
  assert.deepEqual(ids(r.units), ["tc", "tr", "u3"], "atomic pair kept whole");
  assert.deepEqual(r.dropped.map((d) => d.id), ["u1"]);
  // and the inverse: keepLastN=1 keeps only {u3}; the atomic pair drops WHOLE, never half.
  const r1 = await trim(units, { keepLastN: 1 });
  assert.deepEqual(ids(r1.units), ["u3"]);
  assert.deepEqual(r1.dropped.map((d) => d.id), ["u1", "tc", "tr"]);
});

test("COUNT ≠ a token budget when turn sizes vary (C2a)", async () => {
  // freshest turn is large; COUNT keeps last-2 {u3,a3} regardless of size — no budget reproduces that.
  const units = [u("sys", { pinned: true, tok: 5 }), u("u1"), u("u3", { tok: 10 }), u("a3", { tok: 1000 })];
  const c = await trim(units, { keepLastN: 2 });
  assert.deepEqual(ids(c.units).filter((id) => id !== "sys"), ["u3", "a3"], "count keeps both last-2 items");
  const small = await assemble(units, { budget: 5 + 10 + 1 }); // fits small u3, not big a3
  const large = await assemble(units, { budget: 5 + 1000 + 1 }); // fits big a3, then not u3
  assert.ok(ids(small.units).includes("u3") && !ids(small.units).includes("a3"), "small budget: u3 not a3");
  assert.ok(ids(large.units).includes("a3") && !ids(large.units).includes("u3"), "large budget: a3 not u3");
});

test("SIZE precedence: maxTokens wins when both policies are supplied", async () => {
  const units = [u("a"), u("b"), u("c"), u("d")];
  const r = await trim(units, { maxTokens: 15, keepLastN: 99 });
  // maxTokens=15 forces drops despite keepLastN=99 asking to keep all → size policy applied.
  assert.ok(r.dropped.length > 0 && r.dropped.every((d) => d.reason === "size"));
});

test("no silent loss: kept ∪ dropped == input, exactly (COUNT)", async () => {
  const units = [u("sys", { pinned: true }), u("a"), u("b"), u("c"), u("d")];
  const r = await trim(units, { keepLastN: 2 });
  const seen = [...ids(r.units), ...r.dropped.map((d) => d.id)].sort();
  assert.deepEqual(seen, ["a", "b", "c", "d", "sys"]);
});

// ── Tight / no-fit edge cases (AGENT_RULES: cover the cases that can break, not just the happy path) ──

test("SIZE no fit: maxTokens=0 keeps only pinned, harvests all un-pinned", async () => {
  const units = [u("sys", { pinned: true }), u("a"), u("b")];
  const r = await trim(units, { maxTokens: 0 });
  assert.deepEqual(ids(r.units), ["sys"]);
  assert.deepEqual(r.harvest.map((h) => h.id).sort(), ["a", "b"]);
});

test("SIZE pinned-over-budget: pinned kept best-effort (no hard cap), never harvested", async () => {
  const units = [u("sys", { pinned: true, tok: 10000 }), u("a"), u("b")];
  const r = await trim(units, { maxTokens: 5 });
  assert.ok(ids(r.units).includes("sys"), "pinned kept even though it alone exceeds budget");
  assert.ok(!r.harvest.some((h) => h.id === "sys"), "pinned is never in the harvest worklist");
});

test("COUNT force-keeps an atomic group WHOLE when any member is pinned (never split)", async () => {
  // group "g" = a pinned member (p) + its non-pinned partner (q), both OLD; keepLastN=1 would normally
  // keep only the newest item (z). The pinned member must drag its whole group through → q survives too,
  // so the tool-call/result pair is never half-evicted (broken grammar unrepresentable).
  const units = [
    u("p", { atomic: "g", pinned: true, role: "assistant" }),
    u("q", { atomic: "g", role: "tool" }),
    u("x"),
    u("y"),
    u("z"),
  ];
  const r = await trim(units, { keepLastN: 1 });
  assert.ok(ids(r.units).includes("p") && ids(r.units).includes("q"), "atomic group kept whole via its pinned member");
  assert.deepEqual(r.dropped.map((d) => d.id), ["x", "y"], "only the un-pinned older turns evicted; z is the kept item");
  assert.ok(!r.harvest.some((h) => h.id === "p" || h.id === "q"), "neither group member harvested");
});

test("COUNT keepLastN > item count → keep everything, drop nothing", async () => {
  const units = [u("a"), u("b"), u("c")];
  const r = await trim(units, { keepLastN: 999 });
  assert.deepEqual(ids(r.units), ["a", "b", "c"]);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.harvest, []);
});

test("empty units → empty result, no throw", async () => {
  const r = await trim([], { keepLastN: 2 });
  assert.deepEqual(r.units, []);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.harvest, []);
});

test("invalid keepLastN (negative) → no-op keep-all, not an accidental eviction", async () => {
  const units = [u("a"), u("b")];
  const r = await trim(units, { keepLastN: -1 });
  assert.deepEqual(ids(r.units), ["a", "b"]);
  assert.deepEqual(r.dropped, []);
});
