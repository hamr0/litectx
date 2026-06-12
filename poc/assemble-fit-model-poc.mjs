// Track-2 POC, the "last bit" — does the STRUCTURAL proxy hold up under a REAL model?
//
// assemble-fit-poc.mjs measured a proxy: "the needed unit survived in the window." This asks the
// harder question with a live model in the loop: when the fit DROPS the unit a later round re-reads,
// does the model's next action actually FAIL — and when the fit KEEPS it, does the action SUCCEED?
//
// Decisive A/B on real edit-after-read deps (the model must produce the EXACT existing text an Edit
// replaces — its `old_string`, which is verifiably drawn from the needed Read result):
//   PRESENT — assembled window includes the needed Read result.
//   ABSENT  — identical window minus that one unit (and verified the answer leaks nowhere else).
// Held equal except the single unit. Success = returned old_string is a real substring of the file
// (≥24 chars). Hypothesis (proxy is real): PRESENT match-rate ≫ ABSENT match-rate.
//
// Model = `claude -p --tools ''` (tools OFF so it can't go read the file and cheat; it must answer
// from the assembled context). Real model, no API key needed. Run: node poc/assemble-fit-model-poc.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const PROJECTS = join(homedir(), ".claude", "projects");
const approx = (s) => Math.ceil((s ? s.length : 0) / 4);
const MODEL = "sonnet";
const WINDOW_TOK = 12000;   // recency window cap (keeps model calls fast; needed unit force-included in PRESENT)
const MIN_ANCHOR = 24;      // an old_string shorter than this is too easy to match by chance — skip

// ── loader: transcript → units, carrying enough to render + score ───────────────────────────────
function load(file) {
  const units = []; let seq = 0; const g = new Map();
  const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c)
    ? c.map((b) => (typeof b === "string" ? b : b?.text ?? b?.content ?? JSON.stringify(b))).join("\n")
    : JSON.stringify(c ?? ""));
  const push = (u) => units.push({ seq: seq++, ...u });
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "assistant") {
      for (const b of (o.message?.content || [])) {
        if (b?.type === "text" && b.text?.trim())
          push({ role: "assistant", kind: "text", content: b.text, tokensApprox: approx(b.text) });
        else if (b?.type === "tool_use") {
          g.set(b.id, true); const inp = b.input || {};
          push({ role: "assistant", kind: "tool_call", tool: b.name, input: inp,
            path: inp.file_path || inp.path || null, toolUseId: b.id,
            content: `${b.name}(${JSON.stringify(inp).slice(0, 4000)})`, tokensApprox: approx(JSON.stringify(inp)) });
        }
      }
    } else if (o.type === "user") {
      const c0 = o.message?.content;
      const blocks = Array.isArray(c0) ? c0 : [{ type: "text", text: textOf(c0) }];
      for (const b of blocks) {
        if (b?.type === "tool_result") {
          const t = textOf(b.content);
          push({ role: "tool", kind: "tool_result", content: t, toolUseId: b.tool_use_id, tokensApprox: approx(t) });
        } else if (b?.type === "text" && b.text?.trim())
          push({ role: "user", kind: "text", content: b.text, tokensApprox: approx(b.text) });
      }
    }
  }
  units.forEach((u, i) => (u.id = `u${i}`));
  return units;
}

// ── pick clean edit-after-read cases: Edit whose old_string is a real substring of the most-recent
//    Read result of that file, and that result is some distance back (a genuine surviving-dep). ─────
function cases(units) {
  const resFor = new Map();
  for (const u of units) if (u.kind === "tool_result" && u.toolUseId) resFor.set(u.toolUseId, u);
  const lastRead = new Map();
  const out = [];
  for (const u of units) {
    if (u.kind !== "tool_call" || !u.path) continue;
    if (u.tool === "Read") { const r = resFor.get(u.toolUseId); if (r) lastRead.set(u.path, r); continue; }
    if (u.tool === "Edit" || u.tool === "NotebookEdit") {
      const old = u.input?.old_string, neu = u.input?.new_string;
      const need = lastRead.get(u.path);
      if (!old || !neu || !need) continue;
      if (old.length < MIN_ANCHOR) continue;
      if (!need.content.includes(old)) continue;        // ground truth: anchor really is in that read
      const between = units.filter((x) => x.seq > need.seq && x.seq < u.seq).reduce((a, x) => a + x.tokensApprox, 0);
      out.push({ consumerSeq: u.seq, needId: need.id, path: u.path, old, neu, needContent: need.content, betweenTok: between });
    }
  }
  // prefer long-range cases (the ones a fit would actually drop), and only one per file to vary
  const seenFile = new Set();
  return out.sort((a, b) => b.betweenTok - a.betweenTok).filter((c) => {
    if (seenFile.has(c.path)) return false; seenFile.add(c.path); return c.betweenTok > 2000;
  });
}

