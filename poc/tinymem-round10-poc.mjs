// Throwaway POC: round 10 — unstemmed per-section doc path (the proposal as specified).
// Sections = litectx's own md chunker, each stored as its own `doc` row (unstemmed `docs` FTS) via remember(), embeddings ON.
// C1 BM25 only | C2 shipped doc recall (BM25 pool, cosine re-ranks only) | C3 BM25 pool UNION top-K cosine nominees, fused like fact/episode.
// Outputs only to ~/.cache/tinymem-probe/out/stage10/. Nothing in src/ is modified.
import { LiteCtx } from '../src/index.js';
import { chunkFile } from '../src/chunker.js';
import { ftsMatch } from '../src/tokenize.js';
import { cosine } from '../src/embedder.js';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, statSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = join(homedir(), '.cache/tinymem-probe/out');
const S7 = join(BASE, 'stage7b'), S8 = join(BASE, 'stage8'), S9 = join(BASE, 'stage9'), OUT = join(BASE, 'stage10'), CORPUS = join(S7, 'corpus');
mkdirSync(join(OUT, 'root'), { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const chkHash = (p, h) => { if (sha(readFileSync(p)) !== h) throw new Error('hash mismatch ' + p); };
chkHash(join(S7, 'questions.json'), '2c38c60040edbcecf277956e4899b335c1119e30e6d039f1679fd05ce97c62fc');
chkHash(join(S8, 'gold-extra.json'), '677ff46bbc1e23599c43aa0bd57bcbe2f85347404bf55ec6c28c9368637c76a6');
const Q = JSON.parse(readFileSync(join(S7, 'questions.json')));
const EXTRA = JSON.parse(readFileSync(join(S8, 'gold-extra.json')));
const EXTRA2 = JSON.parse(readFileSync(join(S9, 'gold-extra2.json')));
const R9 = JSON.parse(readFileSync(join(S9, 'results.json')));
const sid = (f, h) => `${f} › ${h}`;
const FILES = []; for (const d of ['wiki', 'product', 'logs']) for (const f of readdirSync(join(CORPUS, d)).filter((x) => x.endsWith('.md')).sort()) FILES.push(`${d}/${f}`);
const lines = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(CORPUS, f), 'utf8').split('\n')]));

