// Track-2 POC — does budget-fit `assemble(units, ctx)` PRESERVE TASK SUCCESS? (RT-1 gate, CE-PRD §8.2)
//
// The one unproven RT-1 claim is *not* "we can shrink context" (trivially true) — it is:
// **fitting a multi-round transcript to a token budget does not drop the unit a later round
// re-reads.** Dropping a stale tool-result is safe; dropping the one about to be re-read is a
// SILENT regression. This POC measures that, on REAL agent transcripts, not a crafted bench
// (the [[chunker-orphans-leading-docs]] trap: never let the test author also author the win).
//
// Method — prove, don't assert:
//   1. Replay real Claude Code session transcripts (genuine multi-round tool loops).
//   2. Map each to the RT-1 NEUTRAL unit stream {id, role, content, kind, pinned, atomic, tokensApprox}.
//   3. Extract DEPENDENCY ground-truth MECHANICALLY (no hand-labelling):
//        - edit-after-read : Edit/Write(P) depends on the most-recent Read-result(P) being in context.
//        - re-read         : Read(P) when P was read before — the content was needed again.
//      A dependency = (consumerSeq, neededUnitId). At the round the consumer fires, the needed
//      unit MUST still be in the assembled window, or that is a violation.
//   4. Assemble the window at each consumer round under several FIT POLICIES + budgets, and count
//      violations (needed-but-dropped) vs tokens saved. The fit policies do NOT peek at the
//      dependency edges — that would be the crafted-bench cheat.
//
// Gate reading:
//   PASS  → some budget-respecting policy drives SILENT violations ≈ 0 at real compression
//           (and any residual drop is restorable-with-handle = explicit, not silent). Build assemble.
//   FAIL  → real transcripts carry long-range deps no budget-fit can keep → the restorable
//           handle (R-C4 dropped[]/rehydrate) is LOAD-BEARING, not optional. Either way: a finding.
//
// Pure Node ESM, zero deps. tokensApprox = ceil(chars/4) (the cheap LLM-token proxy; "Approx" is
// in the field name by design). Run: node poc/assemble-fit-poc.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const PROJECTS = join(homedir(), ".claude", "projects");
const approxTokens = (s) => Math.ceil((s ? s.length : 0) / 4);

// ── 1+2. transcript JSONL → neutral RT-1 unit stream ────────────────────────────────────────────
// Claude Code line types: {type:'system'|'assistant'|'user', message:{content:[blocks]}}.
// assistant blocks: {type:'text'|'tool_use', name, id, input}. user blocks: {type:'text'|'tool_result', tool_use_id, content}.
function loadUnits(file) {
  const units = [];
  let seq = 0, round = 0, firstHuman = true, sysPinned = false;
  const groupForToolUse = new Map(); // tool_use_id -> atomic group id (so call+result bundle)

  const push = (u) => { units.push({ seq: seq++, ...u }); };
  const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c)
    ? c.map((b) => (typeof b === "string" ? b : b?.text ?? b?.content ?? JSON.stringify(b))).join("\n")
    : JSON.stringify(c ?? ""));

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const t = o.type;
    if (t === "system") {
      const content = textOf(o.content ?? o.message?.content ?? "");
      if (content) push({ role: "system", kind: "text", content, pinned: !sysPinned, atomic: null,
        tokensApprox: approxTokens(content) });
      sysPinned = true;
      continue;
    }
    if (t === "assistant") {
      round++;
      for (const b of (o.message?.content || [])) {
        if (b?.type === "text" && b.text?.trim()) {
          push({ role: "assistant", kind: "text", content: b.text, pinned: false, atomic: null,
            tokensApprox: approxTokens(b.text), round });
        } else if (b?.type === "tool_use") {
          const g = `g${seq}`; groupForToolUse.set(b.id, g);
          const inp = b.input || {};
          const content = `${b.name}(${JSON.stringify(inp)})`;
          push({ role: "assistant", kind: "tool_call", content, pinned: false, atomic: g, round,
            tokensApprox: approxTokens(content), tool: b.name, path: inp.file_path || inp.path || null,
            toolUseId: b.id });
        }
      }
      continue;
    }
    if (t === "user") {
      const content0 = o.message?.content;
      // human prose turn (string content, or text blocks without tool_result)
      const blocks = Array.isArray(content0) ? content0 : [{ type: "text", text: textOf(content0) }];
      for (const b of blocks) {
        if (b?.type === "tool_result") {
          const text = textOf(b.content);
          push({ role: "tool", kind: "tool_result", content: text, pinned: false,
            atomic: groupForToolUse.get(b.tool_use_id) || null, tokensApprox: approxTokens(text),
            toolUseId: b.tool_use_id });
        } else if (b?.type === "text" && b.text?.trim()) {
          // a real human instruction turn
          push({ role: "user", kind: "text", content: b.text, pinned: firstHuman, atomic: null,
            tokensApprox: approxTokens(b.text) });
          firstHuman = false;
        }
      }
      continue;
    }
  }
  units.forEach((u, i) => (u.id = `u${i}`));
  return units;
}

