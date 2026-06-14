// assemble() VALUE gate (benches-prd A2b) — the durable regression bench for the budget-fitter's
// reason to exist: the COMPRESS tier RESCUES a needed code/doc unit that plain FIT would evict.
//
// Unit tests (test/assemble.test.js) already guard the invariants on crafted inputs. This bench guards
// the *value*: on a tight-budget transcript where a later-needed code unit can't fit verbatim, assemble
// down-tiers it to its signature (kept, `compressed:true`) instead of dropping it — so the symbol the
// agent re-reads survives, where a naive FIT-only baseline loses it. That delta is what `compress-middle-poc`
// proved live (signature ≫ drop) and what must not silently regress.
//
// Deterministic / offline / free: the only async is compress()'s tree-sitter render. No corpus, no model,
// no Date/random — so this gate is CI-capable (kept as a local `npm run bench:assemble` for suite parity).
//
// Two gate mechanisms (the memory-bench discipline):
//   floors   — hold-or-beat: assemble's needed-symbol retention must stay ≥ 1.0 (the rescue works).
//   expected — pinned baseline (red-before-regression): FIT-only retention = 0.0 (the unit IS un-fittable
//              verbatim, so a passing assemble can only come from the COMPRESS tier, never from slack).
// Plus structural INVARIANTS asserted across every fixture (pinned never dropped, atomic never split,
// no silent loss, never overflow, order preserved) — a floor means nothing if the contract is broken.
//
// Usage: node poc/assemble-bench.mjs

import { assemble } from "../src/index.js";

const tokOf = (u) => (Number.isFinite(u.tokensApprox) ? u.tokensApprox : Math.ceil((u.content?.length ?? 0) / 4));
const NEEDLE = "validateToken"; // the symbol a later round re-reads — must survive the fit in SOME form

// A real, parseable function so compress() can extract a true signature (header + JSDoc, body elided).
const CODE = `/** Verify a bearer token and return its claims, or null. */
export async function validateToken(req, opts = {}) {
  const raw = req.headers.authorization?.replace(/^Bearer /, "");
  if (!raw) return null;
  const claims = await verifyJwt(raw, opts.secret);
  if (claims.exp < Date.now() / 1000) throw new TokenExpiredError(claims);
  return claims;
}`;

// ── Fixture A — COMPRESS rescue: the needed code unit can't fit verbatim; signature must survive. ──
// Budget keeps pinned(20) + 2 recent(60) + the signature(~), but NOT the full body(100). So a kept
// NEEDLE proves the COMPRESS tier fired (there is no room for the verbatim unit).
const fixtureA = {
  budget: 110,
  units: [
    { id: "sys", role: "system", content: "You are a careful engineer.", pinned: true, tokensApprox: 20 },
    { id: "code", role: "tool", kind: "code", format: "js", symbol: NEEDLE, content: CODE, tokensApprox: 100 },
    { id: "r1", role: "assistant", content: "Working on the auth refactor.", tokensApprox: 30 },
    { id: "r2", role: "user", content: "Now wire it into the route.", tokensApprox: 30 },
  ],
};

// ── Fixture B — invariants under pressure: pinned held, atomic pair kept-or-dropped WHOLE. ──
const fixtureB = {
  budget: 90,
  units: [
    { id: "sys", role: "system", content: "System.", pinned: true, tokensApprox: 20 },
    { id: "old", role: "assistant", content: "Stale older note.", tokensApprox: 50 },
    { id: "call", role: "assistant", content: "tool_call: search(x)", atomic: "g1", tokensApprox: 40 },
    { id: "res", role: "tool", content: "tool_result: 42 hits", atomic: "g1", tokensApprox: 40 },
    { id: "fresh", role: "user", content: "Latest message.", tokensApprox: 25 },
  ],
};

