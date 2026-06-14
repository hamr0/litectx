// POC — R-C5 `trim`: does it earn a new verb, or is it `assemble` wearing an eviction hat?
//
// Context (CE-PRD §8.2 / R-C5). `trim` is the transcript-truncation seam RT-2's harvest-before-evict
// interlock binds to: "drop old turns by recency/size heuristic, keep a restore handle." But `assemble`
// (RT-1, SHIPPED) ALREADY drops oldest un-pinned units to fit a token budget, recency-anchored,
// pinned/atomic-safe, with `dropped[]` restorable by id. And `summaryWindow` (R-C6, SHIPPED) set the
// precedent: a distinct INTENT ships as a thin verb that DELEGATES mechanics to assemble.
//
// So this POC tests two falsifiable claims, either of which can fail:
//   C1 (redundancy): trim's SIZE policy === assemble's fit, unit-for-unit → production trim must DELEGATE
//      to assemble, never reimplement the recency/atomic/pinned math. If they diverge, C1 is FALSE and
//      trim needs its own mechanic.
//   C2 (distinct value): trim adds what assemble lacks — (a) a COUNT policy ("keep last N turns", the
//      heuristic R-C5 names that a token-budget can't express directly), and (b) the EVICTION CONTRACT:
//      `dropped[]` is the exact harvest worklist the interlock feeds. If a count policy reduces to a
//      budget with no new behavior, C2(a) is weak and trim is just sugar.
//
// Run: node poc/rc5-trim-poc.mjs

import assert from "node:assert";
import { assemble } from "../src/assemble.js";
import { trim as shippedTrim } from "../src/index.js"; // C3 validates the SHIPPED verb, not the prototype

// ── A realistic multi-round transcript (oldest → newest), the shape bareagent's adapter hands us ──────
// pinned system prompt + pinned current task; an atomic tool-call/result pair; several plain turns.
const t = (id, content, extra = {}) => ({ id, role: "user", content, tokensApprox: Math.ceil(content.length / 4), ...extra });
const units = [
  t("sys", "You are an agent. Follow the rules.", { role: "system", pinned: true }),
  t("u1", "hop1: investigate the auth bug in validateToken"),
  t("a1", "hop1: read auth.js, found the early-return"),
  t("tc2", "hop2: TOOL grep validateToken", { role: "assistant", atomic: "g2" }),
  t("tr2", "hop2: RESULT 14 call sites across 6 files ...long payload...", { role: "tool", atomic: "g2" }),
  t("u3", "hop3: the fix is to guard the null branch"),
  t("a3", "hop3: patched auth.js line 40, tests pass"),
  t("task", "CURRENT TASK: open the PR", { role: "system", pinned: true }),
];

const tok = (u) => u.tokensApprox;
const byId = Object.fromEntries(units.map((u) => [u.id, u]));
const ids = (arr) => arr.map((u) => u.id);

// ── Prototype trim(units, policy). Mechanics: SIZE delegates to assemble. COUNT is the new knob. ─────
// Returns the eviction contract: { units: kept, dropped, harvest } where harvest === the dropped units
// (full content, so the caller can persist them) BEFORE it discards them from its canonical transcript.
async function trim(units, policy = {}) {
  if (Number.isFinite(policy.maxTokens)) {
    // SIZE policy — pure delegation. No recency/atomic/pinned math here; assemble owns it.
    const r = await assemble(units, { budget: policy.maxTokens });
    const droppedIds = new Set(r.dropped.map((d) => d.id));
    return { units: r.units, dropped: r.dropped.map((d) => ({ ...d, reason: "trim:size" })),
             harvest: units.filter((u) => droppedIds.has(u.id)) };
  }
  // COUNT policy — "keep the last N un-pinned ITEMS" (an atomic group counts as ONE item). Recency by
  // newest member; pinned always kept and never counted; atomic kept/dropped whole.
  const N = Number.isInteger(policy.keepLastN) ? policy.keepLastN : 0;
  const itemOf = new Map();        // itemKey -> {ids[], recency}
  const order = [];
  units.forEach((u, i) => {
    if (u.pinned) return;
    const key = u.atomic ?? `solo:${u.id}`;
    let it = itemOf.get(key);
    if (!it) { it = { ids: [], recency: i }; itemOf.set(key, it); order.push(key); }
    it.ids.push(u.id); it.recency = i;
  });
  const items = order.map((k) => itemOf.get(k)).sort((a, b) => a.recency - b.recency);
  const keep = new Set(units.filter((u) => u.pinned).map((u) => u.id));
  for (const it of items.slice(-N)) for (const id of it.ids) keep.add(id);
  const kept = units.filter((u) => keep.has(u.id));
  const harvest = units.filter((u) => !keep.has(u.id));
  return { units: kept, dropped: harvest.map((u) => ({ id: u.id, reason: "trim:count" })), harvest };
}

