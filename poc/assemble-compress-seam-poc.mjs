// COMPRESS-tier SEAM validation on REAL data (closes the gap flagged 2026-06-13: the build's
// integration value was fixture-only). Question: at the `assemble()` seam, when a budget forces a REAL
// injected `kind:code` unit to the drop boundary, does down-tiering it to its `compress()` SIGNATURE
// preserve the answer that DROP loses — and what is the REAL byte saving on real functions (vs the
// crafted-handler POC's 24%)?
//
// Real data: production functions (JSDoc + ≥2 params + a body string literal) extracted from the
// litectx and bareguard `src/` trees — code I did NOT write for this test. Each is fed through the
// SHIPPED `assemble()` (src/assemble.js) at three budgets; the emitted view (verbatim / signature /
// drop — ASSERTED to be the tier the verb actually chose) becomes the model's context.
//
// Two mechanical, can-fail metrics (tools OFF → must answer from context, can't go read the file):
//   PARAMS  — "list the parameters of <name>" — RETRIEVED iff every real param name appears in output.
//             Hypothesis: verbatim ✓, signature ✓ (params live in the header), drop ✗. The WIN cell is
//             signature-vs-drop; if signature ≯ drop here, the tier earns nothing → the test can fail.
//   BODY    — "the exact string literal used inside <name>" — RETRIEVED iff the literal is in output.
//             Hypothesis: verbatim ✓, signature ✗ (body elided) = tracks DROP. The honest limit.
//
// Run: node poc/assemble-compress-seam-poc.mjs   (uses `claude -p`, sonnet, no API key)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assemble } from "../src/index.js";        // THE SHIPPED VERB
import { compress } from "../src/compress.js";       // exact signature the verb will emit

const approx = (s) => Math.ceil((s ? s.length : 0) / 4);
const MODEL = "sonnet";
const ROOTS = ["src", "../bareguard/src"];           // real production JS, not authored for this test

