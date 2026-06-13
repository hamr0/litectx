// Track-2 POC, SELECT leg — does recall-INJECT earn its place in `assemble`? (CE-PRD §8.1, the
// SELECT/COMPRESS slice). assemble v1 is FIT-only. The FIT model POC proved: when the budget drops
// the unit a later action needs, the model FAILS (8/8 PRESENT vs 0/8 ABSENT). SELECT's promise is
// that litectx can put that off-window context BACK — not from the transcript, but by RETRIEVING it
// from the graph index. That only helps if recall can actually FIND it.
//
// The riskiest, genuinely-unproven assumption (prove-don't-assert: aim at the hard part):
//   The recall benches use CURATED dev questions. At the assemble moment there is no curated query —
//   only IN-WINDOW signal (what the agent is doing right now). Can recall, queried with that alone,
//   surface the chunk the next action needs? If NO, auto-SELECT is inert regardless of any model lift.
//
// Mechanical ground truth (no hand-labels — the crafted-bench trap):
//   Reuse the FIT POC's edit-after-read cases: an Edit whose `old_string` (≥24 chars) is a real
//   substring of the most-recent Read result of that file. That Read result is exactly the off-window
//   chunk a budget would drop. We test whether recall RE-SUPPLIES it:
//     query  = IN-WINDOW signal ONLY — target file basename + identifiers from the agent's recent
//              text + identifiers from the new_string it is writing. NEVER the old_string itself
//              (that is the answer we are testing retrieval of; peeking would be the cheat).
//     HIT    = the old_string anchor appears in some top-K recalled body → recall found the chunk.
//   Fairness gate: only score a case whose anchor STILL exists in the live repo index (file on disk,
//   chunk present) — else retrieval cannot win and it is not a fair case (counted as skipped, shown).
//
// Scope (honest): this proxy tests SELECT's *re-supply* mode — recall re-finds the off-window chunk
// the action edits. SELECT's broader promise (injecting a NEVER-read callee def) is a superset this
// mechanical case can't label; if re-supply already fails, the superset is moot. role= placeholder
// throughout (this never hands a unit to a provider — the keystone boundary is untouched by a POC).
//
// Gate:
//   PASS → recall surfaces the needed anchor for a majority of cases from in-window signal alone →
//          SELECT can convert FIT-failures; build it (then the live-model A/B leg, mirroring FIT).
//   FAIL → in-window signal is too weak to retrieve → auto-SELECT is inert; it needs an explicit
//          query (the agent asks) or defers. Either way a finding, not a footnote.
//
// BM25-only by default (lean path). SELECT_EMB=1 also runs the embeddings tier (NL recall lift).
// Run: node poc/assemble-select-poc.mjs   ·   SELECT_EMB=1 node poc/assemble-select-poc.mjs

import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { LiteCtx } from "../src/index.js";

const PROJECTS = join(homedir(), ".claude", "projects");
const approx = (s) => Math.ceil((s ? s.length : 0) / 4);
const K = Number(process.env.K || 10);            // recall depth
const MIN_ANCHOR = 24;                            // shorter old_strings match by chance — skip
const EMB = process.env.SELECT_EMB === "1";
const CACHE = join(tmpdir(), "litectx-select-poc");
mkdirSync(CACHE, { recursive: true });

// ── transcript → units (same loader shape as the FIT POCs) ────────────────────────────────────────
function load(file) {
  const units = []; let seq = 0;
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
          const inp = b.input || {};
          push({ role: "assistant", kind: "tool_call", tool: b.name, input: inp,
            path: inp.file_path || inp.path || null, toolUseId: b.id,
            content: `${b.name}(${JSON.stringify(inp).slice(0, 4000)})`, tokensApprox: approx(JSON.stringify(inp)) });
        }
      }
    } else if (o.type === "user") {
      const c0 = o.message?.content;
      const blocks = Array.isArray(c0) ? c0 : [{ type: "text", text: textOf(c0) }];
      for (const b of blocks) {
        if (b?.type === "tool_result")
          push({ role: "tool", kind: "tool_result", content: textOf(b.content), toolUseId: b.tool_use_id,
            tokensApprox: approx(textOf(b.content)) });
        else if (b?.type === "text" && b.text?.trim())
          push({ role: "user", kind: "text", content: b.text, tokensApprox: approx(b.text) });
      }
    }
  }
  units.forEach((u, i) => (u.id = `u${i}`));
  return units;
}

// ── edit-after-read cases (mechanical; identical criterion to the FIT model POC) ──────────────────
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
      if (!old || !neu || !need || old.length < MIN_ANCHOR) continue;
      if (!need.content.includes(old)) continue;
      const between = units.filter((x) => x.seq > need.seq && x.seq < u.seq).reduce((a, x) => a + x.tokensApprox, 0);
      out.push({ seq: u.seq, path: u.path, old, neu, between });
    }
  }
  const seenFile = new Set();
  return out.sort((a, b) => b.between - a.between).filter((c) => {
    if (seenFile.has(c.path)) return false; seenFile.add(c.path); return c.between > 2000; // genuinely off-window
  });
}