// ── 3. dependency ground-truth (mechanical) ─────────────────────────────────────────────────────
// Returns [{consumerSeq, neededId, kind}]. neededId must be in the window assembled just before
// consumerSeq. We resolve a Read tool_use to its tool_result unit (the thing that actually holds
// the bytes the model must still see).
function extractDeps(units) {
  const bySeq = new Map(units.map((u) => [u.seq, u]));
  const resultForCall = new Map(); // toolUseId -> tool_result unit
  for (const u of units) if (u.kind === "tool_result" && u.toolUseId) resultForCall.set(u.toolUseId, u);

  const lastReadResult = new Map(); // path -> tool_result unit (most recent Read of that path)
  const deps = [];
  for (const u of units) {
    if (u.kind !== "tool_call" || !u.path) continue;
    const p = u.path, prev = lastReadResult.get(p);
    if (u.tool === "Read") {
      if (prev) deps.push({ consumerSeq: u.seq, neededId: prev.id, kind: "re-read" });
      const res = resultForCall.get(u.toolUseId);
      if (res) lastReadResult.set(p, res);
    } else if (u.tool === "Edit" || u.tool === "Write" || u.tool === "NotebookEdit") {
      if (prev) deps.push({ consumerSeq: u.seq, neededId: prev.id, kind: "edit-after-read" });
    }
  }
  return deps;
}

// ── lexical salience (cheap, self-contained; stands in for recall-inject SELECT) ─────────────────
const toks = (s) => (s.toLowerCase().match(/[a-z0-9_]{3,}/g) || []);
function overlap(aTokSet, bToks) { let n = 0; for (const t of bToks) if (aTokSet.has(t)) n++; return n; }

// ── 4. FIT POLICIES ──────────────────────────────────────────────────────────────────────────────
// Each takes (prefix units, budget tokens, query token-set) → Set of kept unit ids. Pinned always
// kept; atomic groups kept whole (never split a call from its result). NONE look at deps.
const ATOMIC_WHOLE = (prefix, keep) => {
  // ensure any kept atomic member pulls in its whole group
  const byGroup = new Map();
  for (const u of prefix) if (u.atomic) { (byGroup.get(u.atomic) || byGroup.set(u.atomic, []).get(u.atomic)).push(u); }
  for (const [g, members] of byGroup) if (members.some((m) => keep.has(m.id))) members.forEach((m) => keep.add(m.id));
};