// ── extract real functions — ANCHORED ON THE DECLARATION (a prior lazy-regex version captured
//    multi-def spans → signatureOf described the WRONG, first def; caught by diagnostic, fixed here).
//    Each unit = exactly ONE function + its IMMEDIATELY-ADJACENT doc (only whitespace between). ──────
function extractFns(file, src) {
  const out = [];
  const re = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const params = m[2].split(",").map((s) => s.trim().split(/[=:?\s]/)[0]).filter((s) => /^[A-Za-z_]/.test(s));
    if (params.length < 2) continue;
    const open = m.index + m[0].length - 1;           // the `{` matched at the end of the decl
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) { const c = src[i]; if (c === "{") depth++; else if (c === "}" && --depth === 0) { end = i + 1; break; } }
    if (end < 0) continue;
    // the nearest preceding /** … */, included ONLY if just whitespace separates it from the decl
    const docs = [...src.slice(0, m.index).matchAll(/\/\*\*[\s\S]*?\*\//g)];
    const last = docs[docs.length - 1];
    const start = last && /^\s*$/.test(src.slice(last.index + last[0].length, m.index)) ? last.index : m.index;
    const text = src.slice(start, end);
    const body = src.slice(open, end);
    const header = src.slice(start, open);
    const lits = [...body.matchAll(/["'`]([^"'`\n]{6,40})["'`]/g)].map((x) => x[1]);
    const bodyLit = lits.find((L) => !header.includes(L)) ?? null;
    if (text.length > 2400 || text.length < 160) continue; // keep windows small + non-trivial
    // GUARD: the unit must contain exactly one top-level `function ` (reject any leftover multi-def span)
    if ((text.match(/\bfunction\s+[A-Za-z0-9_]+\s*\(/g) || []).length !== 1) continue;
    out.push({ file, name, params, text, bodyLit });
  }
  return out;
}

function gather() {
  const files = [];
  for (const root of ROOTS) {
    let entries; try { entries = readdirSync(root); } catch { continue; }
    for (const f of entries) {
      const p = join(root, f);
      if (!f.endsWith(".js") || !statSync(p).isFile()) continue;
      files.push(p);
    }
  }
  const fns = [];
  for (const p of files) { try { fns.push(...extractFns(p, readFileSync(p, "utf8"))); } catch {} }
  return fns.filter((f) => f.bodyLit);                // need both needles
}

function ask(prompt) {
  try {
    return execFileSync("claude", ["-p", "--tools", "", "--model", MODEL],
      { input: prompt, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180000 }).trim();
  } catch (e) { return `__ERR__ ${e.message?.slice(0, 80)}`; }
}

const FILLER = "The agent has been working through the task; prior steps are summarized here.";
const promptFor = (units, q) => `You are an agent. Answer ONLY from the context below.

=== CONTEXT ===
${units.map((u) => `[${u.role}${u.compressed ? " · signature" : ""}]\n${u.content}`).join("\n\n")}
=== END CONTEXT ===

${q}
If the answer is not present in the context above, output exactly: CANNOT_DETERMINE`;

// build the three real assemble() views for one function; ASSERT the verb chose the expected tier
async function views(fn) {
  const code = { id: "code", role: "tool", kind: "code", format: "js", content: fn.text, tokensApprox: approx(fn.text) };
  const filler = { id: "filler", role: "assistant", content: FILLER, tokensApprox: approx(FILLER) };
  const sig = await compress({ text: fn.text, format: "js", symbol: fn.name }, { level: "signature" });
  const vTok = approx(fn.text), sTok = approx(sig), fTok = approx(FILLER);
  const budgets = { verbatim: fTok + vTok + 5, signature: fTok + sTok + 5, drop: fTok + 5 };
  const r = {};
  for (const tier of ["verbatim", "signature", "drop"]) {
    const out = await assemble([code, filler], { budget: budgets[tier] });
    const got = out.units.find((u) => u.id === "code");
    r[tier] = { units: out.units, codeKept: !!got, compressed: !!got?.compressed, content: got?.content };
  }
  // seam mechanic, asserted on real data: verbatim=whole, signature=compressed, drop=absent
  const ok = r.verbatim.codeKept && !r.verbatim.compressed
    && r.signature.codeKept && r.signature.compressed
    && !r.drop.codeKept;
  return { sig, vTok, sTok, tiers: r, mechanicOK: ok };
}

const fns = gather();
console.log(`Extracted ${fns.length} real functions (JSDoc + ≥2 params + body literal) from ${ROOTS.join(", ")}`);
const PICK = fns.slice(0, 8);

// ── Part 1: deterministic seam mechanics + REAL signature saving (no model) ─────────────────────────
console.log(`\n── Part 1: seam mechanics + real byte saving (deterministic) ──`);
console.log(`${"function".padEnd(26)} ${"verbatim".padStart(8)} ${"sig".padStart(5)} ${"save".padStart(6)}  mechanic`);
let mechAll = true, saveSum = 0;
const ready = [];
for (const fn of PICK) {
  const v = await views(fn);
  mechAll = mechAll && v.mechanicOK;
  const save = 1 - v.sTok / v.vTok; saveSum += save;
  console.log(`${(fn.name + " (" + fn.file.replace("../", "").replace("src/", "") + ")").slice(0, 26).padEnd(26)} ${String(v.vTok).padStart(8)} ${String(v.sTok).padStart(5)} ${(save * 100).toFixed(0).padStart(5)}%  ${v.mechanicOK ? "OK" : "FAIL"}`);
  ready.push({ fn, v });
}
console.log(`\nseam mechanic holds on all ${PICK.length}: ${mechAll}`);
console.log(`mean real signature saving: ${(saveSum / PICK.length * 100).toFixed(0)}%  (crafted-handler POC claimed 24%)`);

if (process.argv.includes("--part1")) { console.log("\n(--part1: skipping model run)"); process.exit(0); }

// ── Part 2: real model — does the signature carry the API answer that DROP loses? ───────────────────
// (Only the PARAMS metric — a body-needle was dropped: its first version mis-scored, verbatim 0/8, an
// ambiguous "the string literal" with several per body. The body LIMIT is already cleanly established by
// compress-middle-poc.mjs, body-needle signature 0/2 = drop. Not re-litigated here.)
console.log(`\n── Part 2: live model (claude -p ${MODEL}, tools off) — PARAMS retrieval ──`);
const hit = { verbatim: 0, signature: 0, drop: 0 };
console.log(`${"function".padEnd(22)} ${"v / s / d".padStart(12)}`);
for (const { fn, v } of ready) {
  const pQ = `List the parameter names of the function "${fn.name}" and, in one phrase, what it does.`;
  const res = {};
  for (const tier of ["verbatim", "signature", "drop"]) {
    const ans = ask(promptFor(v.tiers[tier].units, pQ)).toLowerCase();
    res[tier] = fn.params.every((p) => ans.includes(p.toLowerCase()));
    if (res[tier]) hit[tier]++;
  }
  const mk = (b) => (b ? "✓" : "·");
  console.log(`${fn.name.slice(0, 22).padEnd(22)} ${`${mk(res.verbatim)} / ${mk(res.signature)} / ${mk(res.drop)}`.padStart(12)}`);
}
const n = ready.length;
console.log(`\n── RESULT (n=${n}) ──`);
console.log(`PARAMS retrieved:  verbatim ${hit.verbatim}/${n}  signature ${hit.signature}/${n}  drop ${hit.drop}/${n}`);
console.log(`  → WIN cell = signature(${hit.signature}) vs drop(${hit.drop}); the tier earns its place iff signature ≫ drop.`);