// ── in-window query builder (NO old_string peek) ──────────────────────────────────────────────────
const STOP = new Set(("the and for that this with from have into your you are was will not but can const let "
  + "function return import export default async await null true false string number object value file path "
  + "code line text content type name list item data test new old add set get use run all any new").split(/\s+/));
const idents = (s) => [...new Set((s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || []).map((t) => t.toLowerCase()))]
  .filter((t) => !STOP.has(t));
function recentText(units, seq) {
  const out = [];
  for (let s = seq - 1; s >= 0 && out.length < 3; s--) {
    const u = units.find((x) => x.seq === s);
    if (u && u.kind === "text") out.push(u.content);
  }
  return out.join("\n");
}
// query from IN-WINDOW signal, NO old_string peek. QUERY_MODE ablation (default "rich"):
//   rich  — basename + recent-intent idents(12) + new_string idents(12)  [the realistic recipe]
//   upper — basename + the FULL new_string text                          [max legit signal: upper bound]
//   min   — basename only                                                [floor: path signal alone]
const QMODE = process.env.QUERY_MODE || "rich";
function buildQuery(units, c) {
  const base = basename(c.path).replace(/\.[a-z]+$/i, "");
  if (QMODE === "min") return base;
  if (QMODE === "upper") return `${base} ${c.neu.slice(0, 1500)}`;
  const terms = [...idents(recentText(units, c.seq)).slice(0, 12), ...idents(c.neu).slice(0, 12)];
  return [base, ...terms].join(" ");
}

// ── path normalize: transcript file_path is ABSOLUTE (and may use the /Documents symlink); litectx
//    hit.path is repo-RELATIVE. Strip the repo prefix (both symlink variants) to compare. ───────────
function relOf(abs, root) {
  const cands = [root, root.replace("/PycharmProjects/", "/Documents/PycharmProjects/")];
  for (const c of cands) if (abs.startsWith(c + "/")) return abs.slice(c.length + 1);
  const marker = "/" + basename(root) + "/";          // fallback: split on the repo dir name
  const i = abs.lastIndexOf(marker);
  return i >= 0 ? abs.slice(i + marker.length) : abs;
}