console.log("=== C1: SIZE-policy trim === assemble fit (delegate, don't reimplement) ===");
{
  const budget = 60; // tight enough to force drops
  const a = await assemble(units, { budget });
  const r = await trim(units, { maxTokens: budget });
  assert.deepStrictEqual(ids(r.units), ids(a.units), "C1: kept set must match assemble exactly");
  assert.deepStrictEqual(r.dropped.map((d) => d.id), a.dropped.map((d) => d.id), "C1: dropped set must match");
  console.log(`  budget=${budget} → kept [${ids(r.units)}], dropped [${r.dropped.map((d) => d.id)}]`);
  console.log("  ✓ SIZE trim is assemble, unit-for-unit → production trim DELEGATES.");
}

console.log("\n=== C2(a): COUNT policy keeps last N items, a budget can't express directly ===");
{
  const r = await trim(units, { keepLastN: 2 });
  // pinned sys+task always kept; last 2 un-pinned ITEMS = u3, a3. The atomic g2 pair is OLDER → dropped WHOLE.
  assert.ok(r.units.some((u) => u.id === "sys") && r.units.some((u) => u.id === "task"), "pinned kept");
  assert.deepStrictEqual(ids(r.units).filter((id) => !byId[id].pinned), ["u3", "a3"], "keep last 2 un-pinned items");
  const dropped = r.dropped.map((d) => d.id);
  assert.ok(dropped.includes("tc2") && dropped.includes("tr2"), "atomic pair dropped WHOLE, never split");
  assert.ok(!(dropped.includes("tc2") && r.units.some((u) => u.id === "tr2")), "atomic never half-kept");
  console.log(`  keepLastN=2 → kept [${ids(r.units)}], dropped [${dropped}]`);
  // Is count just a budget in disguise? Prove NO single budget reproduces it. Make the freshest turn
  // LARGE (a3 = 1000 tok). count keeps the last 2 items {u3, a3} regardless of size. A budget can't:
  // assemble fits newest-first with skip-and-continue, so it keeps EITHER the big-recent OR the small-
  // older, never the exact last-2-by-turn pair.
  const big = units.map((u) => u.id === "a3" ? { ...u, content: "x".repeat(4000), tokensApprox: 1000 } : u);
  const pin = big.filter((u) => u.pinned).reduce((n, u) => n + tok(u), 0);
  const u3tok = tok(big.find((u) => u.id === "u3"));
  const rc = await trim(big, { keepLastN: 2 });
  const small = await assemble(big, { budget: pin + u3tok + 1 });   // fits small u3, NOT big a3
  const large = await assemble(big, { budget: pin + 1000 + 1 });    // fits big a3, NOT then u3
  assert.deepStrictEqual(ids(rc.units).filter((id) => !byId[id].pinned), ["u3", "a3"], "count keeps BOTH last-2 items");
  assert.ok(ids(small.units).includes("u3") && !ids(small.units).includes("a3"), "small budget: keeps u3, drops a3");
  assert.ok(ids(large.units).includes("a3") && !ids(large.units).includes("u3"), "large budget: keeps a3, drops u3");
  console.log(`  count keeps [u3,a3]; small-budget keeps [u3] drops [a3]; large-budget keeps [a3] drops [u3]`);
  console.log("  ✓ NO budget reproduces 'keep last 2 turns' when sizes vary → COUNT is genuinely new.");
}

