// Throwaway POC: round 11 — stemming vs path differences (isolation). One change per step:
// S1 = round 10 C1 (unstemmed `docs`, BM25) re-run | S2 = SAME FTS column values copied row by row into a `porter unicode61` table, same query + bm25() | S3 = S2 + shipped embedding re-rank fusion.
// Outputs only to ~/.cache/tinymem-probe/out/stage11/. Nothing in src/ is modified.
import { LiteCtx } from '../src/index.js';
import { ftsMatch } from '../src/tokenize.js';
import { cosine } from '../src/embedder.js';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = join(homedir(), '.cache/tinymem-probe/out');
const S7 = join(BASE, 'stage7b'), S8 = join(BASE, 'stage8'), S9 = join(BASE, 'stage9'), S10 = join(BASE, 'stage10'), OUT = join(BASE, 'stage11'), CORPUS = join(S7, 'corpus');
mkdirSync(join(OUT, 'root'), { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const chkHash = (p, h) => { if (sha(readFileSync(p)) !== h) throw new Error('hash mismatch ' + p); };
chkHash(join(S7, 'questions.json'), '2c38c60040edbcecf277956e4899b335c1119e30e6d039f1679fd05ce97c62fc');
chkHash(join(S8, 'gold-extra.json'), '677ff46bbc1e23599c43aa0bd57bcbe2f85347404bf55ec6c28c9368637c76a6');
chkHash(join(S9, 'results.json'), 'a87f3e3920f5370caa3ace2be622ff6c189a99cbf7547add7ec60ff797086a2f');
chkHash(join(S10, 'results.json'), 'b3deee32de5e1c93cad1adfbf418cebd255e2c45f9244be57ed0330a6dd0d52a');
const Q = JSON.parse(readFileSync(join(S7, 'questions.json')));
const EXTRA = JSON.parse(readFileSync(join(S8, 'gold-extra.json')));
const EXTRA2 = JSON.parse(readFileSync(join(S9, 'gold-extra2.json')));
const R9 = JSON.parse(readFileSync(join(S9, 'results.json')));
const R10 = JSON.parse(readFileSync(join(S10, 'results.json')));
const sid = (f, h) => `${f} › ${h}`;
const FILES = []; for (const d of ['wiki', 'product', 'logs']) for (const f of readdirSync(join(CORPUS, d)).filter((x) => x.endsWith('.md')).sort()) FILES.push(`${d}/${f}`);
const lines = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(CORPUS, f), 'utf8').split('\n')]));
const h2 = {};
for (const f of FILES) { const arr = []; let fence = false; lines[f].forEach((ln, i) => { if (/^\s*(```|~~~)/.test(ln)) fence = !fence; else if (!fence && /^## /.test(ln)) arr.push({ line: i + 1, heading: ln.slice(3).trim() }); }); h2[f] = arr; }
const sectionOfLine1 = (f, l1) => { let cur = null; for (const s of h2[f]) if (s.line <= l1) cur = s; else break; return sid(f, cur ? cur.heading : '(preamble)'); };
const u1Keys = new Set();
for (const file of FILES) { let fence = false, cur = '(preamble)', curLs = []; const flush = () => { if (cur !== '(preamble)' || curLs.join('\n').trim()) u1Keys.add(sid(file, cur)); };
  for (const ln of lines[file]) { if (/^\s*(```|~~~)/.test(ln)) fence = !fence; if (!fence && /^## /.test(ln)) { flush(); cur = ln.slice(3).trim(); curLs = [ln]; } else curLs.push(ln); } flush(); }
// section id `${file}#${start0}-${end0}` -> H2 section (same as round 10 toSec: sectionOfLine1(file, start0+1))
const toSec = (id) => { const m = /^(.*)#(\d+)-(\d+)$/.exec(id); if (!m) throw new Error('bad id ' + id); return sectionOfLine1(m[1], +m[2] + 1); };
const topSecs = (paths) => [...new Set(paths.map(toSec))].slice(0, 10);
const ASKS = Q.flatMap((q) => ['A', 'B'].map((w) => ({ key: `${q.id}/${w}`, q: q['ask' + w] })));

// ---- working copy of the round-10 db (never touch stage10) ----
const dbPath = join(OUT, 'sections-copy.db'); for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
copyFileSync(join(S10, 'sections-emb.db'), dbPath);
const ctxOn = new LiteCtx({ root: join(OUT, 'root'), dbPath, embeddings: true });
await ctxOn._embedSafe('warm up the model');
const ctxOff = new LiteCtx({ root: join(OUT, 'root'), dbPath, embeddings: false });
const maindb = ctxOn.store.db;
const nDocs = maindb.prepare('SELECT COUNT(*) c FROM docs').get().c; if (nDocs !== 1607) throw new Error('docs rows ' + nDocs);

// ---- FTS copies in a scratch :memory: db: IDENTICAL column values, only the tokenizer differs ----
// docs (src/store.js:118): fts5(path UNINDEXED, kind UNINDEXED, format UNINDEXED, source UNINDEXED, provenance UNINDEXED, occurred_at UNINDEXED, body)  -> default tokenizer (unicode61)
// mem  (src/store.js:221): same but tokenize='porter unicode61'
const sdb = new Database(':memory:');
const COLS = 'path, kind, format, source, provenance, occurred_at, body';
const DEF = 'path UNINDEXED, kind UNINDEXED, format UNINDEXED, source UNINDEXED, provenance UNINDEXED, occurred_at UNINDEXED, body';
sdb.exec(`CREATE VIRTUAL TABLE t_unstem USING fts5(${DEF}); CREATE VIRTUAL TABLE t_porter USING fts5(${DEF}, tokenize='porter unicode61')`);
const srcRows = maindb.prepare(`SELECT ${COLS} FROM docs ORDER BY rowid`).all();
const ins = (t) => sdb.prepare(`INSERT INTO ${t}(${COLS}) VALUES (@path,@kind,@format,@source,@provenance,@occurred_at,@body)`);
for (const t of ['t_unstem', 't_porter']) { const i = ins(t); sdb.transaction(() => srcRows.forEach((r) => i.run(r)))(); }
const POOL = 400, SEMANTIC_POOL = 400, N = 50;
// same SQL shape as store.js:1689-1697 minus the doc_scope LEFT JOIN (no scope rows set; control below proves no effect) and minus spreading (no edges; control proves no-op)
const pool = (t, q) => { const m = ftsMatch(q); return m ? sdb.prepare(`SELECT ${t}.path AS path, -bm25(${t}) AS score FROM ${t} WHERE ${t} MATCH :m AND ${t}.kind = 'doc' ORDER BY score DESC LIMIT ${POOL}`).all({ m }) : []; };

// vectors (mem_embeddings, keyed by path) + shipped fusion (src/index.js:870-898, minmax as in round 10)
const vecOf = new Map(maindb.prepare('SELECT path, vec FROM mem_embeddings').all().map((r) => { const u8 = Uint8Array.from(r.vec); return [r.path, new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4)]; }));
const minmax = (xs) => { const lo = Math.min(...xs), hi = Math.max(...xs); return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 1)); };
const fuse = (p, qvec) => { if (!p.length) return []; if (p.length < 2) return p.slice(0, N); const raw = p.map((h) => cosine(qvec, vecOf.get(h.path))); const sN = minmax(p.map((h) => h.score)), cN = minmax(raw);
  return p.map((h, i) => ({ h, f: sN[i] + ctxOn.embedWeight * cN[i] })).sort((a, b) => b.f - a.f).slice(0, N).map((x) => x.h); };

const M = { S1: {}, S1c: {}, S2: {}, S3: {}, S1emb_check: {}, C2: {} }; let mismatchS1vsR10 = 0, mismatchS1c = 0, mismatchC2 = 0, mismatchC2vsR10 = 0;
for (const a of ASKS) {
  M.S1[a.key] = topSecs((await ctxOff.recall(a.q, { kind: 'doc', n: N })).map((h) => h.path));
  M.S1c[a.key] = topSecs(pool('t_unstem', a.q).slice(0, N).map((h) => h.path));
  M.S2[a.key] = topSecs(pool('t_porter', a.q).slice(0, N).map((h) => h.path));
  const qvec = ftsMatch(a.q) ? await ctxOn._embedQuery(a.q) : null;
  M.S3[a.key] = qvec ? topSecs(fuse(pool('t_porter', a.q), qvec).map((h) => h.path)) : [];
  M.S1emb_check[a.key] = qvec ? topSecs(fuse(pool('t_unstem', a.q), qvec).map((h) => h.path)) : [];   // unstemmed fusion, my reimplementation
  M.C2[a.key] = topSecs((await ctxOn.recall(a.q, { kind: 'doc', n: N })).map((h) => h.path)); // shipped recall
  if (M.S1[a.key].join('|') !== R10.hits.C1[a.key].join('|')) mismatchS1vsR10++;
  if (M.S1[a.key].join('|') !== M.S1c[a.key].join('|')) mismatchS1c++;
  if (M.S1emb_check[a.key].join('|') !== M.C2[a.key].join('|')) mismatchC2++;
  if (M.C2[a.key].join('|') !== R10.hits.C2[a.key].join('|')) mismatchC2vsR10++;
}
// reference hits (stage9 U2 stemmed BM25 / stemmed+emb, stage10 C1/C2) — read, not re-run
M.R9_U2bm25 = R9.hits['U2-bm25']; M.R9_U2emb = R9.hits['U2-emb']; M.R10_C1 = R10.hits.C1; M.R10_C2 = R10.hits.C2;

// ---- scoring: identical to round 10 ----
const golds = (q) => { const gl = q.gold.map((g) => ({ ...g, id: sid(g.file, g.heading), mappable: u1Keys.has(sid(g.file, g.heading)) }));
  for (const X of [EXTRA, EXTRA2]) for (const e of X[q.id] ?? []) { const id = sid(e.file, e.heading); if (!gl.some((g) => g.id === id)) gl.push({ ...e, id, primary: false, mappable: true, extra: true }); } return gl; };
const metrics = (secs, gl) => { const goldIds = gl.filter((g) => g.mappable).map((g) => g.id); const prim = gl.find((g) => g.primary);
  const pr = prim.mappable ? secs.indexOf(prim.id) + 1 : 0;
  return { rank: pr, p1: +(pr === 1), p5: +(pr >= 1 && pr <= 5), p10: +(pr >= 1 && pr <= 10), any5: +goldIds.some((g) => secs.slice(0, 5).includes(g)) }; };
const MK = ['p1', 'p5', 'p10', 'any5'];
const rowsOf = (hits, w) => Q.map((q) => ({ q: q.id, ...metrics(hits[`${q.id}/${w}`], golds(q)) }));
const evalM = (hits) => { const r = {}; for (const w of ['A', 'B']) { const rows = rowsOf(hits, w); r[w] = Object.fromEntries(MK.map((k) => [k, rows.reduce((a, x) => a + x[k], 0) / rows.length])); } return r; };
const CFG = { S1: M.S1, S2: M.S2, S3: M.S3, 'R9 U2 stemmed BM25': M.R9_U2bm25, 'R9 U2 stemmed+emb': M.R9_U2emb, 'R10 C1': M.R10_C1, 'R10 C2': M.R10_C2 };
const S = Object.fromEntries(Object.entries(CFG).map(([k, h]) => [k, evalM(h)]));
// sanity: re-scored references equal the stored metrics
const refChk = []; for (const [k, ref] of [['R9 U2 stemmed BM25', R9.metrics.extra2['U2-bm25']], ['R9 U2 stemmed+emb', R9.metrics.extra2['U2-emb']]]) for (const w of ['A', 'B']) for (const m of MK) if (Math.abs(S[k][w][m] - ref[`${w}/all`][m]) > 1e-12) refChk.push(`${k}/${w}/${m}`);
// pooled p@5 / p@10 / any@5 over A+B (40 asks)
const pooled = Object.fromEntries(Object.entries(S).map(([k, r]) => [k, Object.fromEntries(MK.map((m) => [m, (r.A[m] + r.B[m]) / 2]))]));

// ---- flips: primary@5 membership between consecutive steps, with primary rank per config ----
const nExtra = Object.fromEntries(Q.map((q) => [q.id, golds(q).filter((g) => g.extra).length]));
const rk = (k, w) => Object.fromEntries(rowsOf(CFG[k], w).map((r) => [r.q, r]));
const flips = {};
for (const w of ['A', 'B']) {
  const S1r = rk('S1', w), S2r = rk('S2', w), S3r = rk('S3', w), U2r = rk('R9 U2 stemmed BM25', w);
  const diff = (a, b, an, bn) => Q.flatMap((q) => { const x = a[q.id], y = b[q.id]; if (x.p5 === y.p5 && x.any5 === y.any5) return []; return [{ q: q.id, [an + ' rank']: x.rank, [bn + ' rank']: y.rank, p5: `${x.p5}->${y.p5}`, any5: `${x.any5}->${y.any5}`, extras: nExtra[q.id] }]; });
  flips[w] = { 'S1->S2': diff(S1r, S2r, 'S1', 'S2'), 'S2->R9U2bm25': diff(S2r, U2r, 'S2', 'U2'), 'S2->S3': diff(S2r, S3r, 'S2', 'S3') };
}
// full per-question primary-rank table
const ranks = {}; for (const w of ['A', 'B']) ranks[w] = Object.fromEntries(Q.map((q) => [q.id, Object.fromEntries(Object.keys(CFG).map((k) => [k, rowsOf(CFG[k], w).find((r) => r.q === q.id).rank]))]));

const out = { checks: { s1ReproducesRound10C1_mismatchedAsks: mismatchS1vsR10, s1VsUnstemCopyOwnSql_mismatchedAsks: mismatchS1c, myFusionVsShippedRecall_mismatchedAsks: mismatchC2, shippedRecallVsRound10C2_mismatchedAsks: mismatchC2vsR10, refRescoreMismatch: refChk, ftsRowsCopied: srcRows.length }, metricsExtra2: S, pooledAB: pooled, flips, primaryRanks: ranks, hits: { S1: M.S1, S2: M.S2, S3: M.S3 } };
const rj = JSON.stringify(out, null, 1); writeFileSync(join(OUT, 'results.json'), rj);
const f = (x) => x.toFixed(2);
let rp = `# stage11 report\n\nChecks: S1 vs round-10 C1 mismatched asks ${mismatchS1vsR10}/40; S1 vs own-SQL unstemmed copy ${mismatchS1c}/40 (proves doc_scope JOIN + spreading are no-ops here); my fusion vs shipped recall ${mismatchC2}/40; shipped recall vs round-10 C2 ${mismatchC2vsR10}/40; ref rescore mismatches ${refChk.length}.\n\n| config | prim@5 A | prim@5 B | prim@10 A | prim@10 B | any@5 A | any@5 B |\n|---|---|---|---|---|---|---|\n`;
for (const [m, r] of Object.entries(S)) rp += `| ${m} | ${f(r.A.p5)} | ${f(r.B.p5)} | ${f(r.A.p10)} | ${f(r.B.p10)} | ${f(r.A.any5)} | ${f(r.B.any5)} |\n`;
rp += `\nFlips (primary rank, 0 = not in top 10):\n\`\`\`json\n${JSON.stringify(flips, null, 1)}\n\`\`\`\n`;
writeFileSync(join(OUT, 'report.md'), rp);
console.log(rp); console.log(JSON.stringify({ checks: out.checks, pooled, resultsSha: sha(rj), reportSha: sha(rp) }, null, 1));
