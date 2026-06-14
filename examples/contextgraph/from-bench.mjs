// contextgraph applied to an EXISTING bench — poc/assemble-bench.mjs (the assemble() VALUE gate).
//
// That bench feeds a tight-budget transcript, where a later-needed code unit (`validateToken`) can't
// fit VERBATIM, through assemble TWO ways and asserts the value: COMPRESS-on rescues the unit as a
// signature (needle survives) where a FIT-only baseline drops it (needle lost). The bench's pipeline is
// just `assemble` calls — so contextgraph traces it directly, and the A/B shows up as two branches.
//
// Run:  node examples/contextgraph/from-bench.mjs   (writes contextgraph-bench.{json,svg,md})

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assemble } from "../../src/index.js";
import { ContextGraph } from "../../src/index.js";
import { svg } from "./render.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// the bench fixture A, verbatim (poc/assemble-bench.mjs): explicit tokensApprox so the budget math is
// exact — the old code unit (100 tok) provably can't fit the un-pinned room, which is what forces the
// FIT-only drop. Newer chat fills the budget first (recency); the needed code unit is the casualty.
const NEEDLE = "validateToken";
const CODE = `/** Verify a bearer token and return its claims, or null. */
export async function validateToken(req, opts = {}) {
  const raw = req.headers.authorization?.replace(/^Bearer /, "");
  if (!raw) return null;
  const claims = await verifyJwt(raw, opts.secret);
  if (claims.exp < Date.now() / 1000) throw new TokenExpiredError(claims);
  return claims;
}`;
const transcript = [
  { id: "sys", role: "system", content: "You are a careful engineer.", pinned: true, tokensApprox: 20 },
  { id: "code", role: "tool", kind: "code", format: "js", symbol: NEEDLE, content: CODE, tokensApprox: 100 },
  { id: "r1", role: "assistant", content: "Working on the auth refactor.", tokensApprox: 30 },
  { id: "r2", role: "user", content: "Now wire it into the route.", tokensApprox: 30 },
];
const BUDGET = 110; // keeps pinned(20) + 2 recent(60) + the signature — but NOT the full body(100)

const g = new ContextGraph();
const fixN = g.node({ verb: "transcript", detail: `${transcript.length} units · needle ${NEEDLE}`, col: 0, row: 0,
  stats: { units: transcript.length, budget: BUDGET, needle: NEEDLE } });

// branch A (row 0): COMPRESS on — the code unit is parseable, so assemble down-tiers it to a signature
const on = await assemble(transcript, { budget: BUDGET });
const onCode = on.units.find((u) => u.id === "code");
const onKept = on.units.filter((u) => !u.compressed).length, onComp = on.units.filter((u) => u.compressed).length;
const onNeedle = on.units.some((u) => u.content.includes(NEEDLE));
const aN = g.node({ verb: "assemble", detail: `COMPRESS on · budget ${BUDGET}`, col: 1, row: 0,
  stats: { budget: BUDGET, codeCompressed: onCode?.compressed === true } });
g.edge(fixN, aN, `${transcript.length} units`);
const aOut = g.node({ verb: "→ context", detail: `needle ${onNeedle ? "kept as signature" : "LOST"}`, col: 2, row: 0,
  accent: onNeedle ? "#1c3a2e" : "#3a1c1c", stats: { tokens: on.tokens, kept: onKept, compressed: onComp, dropped: on.dropped.length, needleRetained: onNeedle } });
g.edge(aN, aOut, `kept ${onKept} · comp ${onComp} · drop ${on.dropped.length}`);

// branch B (row 1): FIT only — the same code unit, made un-parseable, can't be down-tiered → dropped
const baseUnits = transcript.map((u) => (u.id === "code" ? { ...u, format: undefined, kind: null } : u));
const off = await assemble(baseUnits, { budget: BUDGET });
const offNeedle = off.units.some((u) => u.content.includes(NEEDLE));
const bN = g.node({ verb: "assemble", detail: `FIT only · budget ${BUDGET}`, col: 1, row: 1,
  stats: { budget: BUDGET, parseable: false } });
g.edge(fixN, bN, `${transcript.length} units (baseline)`);
const bOut = g.node({ verb: "→ context", detail: `needle ${offNeedle ? "kept" : "LOST — dropped"}`, col: 2, row: 1,
  accent: offNeedle ? "#1c3a2e" : "#3a1c1c", stats: { tokens: off.tokens, kept: off.units.length, dropped: off.dropped.length, needleRetained: offNeedle } });
g.edge(bN, bOut, `kept ${off.units.length} · drop ${off.dropped.length}`);

writeFileSync(join(here, "contextgraph-bench.json"), JSON.stringify(g.json(), null, 2) + "\n");
writeFileSync(join(here, "contextgraph-bench.svg"), svg(g, {
  theme: "light",
  title: "litectx · contextgraph — assemble VALUE bench (A/B)",
  subtitle: "the COMPRESS-rescue gate as a pipeline: one transcript, two assemble policies",
}) + "\n");
writeFileSync(join(here, "contextgraph-bench.md"), "# contextgraph — assemble bench (generated)\n\n```mermaid\n" + g.mermaid() + "\n```\n");

console.log(g.mermaid());
console.log(`\nneedle retained — COMPRESS on: ${onNeedle}  ·  FIT only: ${offNeedle}  (the bench's value claim, as a graph)`);
console.log(`wrote contextgraph-bench.{json,svg,md} to ${here}`);
