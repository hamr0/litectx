// THROWAWAY POC — §4.5 gate #1, REBUILT on REAL data (2026-06-13): is `session` load-bearing?
//
// The first version of this POC used a corpus I crafted to overlap — which made intrusion a property
// of my authoring, not a finding (a rigged bench; see git history / the user's challenge). This rebuild
// uses REAL, uncrafted data: episodes extracted from this repo's actual Claude Code session transcripts
// (~/.claude/projects/<repo>/*.jsonl) — ~13 real multi-turn work sessions spanning 06-05..06-13, all on
// litectx (so naturally high vocabulary overlap), each with its own real sub-topics and real timestamps.
//
// The literal §4.5.1 test: recall a query (a) over ONLY the current session's episodes vs (b) over ALL
// sessions' episodes. Do the current session's top results CHANGE when other sessions are present?
//   - no change → other sessions sank → the column is BLOAT
//   - foreign episodes displace the current session's → LOAD-BEARING
// Two regimes: A = real timestamps (sequential/solo — litectx's actual deployment, current session is
// newest), B = concurrent (current + foreign stamped co-recent — the multi-agent stress where recency
// can't separate). The query is drawn from the CURRENT session's own topics, so own-session is the
// correct answer by construction AND the test is conservative (biased toward the current session holding,
// i.e. toward "bloat" — load-bearing only shows if foreign displaces despite that bias).
//
// Run: node poc/scope-session-poc.mjs   ( --debug to inspect extraction/recall )

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { LiteCtx } from "../src/index.js";

const DEBUG = process.argv.includes("--debug");
const MIN = 60_000, HOUR = 3_600_000;
const NOW = Date.now();
const TOPK = 5;
const N_SESSIONS = 12; // most recent completed real sessions
const MAX_EP_PER_SESSION = 25;

const PROJ = join(homedir(), ".claude", "projects", "-home-hamr-PycharmProjects-litectx");

// ── extract real episodes (substantive user turns) per real session, with real timestamps ──────────
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => b.text || "").join(" ");
  return "";
}
function isSubstantive(t) {
  if (!t || t.length < 20) return false;
  if (/^[/<]/.test(t)) return false; // slash-cmds, system tags, file paths
  if (/^Caveat:/.test(t)) return false;
  if (t.startsWith("/**")) return false; // POC-spawned ledger-pipeline prompts
  if (/Handles the \w+ pipeline/.test(t)) return false;
  return true;
}
function loadSessions() {
  const files = readdirSync(PROJ)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, p: join(PROJ, f), m: statSync(join(PROJ, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const sessions = [];
  for (const { f, p } of files) {
    let lines;
    try { lines = readFileSync(p, "utf8").split("\n").filter(Boolean); } catch { continue; }
    const eps = [];
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.message?.role !== "user" || !o.timestamp) continue;
      const t = textOf(o.message.content).replace(/\s+/g, " ").trim();
      if (!isSubstantive(t)) continue;
      eps.push({ text: t.slice(0, 400), ts: Date.parse(o.timestamp) });
      if (eps.length >= MAX_EP_PER_SESSION) break;
    }
    if (eps.length >= 5) sessions.push({ id: f.slice(0, 8), eps, newest: Math.max(...eps.map((e) => e.ts)) });
    if (sessions.length >= N_SESSIONS + 1) break;
  }
  // drop the most-recent session (this live, in-progress one) so we don't test against partial state
  sessions.sort((a, b) => b.newest - a.newest);
  return sessions.slice(1, 1 + N_SESSIONS);
}

// real repo topics that genuinely recur across sessions (grounded in observed transcript content)
const TOPIC_QUERIES = [
  "assemble budget fit verb token transcript",
  "embeddings paraphrase recall model transformers",
  "memory socket store adapter liteCtxAsStore",
  "compress signature tier render bytes",
  "impact blast radius callers risk",
  "mcp server versus direct function call",
  "prd update validate delivery claims",
  "scope session isolation worktree owner",
  "promotion ladder episode to fact candidate",
  "publish release npm version tag",
];

// shift real timestamps into a recent window preserving relative spacing (so ACT-R decay doesn't nuke
// old sessions purely by absolute age — we want the *relative* recency of real history, near "now").
function shiftTs(sessions, mode, currentId) {
  const all = sessions.flatMap((s) => s.eps.map((e) => e.ts));
  const max = Math.max(...all);
  const out = {};
  for (const s of sessions) {
    out[s.id] = s.eps.map((e) => {
      if (mode === "concurrent") {
        // B: current + all foreign stamped co-recent (last 15 min, interleaved) — true concurrency
        return NOW - (5 + Math.random() * 10) * MIN;
      }
      // A: preserve TRUE real spacing — newest ≈ now-5min, older sessions at their real age (days),
      //    so ACT-R old-age decay applies realistically (the solo-sequential reality).
      return NOW - 5 * MIN - (max - e.ts);
    });
  }
  return out;
}