// ---- H2 map (fence-aware) — identical to round 9 ----
const h2 = {};
for (const f of FILES) { const arr = []; let fence = false; lines[f].forEach((ln, i) => { if (/^\s*(```|~~~)/.test(ln)) fence = !fence; else if (!fence && /^## /.test(ln)) arr.push({ line: i + 1, heading: ln.slice(3).trim() }); }); h2[f] = arr; }
const sectionOfLine1 = (f, l1) => { let cur = null; for (const s of h2[f]) if (s.line <= l1) cur = s; else break; return sid(f, cur ? cur.heading : '(preamble)'); };
// U1 H2 units only for the `mappable` gold check (same rule as round 9)
const u1Keys = new Set();
for (const file of FILES) { let fence = false, cur = '(preamble)', curLs = []; const flush = () => { if (cur !== '(preamble)' || curLs.join('\n').trim()) u1Keys.add(sid(file, cur)); };
  for (const ln of lines[file]) { if (/^\s*(```|~~~)/.test(ln)) fence = !fence; if (!fence && /^## /.test(ln)) { flush(); cur = ln.slice(3).trim(); curLs = [ln]; } else curLs.push(ln); } flush(); }

// ---- sections: litectx's own md chunker over the raw corpus files ----
const SEC = [];
for (const f of FILES) for (const c of await chunkFile(f, readFileSync(join(CORPUS, f), 'utf8'))) SEC.push({ id: `${f}#${c.startLine}-${c.endLine}`, file: f, start0: c.startLine, text: c.text });
if (new Set(SEC.map((s) => s.id)).size !== SEC.length) throw new Error('section id collision');
// cross-check against round 9's U2 (nodes table of the 7b doc-path index)
const d7 = new Database(join(S7, 'bm25.db'), { readonly: true });
const U2 = d7.prepare('SELECT path, start_line, end_line, body FROM nodes ORDER BY path, start_line, id').all(); d7.close();
const u2set = new Map(U2.map((r) => [`${r.path}#${r.start_line}-${r.end_line}`, r.body]));
const sameRanges = U2.length === SEC.length && SEC.every((s) => u2set.has(s.id));
const sameText = sameRanges && SEC.filter((s) => u2set.get(s.id) !== s.text).length;
const HEAD = 6000;
const trunc = { sections: SEC.length, over6000: SEC.filter((s) => s.text.length > HEAD).length, maxChars: Math.max(...SEC.map((s) => s.text.length)), meanChars: Math.round(SEC.reduce((a, s) => a + s.text.length, 0) / SEC.length) };
const byId = new Map(SEC.map((s) => [s.id, s]));
const toSec = (id) => { const s = byId.get(id); if (!s) throw new Error('unknown ' + id); return sectionOfLine1(s.file, s.start0 + 1); };

const ASKS = Q.flatMap((q) => ['A', 'B'].map((w) => ({ key: `${q.id}/${w}`, q: q['ask' + w] })));
const dbPath = join(OUT, 'sections-emb.db'); for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
const ctx = new LiteCtx({ root: join(OUT, 'root'), dbPath, embeddings: true });
await ctx._embedSafe('warm up the model'); // exclude model load from timings
let t0 = Date.now();
for (const s of SEC) await ctx.remember(s.id, s.text, { kind: 'doc', format: 'md' });
const writeMs = Date.now() - t0;
const docRows = ctx.store.db.prepare("SELECT COUNT(*) c FROM docs").get().c, embRows = ctx.store.db.prepare('SELECT COUNT(*) c FROM mem_embeddings').get().c;
if (docRows !== SEC.length || embRows !== SEC.length) throw new Error(`stored ${docRows}/${embRows} vs ${SEC.length}`);
ctx.store.db.pragma('wal_checkpoint(TRUNCATE)');

// ---- C1: same db, a second ctx with embeddings OFF -> ctx.recall kind doc = BM25 only (qvec null) ----
const ctxOff = new LiteCtx({ root: join(OUT, 'root'), dbPath, embeddings: false });
// ---- C3: copy of _rankKind (src/index.js:860-899) with the knn kind-gate lifted. K = KNN_K = 8 (src/index.js:40);
// pool = store.search(match,'doc',max(n,SEMANTIC_POOL=400),SPREAD_WEIGHT=0.3) (index.js:865); nominees = every doc vector with cos>0 not in pool,
// top K by cosine, score 0 (store.js:1967-1990 knnCandidates); fusion = minmax(score, nominees at pool floor) + embedWeight(1.0)*minmax(cosine) (index.js:892-898).
const KNN_K = 8, SEMANTIC_POOL = 400, SPREAD_WEIGHT = 0.3;
const minmax = (xs) => { const lo = Math.min(...xs), hi = Math.max(...xs); return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 1)); }; // verified below against src/index.js
const c3 = async (q, n) => {
  const match = ftsMatch(q); const qvec = match ? await ctx._embedQuery(q) : null;
  if (!qvec) return [];
  const rs = ctx._resolveReadScope(undefined, false, 'c3'); const filter = { scope: rs.scope, seeAll: rs.seeAll, now: Date.now() };
  const pool = ctx.store.search(match, 'doc', Math.max(n, SEMANTIC_POOL), SPREAD_WEIGHT, filter);
  const ex = new Set(pool.map((h) => h.path));
  // nominees: doc rows (source direct) with a vector, honoring the SAME doc scope/expiry fence the pool uses (here: seeAll, no scopes set)
  const rows = ctx.store.db.prepare("SELECT d.path AS path, e.vec AS vec FROM docs d JOIN mem_embeddings e ON e.path = d.path LEFT JOIN doc_scope s ON s.path = d.path WHERE d.kind = 'doc' AND (s.expires_at IS NULL OR s.expires_at > :now)").all({ now: filter.now });
  const knn = rows.filter((r) => !ex.has(r.path)).map((r) => ({ r, cos: cosine(qvec, (() => { const u8 = Uint8Array.from(r.vec); return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4); })()) })).filter((c) => c.cos > 0).sort((a, b) => b.cos - a.cos).slice(0, KNN_K).map(({ r }) => ({ path: r.path, score: 0, source: 'direct' }));
  const cand = pool.concat(knn); if (!cand.length) return cand;
  const raw = ctx.store.docCandidateVectors(cand).map((v) => cosine(qvec, v));
  if (cand.length < 2) return cand.slice(0, n);
  const floor = pool.length ? Math.min(...pool.map((h) => h.score)) : 0;
  const sN = minmax(cand.map((h, i) => (i < pool.length ? h.score : floor))), cN = minmax(raw);
  return cand.map((h, i) => ({ h, f: sN[i] + ctx.embedWeight * cN[i], nominee: i >= pool.length })).sort((a, b) => b.f - a.f).slice(0, n).map((x) => x.h);
};
// sanity: C3 with KNN disabled must equal ctx.recall (C2) exactly on every ask
const topSecs = (paths) => [...new Set(paths.map(toSec))].slice(0, 10);
const M = { C1: {}, C2: {}, C3: {} }; let nomInTop10 = 0, nomTotal = 0;
for (const a of ASKS) {
  M.C1[a.key] = topSecs((await ctxOff.recall(a.q, { kind: 'doc', n: 50 })).map((h) => h.path));
  M.C2[a.key] = topSecs((await ctx.recall(a.q, { kind: 'doc', n: 50 })).map((h) => h.path));
  const r3 = await c3(a.q, 50); M.C3[a.key] = topSecs(r3.map((h) => h.path));
  const poolSet = new Set(ctx.store.search(ftsMatch(a.q) ?? '', 'doc', 400, SPREAD_WEIGHT, { scope: null, seeAll: true, now: Date.now() }).map((h) => h.path));
  r3.slice(0, 10).forEach((h) => { nomTotal++; if (!poolSet.has(h.path)) nomInTop10++; });
}
// fusion sanity: C2 via the script's fusion with K=0 must equal shipped recall -> check by rerunning c3 w/ knn emptied
const KSAVE = KNN_K; // (constant; sanity done by direct re-implementation below)
let fusionMismatch = 0;
for (const a of ASKS) {
  const match = ftsMatch(a.q); if (!match) continue; const qvec = await ctx._embedQuery(a.q);
  const pool = ctx.store.search(match, 'doc', 400, SPREAD_WEIGHT, { scope: null, seeAll: true, now: Date.now() });
  const raw = ctx.store.docCandidateVectors(pool).map((v) => cosine(qvec, v)); const sN = minmax(pool.map((h) => h.score)), cN = minmax(raw);
  const mine = topSecs(pool.map((h, i) => ({ p: h.path, f: sN[i] + ctx.embedWeight * cN[i] })).sort((x, y) => y.f - x.f).slice(0, 50).map((x) => x.p));
  if (mine.join('|') !== M.C2[a.key].join('|')) fusionMismatch++;
}

// ---- scoring: identical to round 9 ----
const mappable = (g) => u1Keys.has(sid(g.file, g.heading));
const golds = (q) => { const gl = q.gold.map((g) => ({ ...g, id: sid(g.file, g.heading), mappable: mappable(g) }));
  for (const X of [EXTRA, EXTRA2]) for (const e of X[q.id] ?? []) { const id = sid(e.file, e.heading); if (!gl.some((g) => g.id === id)) gl.push({ ...e, id, primary: false, mappable: true, extra: true }); } return gl; };
const unmappedGold = Q.flatMap((q) => q.gold.filter((g) => !mappable(g)).map((g) => `${q.id}: ${sid(g.file, g.heading)}`));
const goldNotHit = Q.flatMap((q) => golds(q).filter((g) => g.mappable).filter((g) => !SEC.some((s) => sectionOfLine1(s.file, s.start0 + 1) === g.id)).map((g) => `${q.id}: ${g.id}`));
const metrics = (secs, gl) => { const goldIds = gl.filter((g) => g.mappable).map((g) => g.id); const prim = gl.find((g) => g.primary);
  const pr = prim.mappable ? secs.indexOf(prim.id) + 1 : 0;
  return { p1: +(pr === 1), p5: +(pr >= 1 && pr <= 5), p10: +(pr >= 1 && pr <= 10), any5: +goldIds.some((g) => secs.slice(0, 5).includes(g)) }; };
const MK = ['p1', 'p5', 'p10', 'any5'];
const evalM = (hits) => { const r = {}; for (const w of ['A', 'B']) { const rows = Q.map((q) => metrics(hits[`${q.id}/${w}`], golds(q))); r[w] = Object.fromEntries(MK.map((k) => [k, rows.reduce((a, x) => a + x[k], 0) / rows.length])); } return r; };
const S = { C1: evalM(M.C1), C2: evalM(M.C2), C3: evalM(M.C3) };
const ref = (m) => Object.fromEntries(['A', 'B'].map((w) => [w, Object.fromEntries(MK.map((k) => [k, R9.metrics.extra2[m][`${w}/all`][k]]))]));
const R9ref = { 'U2-emb (stemmed, emb nominates)': ref('U2-emb'), 'U2-bm25 (stemmed, BM25 only)': ref('U2-bm25') };

// ---- cost: same corpus indexed the shipped way (one row per file, ctx.index, embeddings on) ----
const fileRoot = join(OUT, 'fileroot'); rmSync(fileRoot, { recursive: true, force: true }); mkdirSync(fileRoot, { recursive: true });
for (const d of ['wiki', 'product', 'logs']) cpSync(join(CORPUS, d), join(fileRoot, d), { recursive: true });
for (const a of [['init', '-q'], ['add', '.'], ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit', '-qm', 'c']]) execFileSync('git', ['-C', fileRoot, ...a]);
const fdb = join(OUT, 'files-emb.db'); for (const s of ['', '-wal', '-shm']) rmSync(fdb + s, { force: true });
const fctx = new LiteCtx({ root: fileRoot, dbPath: fdb, embeddings: true }); await fctx._embedSafe('warm');
t0 = Date.now(); const ir = await fctx.index(); const indexMs = Date.now() - t0;
const fRows = fctx.store.db.prepare("SELECT COUNT(*) c FROM docs").get().c, fEmb = fctx.store.db.prepare('SELECT COUNT(*) c FROM file_embeddings').get().c;
fctx.store.db.pragma('wal_checkpoint(TRUNCATE)');
const fileOver = FILES.filter((f) => readFileSync(join(CORPUS, f), 'utf8').length > HEAD).length;
const cost = { sections: { rows: docRows, vectors: embRows, writeMs, dbBytes: statSync(dbPath).size }, perFile: { rows: fRows, vectors: fEmb, indexMs, dbBytes: statSync(fdb).size, filesOver6000: fileOver, files: FILES.length, indexSummary: JSON.stringify(ir).slice(0, 200) } };

const out = { setup: { files: FILES.length, sections: SEC.length, sameRangesAsRound9U2: sameRanges, textDiffsVsRound9U2: sameText, k: KNN_K, pool: SEMANTIC_POOL, embedWeight: ctx.embedWeight }, truncation: trunc, unmappedGold, goldWithNoSectionRow: goldNotHit, c3Sanity: { fusionMismatchVsShippedRecall: fusionMismatch }, c3NomineesInTop10: { nominees: nomInTop10, of: nomTotal }, cost, metricsExtra2: S, round9Ref: R9ref, hits: Object.fromEntries(Object.entries(M).map(([m, h]) => [m, h])) };
const rj = JSON.stringify(out, null, 1); writeFileSync(join(OUT, 'results.json'), rj);
const f = (x) => x.toFixed(2);
let rp = `# stage10 report\n\nSections ${SEC.length} (== round-9 U2 ranges: ${sameRanges}, text diffs ${sameText}); over ${HEAD} chars: ${trunc.over6000} (max ${trunc.maxChars}). unmapped gold: ${unmappedGold.length}\nK=${KNN_K}, pool=${SEMANTIC_POOL}, embedWeight=${ctx.embedWeight}; C3 nominees in top10: ${nomInTop10}/${nomTotal}\n\n| config | prim@5 A | prim@5 B | prim@10 A | prim@10 B | any@5 A | any@5 B |\n|---|---|---|---|---|---|---|\n`;
for (const [m, r] of [...Object.entries(S), ...Object.entries(R9ref)]) rp += `| ${m} | ${f(r.A.p5)} | ${f(r.B.p5)} | ${f(r.A.p10)} | ${f(r.B.p10)} | ${f(r.A.any5)} | ${f(r.B.any5)} |\n`;
rp += `\nCost: sections ${writeMs}ms / ${(cost.sections.dbBytes / 1e6).toFixed(2)}MB / ${docRows} rows; per-file ${indexMs}ms / ${(cost.perFile.dbBytes / 1e6).toFixed(2)}MB / ${fRows} rows\n`;
writeFileSync(join(OUT, 'report.md'), rp);
console.log(rp); console.log(JSON.stringify({ unmappedGold, goldNotHit, fusionMismatch, setup: out.setup, trunc, cost, resultsSha: sha(rj) }, null, 1));
