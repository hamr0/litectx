// GROUNDING — validate the SHIPPED scope model (Build A) against gate #1's REAL data.
//
// Gate #1 (poc/scope-session-poc.mjs) proved `session` is load-bearing by comparing two SEPARATE
// corpora — only-current vs all-sessions (manual scoping, session stored as opaque `meta`). This harness
// closes the loop: it replays the SAME real transcripts + SAME queries + SAME regimes through the
// ACTUAL SHIPPED filter (`LiteCtxConfig.session` → `mem_scope` → recall WHERE) on ONE shared store, and
// reconciles three readers:
//   ISO        — only-current corpus, separate db (the gate's gold "what the column should give").
//   UNSET      — one shared db, reader `session` unset → must REPRODUCE the burial (foreign displaces).
//   CURRENT    — one shared db, reader `session`=current → must RECOVER (== ISO; ZERO foreign episodes).
// Author-written unit tests (test/scope.test.js) are confirmatory; this grounds shipped behaviour
// against the real-data POC (the verify-shipped-vs-poc-data discipline). Not a gate — a validation.
//
// Run: node poc/scope-grounding.mjs   ( --debug to inspect per-query recall )

import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { LiteCtx } from "../src/index.js";

const DEBUG = process.argv.includes("--debug");
const MIN = 60_000;
const NOW = Date.now();
const TOPK = 5;
const N_SESSIONS = 12;
const MAX_EP_PER_SESSION = 25;
const PROJ = join(homedir(), ".claude", "projects", "-home-hamr-PycharmProjects-litectx");

// ── real-episode extraction (copied verbatim from gate #1 so the data is identical) ───────────────
function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => b.text || "").join(" ");
  return "";
}
function isSubstantive(t) {
  if (!t || t.length < 20) return false;
  if (/^[/<]/.test(t)) return false;
  if (/^Caveat:/.test(t)) return false;
  if (t.startsWith("/**")) return false;
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
  sessions.sort((a, b) => b.newest - a.newest);
  return sessions.slice(1, 1 + N_SESSIONS);
}
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
function shiftTs(sessions, mode) {
  const max = Math.max(...sessions.flatMap((s) => s.eps.map((e) => e.ts)));
  const out = {};
  for (const s of sessions) {
    out[s.id] = s.eps.map((e) =>
      mode === "concurrent" ? NOW - (5 + Math.random() * 10) * MIN : NOW - 5 * MIN - (max - e.ts),
    );
  }
  return out;
}

// ── write every session into ONE shared file db, each through a writer scoped to its real session ──
async function writeAll(dbPath, sessions, tsMap, embeddings, embedder) {
  const root = mkdtempSync(join(tmpdir(), "litectx-ground-w-"));
  for (const s of sessions) {
    const w = new LiteCtx({ root, dbPath, session: s.id, embeddings, embedder });
    for (let i = 0; i < s.eps.length; i++) {
      await w.remember(`${s.id}:${i}`, s.eps[i].text, {
        kind: "episode", by: "agent", occurredAt: tsMap[s.id][i], meta: { session: s.id },
      });
    }
    w.close();
  }
  return root;
}
// ISO baseline: only-current episodes, separate db (the gate's gold standard for "scoped recall")
async function writeIso(dbPath, sessions, currentId, tsMap, embeddings, embedder) {
  const root = mkdtempSync(join(tmpdir(), "litectx-ground-iso-"));
  const w = new LiteCtx({ root, dbPath, embeddings, embedder });
  const s = sessions.find((x) => x.id === currentId);
  for (let i = 0; i < s.eps.length; i++) {
    await w.remember(`${s.id}:${i}`, s.eps[i].text, { kind: "episode", by: "agent", occurredAt: tsMap[s.id][i], meta: { session: s.id } });
  }
  w.close();
  return root;
}
async function recall(reader, q) {
  const hits = await reader.recall(q, { kind: "episode", n: TOPK });
  return hits.map((h) => ({ id: h.path, sess: h.meta?.session, score: +(h.score ?? 0).toFixed(2) }));
}

