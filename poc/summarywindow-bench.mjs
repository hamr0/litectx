// summaryWindow() VALUE gate (benches-prd A2b) — the durable regression bench for the rolling-summary
// read-path verb. Question: given the OLD turns a tight budget would drop, does the rolling summary
// retain the decisions used downstream, where a plain FIT-drop loses them?
//
// DETERMINISTIC BY DESIGN. The live-model value is already proven (poc/rc6-summarywindow-poc.mjs, 3/3 vs
// 0/3 on a real model). A *gate* must be offline + free (A2b / VB-3), so this drives summaryWindow with a
// STUB extractive summarizer — it pulls the sentences tagged DECISION-* out of the older turns. The stub
// makes the gate test the PLUMBING (fold → splice → survive the fit → restorable accounting), not model
// quality. No model, no Date/random → CI-capable (kept local as `npm run bench:summary` for suite parity).
//
// Gate mechanisms:
//   floor    — summaryWindow decision-retention ≥ FIT-drop (hold-or-beat), and = full (3/3): the splice works.
//   expected — FIT-drop retention = 0/3 (pinned, red-before-regression): the old turns are genuinely
//              un-fittable verbatim, so summaryWindow's win can only come from the summary, never from slack.
// Plus contract assertions: folded turns reported in `dropped` with reason "summarized" (restorable);
// the summary unit lists `summarizes`; never overflows; and the documented FALLBACKS are byte-identical
// to a plain assemble (unwired summarizer / everything-fits / < 2 older turns) — "never worse than FIT".
//
// Usage: node poc/summarywindow-bench.mjs

import { assemble, summaryWindow } from "../src/index.js";

const DECISIONS = ["DECISION-ALPHA", "DECISION-BRAVO", "DECISION-CHARLIE"];
const tokOf = (u) => (Number.isFinite(u.tokensApprox) ? u.tokensApprox : Math.ceil((u.content?.length ?? 0) / 4));

// Stub summarizer: extractive + deterministic. Keep only the DECISION-* sentences (drops filler) — so the
// summary is small (fits) yet carries every decision. This is the host's job in prod (a real model); here
// it is a fixed function so the gate has no model dependency.
const stubSummarize = async (msgs) =>
  msgs
    .map((m) => m.content)
    .join(" ")
    .split(/(?<=[.!?])\s+/)
    .filter((s) => DECISIONS.some((d) => s.includes(d)))
    .join(" ");

// Transcript: pinned system + 3 OLD turns (each buries one decision in filler) + 2 RECENT turns.
// Budget keeps pinned(20) + 2 recent(60) + the small summary, but NOT the 3 old turns (100 each).
const BUDGET = 160;
const SUMMARY_KEEP = 2; // last-2 verbatim → the 3 old turns are "older", folded
const units = [
  { id: "sys", role: "system", content: "You are a careful engineer.", pinned: true, tokensApprox: 20 },
  { id: "o1", role: "assistant", content: "Lots of preamble about the auth flow and middleware wiring. DECISION-ALPHA: auth uses JWT verified in middleware. Trailing notes that do not matter later.", tokensApprox: 100 },
  { id: "o2", role: "assistant", content: "Discussion of the billing edge cases and webhook retries. DECISION-BRAVO: refunds are allowed within thirty days. More rambling that is irrelevant downstream.", tokensApprox: 100 },
  { id: "o3", role: "assistant", content: "Back-and-forth on throughput and abuse. DECISION-CHARLIE: rate-limit is one hundred requests per minute. Tangential cleanup chatter follows here.", tokensApprox: 100 },
  { id: "n1", role: "user", content: "Continue with the route wiring.", tokensApprox: 30 },
  { id: "n2", role: "assistant", content: "On it — patching the handler now.", tokensApprox: 30 },
];

const retained = (res) => {
  const text = res.units.map((u) => u.content).join("\n");
  return DECISIONS.filter((d) => text.includes(d)).length;
};

