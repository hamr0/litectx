// summaryWindow tier (R-C6) — integration over the SHIPPED verb. Proves the windowing POLICY: under
// budget pressure the older transcript turns are rolled into one restorable rolling summary while the
// last-N stay verbatim, fitted within budget via assemble (never an overflow). The model call is the
// host's (`ctx.summarize`); a DETERMINISTIC stub stands in here (the live-model value is proven in
// poc/rc6-summarywindow-poc.mjs). Falls back to a plain assemble when unwired / no pressure / nothing to fold.

import { test } from "node:test";
import assert from "node:assert/strict";
import { summaryWindow } from "../src/index.js";

// short turns (~9 tok each); a tight budget forces summarization, a loose one does not.
const turns = (n = 10) =>
  Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, role: i % 2 ? "assistant" : "user", content: `turn ${i + 1} content here padding` }));

const stub = (calls) => async (msgs) => { calls.push(msgs); return `SUMMARY of ${msgs.length} turns`; };

test("unwired (no ctx.summarize) → plain assemble: no summary unit, drops are reason 'budget'", async () => {
  const r = await summaryWindow(turns(), { budget: 30 });
  assert.equal(r.units.some((x) => x.summary), false);
  assert.ok(r.dropped.length > 0 && r.dropped.every((d) => d.reason === "budget"));
});

test("no budget pressure (everything fits) → no summary, no model call", async () => {
  const calls = [];
  const r = await summaryWindow(turns(4), { budget: 100000, summarize: stub(calls) });
  assert.equal(calls.length, 0, "summarizer not called when nothing needs folding");
  assert.equal(r.units.some((x) => x.summary), false);
  assert.equal(r.dropped.length, 0);
});

test("pressure + wired → older turns fold into ONE restorable summary; last-N stay verbatim", async () => {
  const calls = [];
  const r = await summaryWindow(turns(10), { budget: 40, summarize: stub(calls), summaryKeep: 4 });

  const sum = r.units.find((x) => x.summary);
  assert.ok(sum, "a summary unit is spliced");
  assert.equal(calls.length, 1, "summarizer called exactly once");
  assert.deepEqual(calls[0][0], { role: "user", content: "turn 1 content here padding" }, "fed {role,content} of OLDER turns");
  assert.deepEqual(sum.summarizes, ["t1", "t2", "t3", "t4", "t5", "t6"], "folds all-but-last-N (N=4 of 10)");

  // every folded turn is accounted as 'summarized' and recoverable by id
  const summarized = r.dropped.filter((d) => d.reason === "summarized").map((d) => d.id);
  assert.deepEqual(summarized, ["t1", "t2", "t3", "t4", "t5", "t6"]);
  // the most-recent turn is kept verbatim (not folded)
  assert.ok(r.units.some((x) => x.id === "t10" && !x.summary));
});

test("the view stays WITHIN budget — the summary fits the fit, never overflows", async () => {
  const r = await summaryWindow(turns(12), { budget: 45, summarize: stub([]), summaryKeep: 3 });
  assert.ok(r.units.some((x) => x.summary), "summary spliced");
  assert.ok(r.tokens <= 45, `view (${r.tokens} tok) must stay within budget (45)`);
});

test("a summary too big to fit is dropped (never overflow); folded turns degrade to 'budget'", async () => {
  const big = async () => "X".repeat(10000); // ~2500 tok summary, cannot fit budget 30
  const r = await summaryWindow(turns(10), { budget: 30, summarize: big, summaryKeep: 4 });
  assert.equal(r.units.some((x) => x.summary), false, "oversized summary not kept");
  assert.ok(r.tokens <= 30, "still within budget");
  assert.ok(r.dropped.some((d) => d.reason === "budget"));
});

test("fewer than 2 older turns → no fold, no model call (falls back to assemble)", async () => {
  const calls = [];
  // 5 turns, keep last 4 → only 1 older → below the 2-turn threshold
  const r = await summaryWindow(turns(5), { budget: 20, summarize: stub(calls), summaryKeep: 4 });
  assert.equal(calls.length, 0);
  assert.equal(r.units.some((x) => x.summary), false);
});

test("pinned, atomic, and code/doc units are never folded into the summary", async () => {
  const u = [
    { id: "sys", role: "system", content: "system prompt kept", pinned: true },
    { id: "code1", role: "tool", content: "function f(a,b){ return a+b }", kind: "code", format: "js" },
    { id: "tc", role: "assistant", content: "tool call", atomic: "g1" },
    { id: "tr", role: "tool", content: "tool result", atomic: "g1" },
    ...turns(8),
  ];
  const r = await summaryWindow(u, { budget: 45, summarize: stub([]), summaryKeep: 2 });
  const sum = r.units.find((x) => x.summary);
  if (sum) {
    for (const id of ["sys", "code1", "tc", "tr"]) assert.equal(sum.summarizes.includes(id), false, `${id} never folded`);
  }
  assert.ok(r.units.some((x) => x.id === "sys"), "pinned still present");
});

test("ctx.summaryRole and ctx.summaryId are honored", async () => {
  const r = await summaryWindow(turns(10), { budget: 40, summarize: stub([]), summaryKeep: 4, summaryRole: "user", summaryId: "rollup" });
  const sum = r.units.find((x) => x.summary);
  assert.ok(sum);
  assert.equal(sum.role, "user");
  assert.equal(sum.id, "rollup");
});