function checkInvariants(name, input, res, budget) {
  const fails = [];
  const inIds = input.map((u) => u.id);
  const keptIds = new Set(res.units.map((u) => u.id));
  const dropIds = new Set(res.dropped.map((d) => d.id));
  // (1) no silent loss: every input id is in exactly one of kept/dropped
  for (const id of inIds) {
    const n = (keptIds.has(id) ? 1 : 0) + (dropIds.has(id) ? 1 : 0);
    if (n !== 1) fails.push(`${id} appears ${n}× across kept/dropped (must be exactly 1)`);
  }
  // (2) pinned never dropped
  for (const u of input) if (u.pinned && dropIds.has(u.id)) fails.push(`pinned ${u.id} was dropped`);
  // (3) atomic never split
  const groups = {};
  for (const u of input) if (u.atomic) (groups[u.atomic] ??= []).push(u.id);
  for (const [g, ids] of Object.entries(groups)) {
    const kept = ids.filter((id) => keptIds.has(id)).length;
    if (kept !== 0 && kept !== ids.length) fails.push(`atomic ${g} split (${kept}/${ids.length} kept)`);
  }
  // (4) never overflow (the un-pinned room): tokens ≤ budget
  if (res.tokens > budget) fails.push(`tokens ${res.tokens} > budget ${budget}`);
  // (5) order preserved (kept is a subsequence of input)
  let j = 0;
  for (const u of input) if (keptIds.has(u.id)) { if (u.id !== res.units[j]?.id) { fails.push(`order broken at ${u.id}`); break; } j++; }
  return fails;
}

const viewText = (res) => res.units.map((u) => u.content).join("\n");

console.log("assemble() VALUE gate — COMPRESS-tier rescue + structural invariants\n");
let failures = 0;

// ---- Fixture A: assemble (COMPRESS on) vs FIT-only baseline (same unit, format stripped → not rescuable) ----
const onRes = await assemble(fixtureA.units, { budget: fixtureA.budget });
const baselineUnits = fixtureA.units.map((u) => (u.id === "code" ? { ...u, format: undefined, kind: null } : u));
const offRes = await assemble(baselineUnits, { budget: fixtureA.budget });

const onKeep = viewText(onRes).includes(NEEDLE) ? 1 : 0;     // assemble: rescued as signature
const offKeep = viewText(offRes).includes(NEEDLE) ? 1 : 0;   // baseline: dropped (un-fittable verbatim)
const codeUnit = onRes.units.find((u) => u.id === "code");

console.log(`[A] COMPRESS rescue (budget ${fixtureA.budget}; verbatim code = 100 tok, cannot fit)`);
console.log(`    assemble  : NEEDLE retained ${onKeep}/1   compressed=${codeUnit?.compressed === true}   tokens ${onRes.tokens}`);
console.log(`    FIT-only  : NEEDLE retained ${offKeep}/1   (baseline — code not parseable, so evicted)`);

const FLOOR = 1.0, EXPECTED_BASELINE = 0.0;
const aFloorPass = onKeep >= FLOOR;
const aBasePass = offKeep === EXPECTED_BASELINE;
const aCompressedPass = codeUnit?.compressed === true; // it survived AS a signature, not by slack
if (!aFloorPass) failures++;
if (!aBasePass) failures++;
if (!aCompressedPass) failures++;

// ---- Invariants across both fixtures ----
console.log(`\n[INV] structural invariants`);
for (const [name, fx, res] of [["A", fixtureA, onRes], ["B", fixtureB, await assemble(fixtureB.units, { budget: fixtureB.budget })]]) {
  const fails = checkInvariants(name, fx.units, res, fx.budget);
  if (fails.length) { failures += fails.length; fails.forEach((f) => console.log(`    FAIL [${name}] ${f}`)); }
  else console.log(`    [${name}] pinned-held · atomic-whole · no-silent-loss · no-overflow · order-preserved  →  OK`);
}

console.log(`\nGATE SUMMARY (assemble value + contract):`);
console.log(`  FLOOR    needed-symbol retention ${onKeep.toFixed(1)} ${aFloorPass ? "≥" : "<"} ${FLOOR.toFixed(1)}  →  ${aFloorPass ? "PASS" : "FAIL"}`);
console.log(`  RESCUE   kept unit is compressed=true                 →  ${aCompressedPass ? "PASS" : "FAIL (survived by slack, not the COMPRESS tier — discriminator void)"}`);
console.log(`  EXPECTED FIT-only baseline ${offKeep.toFixed(1)} = ${EXPECTED_BASELINE.toFixed(1)}            →  ${aBasePass ? "PASS (documented baseline)" : "FAIL — baseline moved; the unit became fittable, re-tighten the budget"}`);
console.log(`  failures (MUST be 0): ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
console.log();