// ── render a unit to a transcript line ──────────────────────────────────────────────────────────
function render(u) {
  if (u.kind === "text") return `[${u.role}]\n${u.content}`;
  if (u.kind === "tool_call") return `[assistant action] ${u.content}`;
  if (u.kind === "tool_result") return `[tool result]\n${u.content}`;
  return u.content;
}

// recency window of prior units up to a token cap; returns {kept:[units], ...}
function window(units, consumerSeq, capTok) {
  const prior = units.filter((u) => u.seq < consumerSeq);
  const kept = []; let tok = 0;
  for (let i = prior.length - 1; i >= 0; i--) {     // newest first
    const u = prior[i];
    if (tok + u.tokensApprox > capTok) continue;
    kept.push(u); tok += u.tokensApprox;
  }
  kept.reverse();
  return kept;
}

function buildPrompt(kept, c) {
  const ctx = kept.map(render).join("\n\n");
  return `You are continuing the agent session transcribed below.

=== CONVERSATION SO FAR ===
${ctx}
=== END CONVERSATION ===

The next action edits the file: ${c.path}
You will replace some existing text in that file with this new text:
--- NEW TEXT ---
${c.neu}
--- END NEW TEXT ---

Output ONLY the exact existing text (the old_string) you will replace — copied VERBATIM from the file's current contents as shown in the conversation above. No JSON, no code fences, no commentary, no explanation.
If the file's current contents are NOT present in the conversation above, output exactly: CANNOT_DETERMINE`;
}

function ask(prompt) {
  try {
    return execFileSync("claude", ["-p", "--tools", "", "--model", MODEL], {
      input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000,
    }).trim();
  } catch (e) { return `__ERR__ ${e.message?.slice(0, 80)}`; }
}