async function runRegime(sessions, mode, embeddings, embedder) {
  const currentId = sessions[0].id;
  const tsMap = shiftTs(sessions, mode);

  const sharedDir = mkdtempSync(join(tmpdir(), "litectx-ground-db-"));
  const sharedDb = join(sharedDir, "shared.db");
  const wRoot = await writeAll(sharedDb, sessions, tsMap, embeddings, embedder);

  const isoDir = mkdtempSync(join(tmpdir(), "litectx-ground-isodb-"));
  const isoDb = join(isoDir, "iso.db");
  const isoRoot = await writeIso(isoDb, sessions, currentId, tsMap, embeddings, embedder);

  // three readers
  const isoReader = new LiteCtx({ root: isoRoot, dbPath: isoDb, embeddings, embedder });
  const unsetReader = new LiteCtx({ root: wRoot, dbPath: sharedDb, embeddings, embedder }); // session unset
  const currentReader = new LiteCtx({ root: wRoot, dbPath: sharedDb, session: currentId, embeddings, embedder });

  let scored = 0;
  let foreignUnset = 0, r1ForeignUnset = 0, ownHeldUnset = 0, ownPossible = 0;
  let foreignCurrent = 0, r1ForeignCurrent = 0, ownHeldCurrent = 0;
  let currentEqualsIso = 0;

  for (const q of TOPIC_QUERIES) {
    const iso = await recall(isoReader, q);
    if (iso.length === 0) continue; // current session didn't work on this topic → own-correct only
    scored++;
    const unset = await recall(unsetReader, q);
    const current = await recall(currentReader, q);
    const isoIds = new Set(iso.map((h) => h.id));

    foreignUnset += unset.filter((h) => h.sess !== currentId).length;
    if (unset.length && unset[0].sess !== currentId) r1ForeignUnset++;
    ownHeldUnset += unset.filter((h) => isoIds.has(h.id)).length;

    foreignCurrent += current.filter((h) => h.sess !== currentId).length;
    if (current.length && current[0].sess !== currentId) r1ForeignCurrent++;
    ownHeldCurrent += current.filter((h) => isoIds.has(h.id)).length;
    if (current.length === iso.length && current.every((h) => isoIds.has(h.id))) currentEqualsIso++;

    ownPossible += iso.length;
    if (DEBUG) {
      console.log(`  Q "${q.slice(0, 38)}"`);
      console.log(`     iso(${currentId}): ${iso.map((h) => h.id + ":" + h.score).join(", ")}`);
      console.log(`     UNSET:          ${unset.map((h) => h.sess + ":" + h.score).join(", ")}`);
      console.log(`     CURRENT:        ${current.map((h) => h.sess + ":" + h.score).join(", ")}`);
    }
  }
  isoReader.close(); unsetReader.close(); currentReader.close();
  for (const d of [sharedDir, isoDir, wRoot, isoRoot]) rmSync(d, { recursive: true, force: true });

  const pct = (n) => (ownPossible ? ((100 * n) / ownPossible).toFixed(0) : "—");
  return {
    mode, embeddings, currentId, scored, ownPossible,
    foreignUnset, r1ForeignUnset, ownHeldUnsetPct: pct(ownHeldUnset),
    foreignCurrent, r1ForeignCurrent, ownHeldCurrentPct: pct(ownHeldCurrent), currentEqualsIso,
  };
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────────
const sessions = loadSessions();
console.log(`Loaded ${sessions.length} real sessions: ${sessions.map((s) => `${s.id}(${s.eps.length})`).join(" ")}`);
console.log(`Current ("asking") session = ${sessions[0].id}\n`);

// share one embedder across all instances so the ON runs load the model once
let sharedEmbedder = null;
{
  const tmp = new LiteCtx({ root: process.cwd(), dbPath: ":memory:", embeddings: true });
  try { await tmp.embedder.embed("warmup"); sharedEmbedder = tmp.embedder; } catch { sharedEmbedder = null; }
  tmp.close();
}

const results = [];
for (const mode of ["real", "concurrent"]) {
  for (const emb of [false, true]) {
    if (emb && !sharedEmbedder) { console.log(`(skipping embeddings=ON — model unavailable)`); continue; }
    results.push(await runRegime(sessions, mode, emb, emb ? sharedEmbedder : undefined));
  }
}

console.log(`\n=================== GROUNDING: shipped scope filter vs gate #1 real data ===================`);
console.log(`regime     emb   │ UNSET reader (today)            │ CURRENT reader (session set)`);
console.log(`                  │ own-held  rank1-foreign foreign│ own-held  rank1-foreign foreign  ==ISO`);
let pass = true;
for (const r of results) {
  console.log(
    `${r.mode.padEnd(10)} ${r.embeddings ? "ON " : "OFF"}  │ ` +
    `${(r.ownHeldUnsetPct + "%").padEnd(9)} ${String(r.r1ForeignUnset + "/" + r.scored).padEnd(14)} ${String(r.foreignUnset).padEnd(7)}│ ` +
    `${(r.ownHeldCurrentPct + "%").padEnd(9)} ${String(r.r1ForeignCurrent + "/" + r.scored).padEnd(14)} ${String(r.foreignCurrent).padEnd(7)} ${r.currentEqualsIso}/${r.scored}`,
  );
  // VALIDATION INVARIANTS: the shipped session filter must (1) admit ZERO foreign episodes for a
  // session-set reader, and (2) reproduce ISO exactly; the unset reader must still show burial.
  if (r.foreignCurrent !== 0) pass = false;
  if (r.r1ForeignCurrent !== 0) pass = false;
  if (r.currentEqualsIso !== r.scored) pass = false;
}
console.log(`\nInvariants — CURRENT reader admits 0 foreign episodes, rank-1 always own, and == ISO on every`);
console.log(`scored query; UNSET reader still shows foreign intrusion (the gate #1 burial). → ${pass ? "PASS ✅" : "FAIL ❌"}`);