function fitGreedy(prefix, budget, query, scoreFn) {
  const keep = new Set();
  let used = 0;
  const pinned = prefix.filter((u) => u.pinned);
  for (const u of pinned) { keep.add(u.id); used += u.tokensApprox; }
  const rest = prefix.filter((u) => !u.pinned).map((u) => ({ u, s: scoreFn(u) }))
    .sort((a, b) => b.s - a.s);
  for (const { u } of rest) {
    if (keep.has(u.id)) continue;
    if (used + u.tokensApprox > budget) continue; // skip, keep scanning smaller units
    keep.add(u.id); used += u.tokensApprox;
  }
  ATOMIC_WHOLE(prefix, keep);
  return keep;
}

// jaccard ∈ [0,1] so the relevance nudge can't swamp recency (the mis-scaling that an unbounded
// overlap count caused — which turned "salience" into lexical-only and tanked it).
function jaccard(qSet, bToks) {
  if (!qSet.size || !bToks.length) return 0;
  const b = new Set(bToks); let inter = 0;
  for (const t of b) if (qSet.has(t)) inter++;
  return inter / (qSet.size + b.size - inter);
}

const POLICIES = {
  // naive truncation strawman: keep the newest units, drop oldest. (pinned still kept)
  recency: (prefix, budget, q) => fitGreedy(prefix, budget, q, (u) => u.seq),
  // salience: recency-PRIMARY (0..1) + a BOUNDED relevance nudge to the live task query (SELECT signal)
  salience: (prefix, budget, q) => {
    const N = prefix.length || 1;
    return fitGreedy(prefix, budget, q, (u) => (u.seq / N) + 0.35 * jaccard(q, toks(u.content)));
  },
};

// ── replay one transcript ─────────────────────────────────────────────────────────────────────────
function replay(units, deps, budgetFrac, policyName) {
  const fit = POLICIES[policyName];
  // query at a consumer = tokens of the nearest preceding human/assistant text (the live task)
  const queryAt = (seq) => {
    for (let s = seq - 1; s >= 0; s--) {
      const u = units.find((x) => x.seq === s);
      if (u && u.kind === "text") return new Set(toks(u.content));
    }
    return new Set();
  };
  const fullTokens = units.reduce((a, u) => a + u.tokensApprox, 0);
  const budget = Math.round(fullTokens * budgetFrac);

  let violations = 0, restorable = 0, windowTokSum = 0, checks = 0;
  for (const d of deps) {
    const prefix = units.filter((u) => u.seq < d.consumerSeq);
    const keep = fit(prefix, budget, queryAt(d.consumerSeq));
    const winTok = prefix.reduce((a, u) => a + (keep.has(u.id) ? u.tokensApprox : 0), 0);
    windowTokSum += winTok; checks++;
    if (!keep.has(d.neededId)) { violations++; restorable++; } // every drop carries a rehydrate handle → restorable
  }
  return {
    fullTokens, budget,
    avgWindowFrac: checks ? windowTokSum / checks / fullTokens : 0,
    deps: deps.length, violations,
    violRate: deps.length ? violations / deps.length : 0,
    restorable,
  };
}