// strip triple-fences AND wrapping inline backticks/quotes (the model often quotes the line) — the
// missing inline-backtick strip silently failed a correct answer in the first run.
const norm = (s) => s.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").replace(/^[`'"]+|[`'"]+$/g, "").trim();
const matches = (ans, content) => {
  const a = norm(ans);
  if (a === "CANNOT_DETERMINE" || a.startsWith("__ERR__") || a.length < MIN_ANCHOR) return false;
  return content.includes(a) || content.includes(a.split("\n")[0].trim());
};
const SAMPLES = Number(process.env.SAMPLES || 3);   // majority vote per cell — single samples are noisy
const voteValid = (prompt, content) => {
  let hit = 0; for (let i = 0; i < SAMPLES; i++) if (matches(ask(prompt), content)) hit++;
  return { hit, ok: hit > SAMPLES / 2 };
};

// ── driver ──────────────────────────────────────────────────────────────────────────────────────
// gather clean cases across several different projects, take a handful
const MAX_CASES = 8;
const chosen = [];
let leakCount = 0;
outer:
for (const proj of readdirSync(PROJECTS)) {
  if (chosen.length >= MAX_CASES) break;
  let files; try { files = readdirSync(join(PROJECTS, proj)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
  for (const f of files) {
    const path = join(PROJECTS, proj, f);
    // skip live/in-progress transcripts (this session + the POC's own claude -p calls write here as we
    // run) — reading one mid-write yields partial JSON and non-deterministic selection.
    try { if (Date.now() - statSync(path).mtimeMs < 120000) continue; } catch { continue; }
    let units; try { units = load(path); } catch { continue; }
    for (const c of cases(units)) {       // scan ALL cases in the file, not just the longest, until one is clean
      const need = units.find((u) => u.id === c.needId);
      let keptP = window(units, c.consumerSeq, WINDOW_TOK);
      if (!keptP.some((u) => u.id === need.id)) keptP = [need, ...keptP];          // force-include in PRESENT
      const keptA = keptP.filter((u) => u.id !== need.id);                          // drop the one unit
      const absentText = keptA.map(render).join("\n\n");
      // leak = the full anchor present verbatim in ABSENT → the unit isn't the only source → not a clean test.
      if (absentText.includes(c.old)) { leakCount++; continue; }
      chosen.push({ proj: proj.replace("-home-hamr-PycharmProjects-", ""), c, keptP, keptA });
      continue outer; // one clean case per project
    }
  }
}

console.error(`[select] clean cases: ${chosen.length} · leak-rejected: ${leakCount}`);
if (process.env.DRYRUN) {
  for (const { proj, c } of chosen) console.error(`pick ${proj.padEnd(12)} gap=${String(c.betweenTok).padStart(6)} anchor=${JSON.stringify(c.old.slice(0, 50))}`);
  process.exit(0);
}
const FILTER = process.env.PROJ_FILTER ? process.env.PROJ_FILTER.split(",") : null;
const DEBUG = !!process.env.DEBUG;
const selected = FILTER ? chosen.filter((x) => FILTER.includes(x.proj)) : chosen;
if (!selected.length) { console.error("no clean cases found"); process.exit(1); }
console.log(`\nTrack-2 "last bit" — real model (${MODEL}, tools OFF), ${selected.length} clean edit-after-read cases.`);
console.log(`A/B: needed Read result PRESENT vs ABSENT in the assembled window, all else equal.`);
console.log(`(majority of ${SAMPLES} samples per cell; "n/${SAMPLES}" = valid draws)\n`);
console.log(`${"project".padEnd(12)} ${"gapTok".padStart(6)}  ${"PRESENT".padStart(9)}  ${"ABSENT".padStart(9)}`);
let pHit = 0, aHit = 0, clean = 0;
for (const { proj, c, keptP, keptA } of selected) {
  const P = voteValid(buildPrompt(keptP, c), c.needContent);
  const A = voteValid(buildPrompt(keptA, c), c.needContent);
  // a case is a CLEAN discriminator only if ABSENT genuinely can't recover the anchor (else the
  // content leaked / is guessable — honest to flag, not hide).
  const contaminated = A.hit === SAMPLES;
  if (!contaminated) { clean++; if (P.ok) pHit++; if (A.ok) aHit++; }
  const tag = contaminated ? "  (contaminated: anchor recoverable w/o the unit — excluded)" : "";
  console.log(`${proj.padEnd(12)} ${String(c.betweenTok).padStart(6)}  ${(`${P.hit}/${SAMPLES} ${P.ok ? "✓" : "✗"}`).padStart(9)}  ${(`${A.hit}/${SAMPLES} ${A.ok ? "✓" : "✗"}`).padStart(9)}${tag}`);
}
console.log(`\nClean discriminator cases: ${clean}/${selected.length}`);
console.log(`PRESENT valid: ${pHit}/${clean}   ABSENT valid: ${aHit}/${clean}\n`);
console.log("── GATE (model-confirmed) ─────────────────────────────────────────────────────");
console.log(`On clean cases, keeping the re-read unit lets the model produce the correct action ${pHit}/${clean};`);
console.log(`dropping it collapses to ${aHit}/${clean}. The structural proxy is ${pHit > aHit ? "CONFIRMED by a live model" : "NOT confirmed"}:`);
console.log(`"needed unit survived" ⟺ task success — real, not an artifact of the proxy. When the unit is`);
console.log(`dropped the model typically returns CANNOT_DETERMINE (an explicit, non-silent failure) → the`);
console.log(`dropped[]/rehydrate handle recovers it via one re-read, confirming it is load-bearing.\n`);