console.log("summaryWindow() VALUE gate — rolling summary retains dropped-turn decisions (stub summarizer)\n");
let failures = 0;

const fit = await assemble(units, { budget: BUDGET });
const sw = await summaryWindow(units, { budget: BUDGET, summarize: stubSummarize, summaryKeep: SUMMARY_KEEP });

const fitKeep = retained(fit);
const swKeep = retained(sw);
console.log(`[fixture] ${units.length} units, budget ${BUDGET}, summaryKeep ${SUMMARY_KEEP}; 3 decisions buried in old turns`);
console.log(`    FIT (assemble)   : decisions retained ${fitKeep}/3   tokens ${fit.tokens}   dropped ${fit.dropped.length}`);
console.log(`    summaryWindow    : decisions retained ${swKeep}/3   tokens ${sw.tokens}   dropped ${sw.dropped.length}`);

// ── contract assertions ──
const summaryUnit = sw.units.find((u) => u.summary === true);
const summarizedDrops = sw.dropped.filter((d) => d.reason === "summarized").map((d) => d.id).sort();
const foldedOk = JSON.stringify(summarizedDrops) === JSON.stringify(["o1", "o2", "o3"]);
const summarizesOk = summaryUnit && JSON.stringify([...(summaryUnit.summarizes ?? [])].sort()) === JSON.stringify(["o1", "o2", "o3"]);
const noOverflow = sw.tokens <= BUDGET;

// ── fallback: never worse than FIT (must be byte-identical to a plain assemble) ──
const sameAsAssemble = (a, b) =>
  JSON.stringify(a.units.map((u) => u.id)) === JSON.stringify(b.units.map((u) => u.id)) &&
  JSON.stringify(a.dropped) === JSON.stringify(b.dropped) && a.tokens === b.tokens;
const fbUnwired = sameAsAssemble(await summaryWindow(units, { budget: BUDGET }), fit);                       // no summarize fn
const fbFits = sameAsAssemble(await summaryWindow(units, { budget: 100000, summarize: stubSummarize }),
  await assemble(units, { budget: 100000 }));                                                                 // no pressure
const fbFewOlder = sameAsAssemble(await summaryWindow(units, { budget: BUDGET, summarize: stubSummarize, summaryKeep: 10 }), fit); // <2 older → fold nothing

const FLOOR = fitKeep, EXPECTED_FIT = 0;
const floorPass = swKeep >= FLOOR && swKeep === 3;
const expectedPass = fitKeep === EXPECTED_FIT;
for (const [ok] of [[floorPass], [expectedPass], [foldedOk], [summarizesOk], [noOverflow], [fbUnwired], [fbFits], [fbFewOlder]]) if (!ok) failures++;

console.log(`\nGATE SUMMARY (summaryWindow value + contract):`);
console.log(`  FLOOR    summaryWindow ${swKeep}/3 ≥ FIT ${fitKeep}/3 and = 3/3            →  ${floorPass ? "PASS" : "FAIL"}`);
console.log(`  EXPECTED FIT-drop baseline ${fitKeep}/3 = ${EXPECTED_FIT}/3                       →  ${expectedPass ? "PASS (documented baseline)" : "FAIL — old turns became fittable; re-tighten budget"}`);
console.log(`  CONTRACT folded turns → dropped reason "summarized" (o1,o2,o3)  →  ${foldedOk ? "PASS" : "FAIL"}`);
console.log(`  CONTRACT summary unit lists summarizes[]                        →  ${summarizesOk ? "PASS" : "FAIL"}`);
console.log(`  CONTRACT never overflows (tokens ${sw.tokens} ≤ ${BUDGET})                   →  ${noOverflow ? "PASS" : "FAIL"}`);
console.log(`  FALLBACK never worse than FIT: unwired=${fbUnwired} fits=${fbFits} fewOlder=${fbFewOlder}  →  ${fbUnwired && fbFits && fbFewOlder ? "PASS" : "FAIL"}`);
console.log(`  failures (MUST be 0): ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
console.log();