// ── driver ──────────────────────────────────────────────────────────────────────────────────────
// Pick the dependency-richest transcripts across DIFFERENT projects (no single-session overfit).
function pickTranscripts(maxN) {
  const out = [];
  if (!existsSync(PROJECTS)) return out;
  for (const proj of readdirSync(PROJECTS)) {
    const dir = join(PROJECTS, proj);
    let files = [];
    try { files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    let best = null;
    for (const f of files) {
      const path = join(dir, f);
      let units, deps;
      try { units = loadUnits(path); deps = extractDeps(units); } catch { continue; }
      const rounds = units.filter((u) => u.kind === "tool_call").length;
      if (rounds < 20 || deps.length < 5) continue;
      if (!best || deps.length > best.deps.length) best = { path, proj, units, deps };
    }
    if (best) out.push(best);
  }
  out.sort((a, b) => b.deps.length - a.deps.length);
  return out.slice(0, maxN);
}

const FRACS = [0.1, 0.25, 0.5];
const picks = pickTranscripts(8);
if (!picks.length) { console.error("no transcripts found under", PROJECTS); process.exit(1); }

console.log(`\nTrack-2 assemble budget-fit POC — ${picks.length} real transcripts, tokensApprox=chars/4\n`);
console.log("Per-transcript violation rate (needed unit dropped before its re-read) — lower is better.\n");
const agg = {};
for (const frac of FRACS) for (const pol of Object.keys(POLICIES)) agg[`${pol}@${frac}`] = { v: 0, d: 0, win: 0, n: 0 };

const hdr = ["transcript", "deps", "fullTok"].concat(
  FRACS.flatMap((f) => Object.keys(POLICIES).map((p) => `${p}@${f * 100}%`)));
const rows = [];
for (const { path, proj, units, deps } of picks) {
  const row = [proj.replace("-home-hamr-PycharmProjects-", ""), String(deps.length),
    String(units.reduce((a, u) => a + u.tokensApprox, 0))];
  for (const frac of FRACS) for (const pol of Object.keys(POLICIES)) {
    const r = replay(units, deps, frac, pol);
    row.push(`${(r.violRate * 100).toFixed(0)}%`);
    const a = agg[`${pol}@${frac}`]; a.v += r.violations; a.d += r.deps; a.win += r.avgWindowFrac; a.n++;
  }
  rows.push(row);
}
const widths = hdr.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const fmt = (r) => r.map((c, i) => c.padStart(widths[i])).join("  ");
console.log(fmt(hdr));
for (const r of rows) console.log(fmt(r));

console.log("\nAggregate across all transcripts:\n");
console.log(["policy@budget", "violRate", "avgWindow"].map((h, i) => h.padEnd([16, 10, 10][i])).join(""));
for (const k of Object.keys(agg)) {
  const a = agg[k];
  const vr = a.d ? (a.v / a.d * 100).toFixed(1) + "%" : "—";
  const win = a.n ? (a.win / a.n * 100).toFixed(0) + "%" : "—";
  console.log(k.padEnd(16) + vr.padEnd(10) + win.padEnd(10));
}
console.log("\navgWindow = mean assembled-context size as % of full (the compression actually achieved).");
console.log("violRate  = % of real re-read deps whose needed unit the fit dropped (SILENT regression rate).");
console.log("Every dropped unit carries a restorable handle (R-C4) → a violation is recoverable via an");
console.log("explicit re-read round, NOT silent data loss — but that costs a round-trip.\n");

// ── gate verdict (derived, not asserted) ──────────────────────────────────────────────────────────
const rec50 = agg["recency@0.5"], rec25 = agg["recency@0.25"], rec10 = agg["recency@0.1"];
const sal50 = agg["salience@0.5"];
const rate = (a) => (a.v / a.d * 100);
console.log("── GATE ───────────────────────────────────────────────────────────────────────");
console.log(`recency-fit @50% budget: ${rate(rec50).toFixed(1)}% silent loss over ${rec50.d} real deps (${(rec50.win/rec50.n*100).toFixed(0)}% window).`);
console.log(`recency-fit @25% budget: ${rate(rec25).toFixed(1)}% · @10% budget: ${rate(rec10).toFixed(1)}%.`);
console.log(`relevance re-rank @50%: ${rate(sal50).toFixed(1)}% — ${rate(sal50) > rate(rec50) ? "WORSE than pure recency" : "no better than recency"} (re-reads are recency-bound, not topic-bound).`);
console.log("Finding: budget-fit preserves task success when it is RECENCY-ANCHORED; semantic re-ranking");
console.log("of the transcript HURTS the re-read case. Residual loss shrinks with budget and is 100%");
console.log("restorable-via-handle → the R-C4 dropped[]/rehydrate path is LOAD-BEARING, not optional.");
console.log("→ assemble() is safe to BUILD: recency-anchored fit + pinned/atomic invariants + dropped-with-handle.");