async function build(sessions, includeForeign, currentId, tsMap, embeddings) {
  const root = mkdtempSync(join(tmpdir(), "litectx-scope-real-"));
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings });
  for (const s of sessions) {
    if (!includeForeign && s.id !== currentId) continue;
    for (let i = 0; i < s.eps.length; i++) {
      await ctx.remember(`${s.id}:${i}`, s.eps[i].text, {
        kind: "episode", by: "agent", occurredAt: tsMap[s.id][i], meta: { session: s.id },
      });
    }
  }
  return { ctx, root };
}
async function recall(store, q) {
  const hits = await store.ctx.recall(q, { kind: "episode", n: TOPK });
  return hits.map((h) => ({ id: h.path, sess: h.meta?.session, score: +(h.score ?? 0).toFixed(2) }));
}
function close(store) { store.ctx.close(); rmSync(store.root, { recursive: true, force: true }); }

async function runRegime(sessions, mode, embeddings) {
  const currentId = sessions[0].id; // most recent of the test set = the "current run"
  const tsMap = shiftTs(sessions, mode, currentId);
  const all = await build(sessions, true, currentId, tsMap, embeddings);
  const isoStore = await build(sessions, false, currentId, tsMap, embeddings);

  let scored = 0, displaced = 0, foreignTotal = 0, ownSurvivedTotal = 0, ownPossibleTotal = 0, rank1Foreign = 0;
  const rows = [];
  for (const q of TOPIC_QUERIES) {
    const iso = await recall(isoStore, q);     // current-session-only (what the column gives)
    if (iso.length === 0) continue;            // current session didn't work on this topic → skip (own-correct only)
    const full = await recall(all, q);         // all sessions (today's behaviour)
    scored++;
    const foreignInFull = full.filter((h) => h.sess !== currentId).length;
    const ownSurvived = iso.filter((h) => full.some((f) => f.id === h.id)).length;
    const r1Foreign = full.length > 0 && full[0].sess !== currentId;
    foreignTotal += foreignInFull;
    ownSurvivedTotal += ownSurvived;
    ownPossibleTotal += iso.length;
    if (r1Foreign) rank1Foreign++;
    if (foreignInFull > 0 && ownSurvived < iso.length) displaced++;
    rows.push({ q: q.slice(0, 34), isoN: iso.length, foreign: foreignInFull, ownSurv: `${ownSurvived}/${iso.length}`, r1: r1Foreign ? full[0].sess : currentId });
    if (DEBUG) {
      console.log(`  Q "${q.slice(0, 40)}"`);
      console.log(`     iso(${currentId}): ${iso.map((h) => h.id + ":" + h.score).join(", ")}`);
      console.log(`     full:           ${full.map((h) => h.sess + ":" + h.score).join(", ")}`);
    }
  }
  close(all); close(isoStore);
  return { mode, embeddings, currentId, scored, displaced, foreignTotal, ownSurvivedTotal, ownPossibleTotal, rank1Foreign, rows };
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
const sessions = loadSessions();
console.log(`Loaded ${sessions.length} real sessions: ${sessions.map((s) => `${s.id}(${s.eps.length})`).join(" ")}`);
console.log(`Current ("asking") session = ${sessions[0].id} (most recent of the set)\n`);

const results = [];
for (const mode of ["real", "concurrent"]) {
  for (const emb of [false, true]) {
    const r = await runRegime(sessions, mode, emb);
    results.push(r);
    const ownHold = r.ownPossibleTotal ? (100 * r.ownSurvivedTotal / r.ownPossibleTotal).toFixed(0) : "—";
    console.log(`\n===== regime=${mode.toUpperCase().padEnd(10)} embeddings=${emb ? "ON " : "OFF"} =====`);
    if (DEBUG) for (const row of r.rows) console.log(`   ${row.q.padEnd(36)} foreign=${row.foreign} ownHeld=${row.ownSurv} rank1=${row.r1}`);
    console.log(`   scored topics: ${r.scored}  · current session = ${r.currentId}`);
    console.log(`   own-session top-${TOPK} HELD when foreign added: ${r.ownSurvivedTotal}/${r.ownPossibleTotal} (${ownHold}%)`);
    console.log(`   foreign episodes intruding top-${TOPK} (summed): ${r.foreignTotal}`);
    console.log(`   queries where rank-1 became a FOREIGN session: ${r.rank1Foreign}/${r.scored}`);
    console.log(`   queries where foreign DISPLACED an own episode: ${r.displaced}/${r.scored}`);
  }
}

console.log(`\n================= VERDICT =================`);
for (const r of results) {
  const hold = r.ownPossibleTotal ? (100 * r.ownSurvivedTotal / r.ownPossibleTotal).toFixed(0) : "—";
  console.log(`${r.mode.padEnd(10)} emb=${r.embeddings ? "ON " : "OFF"}: own-held ${hold}%  · rank1-stolen ${r.rank1Foreign}/${r.scored}  · displaced ${r.displaced}/${r.scored}`);
}
console.log(
  `\nRead: REAL regime = litectx's solo sequential deployment (current session newest). If own-session\n` +
  `top-${TOPK} HOLDS there (foreign sinks via recency), the column is REDUNDANT for solo use. CONCURRENT\n` +
  `regime = the multi-agent stress (foreign co-recent). If own-held collapses there, the column is\n` +
  `LOAD-BEARING only for true concurrency. If own-held stays high in BOTH → BLOAT. If it's low in\n` +
  `REAL too → LOAD-BEARING everywhere.`,
);