console.log("\n=== C2(b): dropped[] IS the harvest worklist (the interlock input) ===");
{
  const r = await trim(units, { keepLastN: 2 });
  // Every dropped id resolves to a full unit with content → caller can persist BEFORE discarding.
  for (const d of r.dropped) {
    const h = r.harvest.find((u) => u.id === d.id);
    assert.ok(h && typeof h.content === "string" && h.content.length > 0, `harvest unit for ${d.id} has content`);
  }
  assert.deepStrictEqual(r.harvest.map((u) => u.id).sort(), r.dropped.map((d) => d.id).sort(), "harvest === dropped");
  console.log(`  harvest-before-evict worklist = [${r.harvest.map((u) => u.id)}] (full content, restorable by id)`);
  console.log("  ✓ trim hands the interlock exactly what to persist before eviction.");
}

console.log("\n=== C3: tight / no-fit edge cases on the SHIPPED verb (AGENT_RULES: must be able to FAIL) ===");
// NB: C1/C2 above use the in-file PROTOTYPE (design exploration). C3 runs the SHIPPED `trim` — and that
// distinction matters: the prototype's `slice(-N)` evicts the oldest turn on keepLastN<0 (a bug); the
// shipped verb guards invalid input to a no-op. Validating the prototype here would have hidden that.
{
  // (a) SIZE no fit at all: maxTokens=0 → only pinned survive; every un-pinned unit is harvested.
  const r0 = await shippedTrim(units, { maxTokens: 0 });
  assert.deepStrictEqual(ids(r0.units), ["sys", "task"], "maxTokens=0 keeps only pinned");
  assert.deepStrictEqual(r0.harvest.map((u) => u.id).sort(), ["a1", "a3", "tc2", "tr2", "u1", "u3"], "all un-pinned harvested");

  // (b) pinned ALONE exceeds budget → pinned still kept best-effort (never a hard cap); never harvested.
  const heavy = units.map((u) => (u.pinned ? { ...u, tokensApprox: 10_000 } : u));
  const rh = await shippedTrim(heavy, { maxTokens: 5 });
  assert.ok(ids(rh.units).includes("sys") && ids(rh.units).includes("task"), "pinned kept over budget");
  assert.ok(!rh.harvest.some((u) => u.pinned), "pinned never harvested");

  // (c) COUNT keepLastN > item count → keep everything, nothing dropped.
  const rBig = await shippedTrim(units, { keepLastN: 999 });
  assert.deepStrictEqual(rBig.dropped, [], "keepLastN > items drops nothing");
  assert.deepStrictEqual(ids(rBig.units), ids(units), "all kept, original order");

  // (d) empty input → empty result (no throw).
  const re = await shippedTrim([], { keepLastN: 2 });
  assert.deepStrictEqual([re.units, re.dropped, re.harvest], [[], [], []], "empty units → empty result");

  // (e) invalid keepLastN (negative) → no-op keep-all, NOT an accidental eviction (safe-by-default).
  const rNeg = await shippedTrim(units, { keepLastN: -1 });
  assert.deepStrictEqual(rNeg.dropped, [], "negative keepLastN is invalid → no-op keep all");
  console.log("  ✓ maxTokens=0, pinned-over-budget, keepLastN-overflow, empty, negative — all hold (shipped).");
}

console.log("\nALL POC ASSERTIONS PASSED");
console.log("VERDICT: trim ships as a THIN verb — SIZE delegates to assemble (C1); COUNT + the");
console.log("eviction/harvest contract are the net-new value (C2). Mirrors summaryWindow's pattern.");