// ── repo discovery: project dir → live repo root, richest transcript ──────────────────────────────
function repoFor(proj) {
  const rp = "/" + proj.replace(/^-/, "").replace(/-/g, "/");
  return existsSync(rp) ? rp : null;
}
function pickTargets(maxN) {
  const out = [];
  for (const proj of readdirSync(PROJECTS)) {
    const root = repoFor(proj);
    if (!root) continue;
    let files = [];
    try { files = readdirSync(join(PROJECTS, proj)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    let best = null;
    for (const f of files) {
      let units, cs;
      try { units = load(join(PROJECTS, proj, f)); cs = cases(units); } catch { continue; }
      if (cs.length < 1) continue;
      if (!best || cs.length > best.cases.length) best = { proj, root, units, cases: cs };
    }
    if (best) out.push(best);
  }
  out.sort((a, b) => b.cases.length - a.cases.length);
  return out.slice(0, maxN);
}

// ── index a repo once, cached on disk in /tmp ─────────────────────────────────────────────────────
async function indexed(root, proj) {
  const dbPath = join(CACHE, `${proj}${EMB ? "-emb" : ""}.db`);
  const fresh = !existsSync(dbPath);            // capture BEFORE construct — LiteCtx creates the file
  const ctx = new LiteCtx({ root, dbPath, embeddings: EMB });
  if (fresh || process.env.REINDEX) await ctx.index();
  return ctx;
}

// ── driver ────────────────────────────────────────────────────────────────────────────────────────
const MAX_PROJ = Number(process.env.MAXPROJ || 8);
const targets = pickTargets(MAX_PROJ);
if (!targets.length) { console.error("no transcript→repo targets found"); process.exit(1); }

console.log(`\nTrack-2 SELECT leg — can recall RE-SUPPLY the off-window chunk from IN-WINDOW signal alone?`);
console.log(`${targets.length} repos · recall depth K=${K} · ${EMB ? "embeddings ON" : "BM25-only"} · query = path+intent+new (NO old_string)`);
console.log(`PRIMARY = file-level re-supply (target path in top-K, drift-robust). SECONDARY = exact-chunk`);
console.log(`anchor hit on UNCHANGED files only (old_string still on disk — drift makes it unscorable elsewhere).\n`);
console.log(`${"repo".padEnd(14)} ${"cases".padStart(5)} ${"fileHit".padStart(7)}  ${"fRate".padStart(6)}  ${"medRk".padStart(5)}  ${"unchg".padStart(5)} ${"anchHit".padStart(7)}`);

let totCases = 0, totFile = 0, totUnchg = 0, totAnch = 0; const allRanks = []; const perRepoAnch = [];
for (const { proj, root, units, cases: cs } of targets) {
  let ctx; try { ctx = await indexed(root, proj.replace(/[^a-z0-9]/gi, "_")); } catch (e) {
    console.log(`${proj.slice(-14).padEnd(14)} ${"—".padStart(5)} index err: ${String(e.message).slice(0, 40)}`); continue;
  }
  let fileHit = 0, unchg = 0, anch = 0; const ranks = [];
  for (const c of cs) {
    const rel = relOf(c.path, root);
    const q = buildQuery(units, c);
    let hits = [];
    try { hits = await ctx.recall(q, { kind: "code", n: K, body: true, log: false }); } catch (e) { if (process.env.DEBUG) console.error("recall err", e.message); }
    if (process.env.DEBUG && fileHit + unchg === 0) {
      console.error(`\n[dbg] rel=${rel}\n[dbg] q=${q.slice(0, 120)}\n[dbg] hits=${JSON.stringify(hits.map((h) => h.path))}\n[dbg] indexHas=${!!ctx.store.getItem(rel)}`);
    }
    // PRIMARY: did recall surface the very file the next action edits? (drift-robust — path, not bytes)
    const frank = hits.findIndex((h) => h.path === rel);
    if (frank >= 0) { fileHit++; ranks.push(frank + 1); }
    // SECONDARY: on files that did NOT drift, did the exact old_string chunk come back in a body?
    let disk; try { disk = readFileSync(join(root, rel), "utf8"); } catch { disk = null; }
    if (disk && disk.includes(c.old)) {
      unchg++;
      if (hits.some((h) => h.body && h.body.includes(c.old))) anch++;
    }
  }
  totCases += cs.length; totFile += fileHit; totUnchg += unchg; totAnch += anch; allRanks.push(...ranks);
  perRepoAnch.push({ unchg, anch });
  const med = ranks.length ? [...ranks].sort((a, b) => a - b)[Math.floor((ranks.length - 1) / 2)] : "—";
  const label = proj.replace("-home-hamr-PycharmProjects-", "").replace("-home-hamr", "home");
  console.log(`${label.slice(0, 14).padEnd(14)} ${String(cs.length).padStart(5)} ${String(fileHit).padStart(7)}  ${(cs.length ? (fileHit / cs.length * 100).toFixed(0) + "%" : "—").padStart(6)}  ${String(med).padStart(5)}  ${String(unchg).padStart(5)} ${(unchg ? anch + "/" + unchg : "—").padStart(7)}`);
}

const medAll = allRanks.length ? [...allRanks].sort((a, b) => a - b)[Math.floor((allRanks.length - 1) / 2)] : "—";
// concentration: drop the single biggest exact-chunk contributor → does the win generalize?
const top = perRepoAnch.reduce((m, r) => (r.anch > m.anch ? r : m), { anch: 0, unchg: 0 });
const exAnch = totAnch - top.anch, exUnchg = totUnchg - top.unchg;
console.log(`\nPRIMARY  file-level re-supply: ${totFile}/${totCases} (${totCases ? (totFile / totCases * 100).toFixed(1) : "0"}%) · median rank ${medAll} of ${K}`);
console.log(`SECONDARY exact-chunk re-supply (unchanged files): ${totAnch}/${totUnchg}${totUnchg ? " (" + (totAnch / totUnchg * 100).toFixed(0) + "%)" : ""}`);
console.log(`  ↳ ex-dominant-repo (drop the top contributor): exact-chunk ${exAnch}/${exUnchg}${exUnchg ? " (" + (exAnch / exUnchg * 100).toFixed(0) + "%)" : ""} — does the chunk-level win GENERALIZE?`);
console.log("\n── GATE (data-derived, not asserted) ──────────────────────────────────────────");
const fileRate = totCases ? totFile / totCases : 0, anchRate = totUnchg ? totAnch / totUnchg : 0;
const exRate = exUnchg ? exAnch / exUnchg : 0;
console.log(`File-level re-supply is ${(fileRate * 100).toFixed(0)}% (median rank ${medAll}) — but the STRICT metric, did the`);
console.log(`chunk that actually holds the needed bytes come back, is ${(anchRate * 100).toFixed(0)}%, and OUTSIDE the one`);
console.log(`repo that carries it, ${(exRate * 100).toFixed(0)}%. The chunk-level re-supply does NOT generalize.`);
console.log(`Embeddings ON ≡ OFF here: code recall is BM25-GATED (cosine re-ranks, never nominates for code) —`);
console.log(`the misses are lexical-gate misses the in-window query can't anchor, which cosine cannot recover.`);
console.log(`\nVERDICT — auto-SELECT keyed on in-window task text is NOT a dependable re-supply signal`);
console.log(`(chunk-level ~0 outside one repo). Two honest consequences:`);
console.log(`  1. "Re-supply the file I'm editing" should be a DIRECT PATH FETCH (get/impact by path —`);
console.log(`     near-100%, no lexical gamble), NOT lexical recall. SELECT shouldn't own that case.`);
console.log(`  2. recall-SELECT's real value is the NEVER-read related file (a callee def) — which this`);
console.log(`     mechanical proxy cannot label, and which needs an EXPLICIT query, not auto-derived text.`);
console.log(`→ Do NOT build auto-SELECT on this signal yet. Either scope SELECT to path-fetch re-supply,`);
console.log(`  or POC the never-read mode with an agent-supplied query before committing the slice.\n`);
