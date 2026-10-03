// Throwaway POC: round 9 — chunk size through the memory path (U1 H2 / U2 litectx md chunks / U3 ~1000-char windows) + mechanism split.
// Outputs only to ~/.cache/tinymem-probe/out/stage9/. Nothing in src/ is modified.
import { LiteCtx } from '../src/index.js';
import { ftsMatch, indexBody } from '../src/tokenize.js';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = join(homedir(), '.cache/tinymem-probe/out');
const S7 = join(BASE, 'stage7b'), S8 = join(BASE, 'stage8'), OUT = join(BASE, 'stage9'), CORPUS = join(S7, 'corpus');
mkdirSync(join(OUT, 'root'), { recursive: true }); mkdirSync(join(OUT, 'grade'), { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const chkHash = (p, h) => { if (sha(readFileSync(p)) !== h) throw new Error('hash mismatch ' + p); };
chkHash(join(S7, 'questions.json'), '2c38c60040edbcecf277956e4899b335c1119e30e6d039f1679fd05ce97c62fc');
chkHash(join(S8, 'gold-extra.json'), '677ff46bbc1e23599c43aa0bd57bcbe2f85347404bf55ec6c28c9368637c76a6');
const Q = JSON.parse(readFileSync(join(S7, 'questions.json')));
const EXTRA = JSON.parse(readFileSync(join(S8, 'gold-extra.json')));
const e2p = join(OUT, 'gold-extra2.json'); const EXTRA2 = existsSync(e2p) ? JSON.parse(readFileSync(e2p)) : null;
const R8 = JSON.parse(readFileSync(join(S8, 'results.json')));
const sid = (f, h) => `${f} › ${h}`;
const FILES = []; for (const d of ['wiki', 'product', 'logs']) for (const f of readdirSync(join(CORPUS, d)).filter((x) => x.endsWith('.md')).sort()) FILES.push(`${d}/${f}`);
const lines = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(CORPUS, f), 'utf8').split('\n')]));

// ---- H2 map (fence-aware, 1-based line) — same rule as 7b/8 ----
const h2 = {};
for (const f of FILES) { const arr = []; let fence = false; lines[f].forEach((ln, i) => { if (/^\s*(```|~~~)/.test(ln)) fence = !fence; else if (!fence && /^## /.test(ln)) arr.push({ line: i + 1, heading: ln.slice(3).trim() }); }); h2[f] = arr; }
const sectionOfLine1 = (f, l1) => { let cur = null; for (const s of h2[f]) if (s.line <= l1) cur = s; else break; return sid(f, cur ? cur.heading : '(preamble)'); };

// ---- U1: H2 units, identical to round 8 ----
const U1 = []; let nH2 = 0, nPre = 0;
for (const file of FILES) {
  let fence = false, cur = { heading: '(preamble)', ls: [] }; const secs = [];
  for (const ln of lines[file]) { if (/^\s*(```|~~~)/.test(ln)) fence = !fence; if (!fence && /^## /.test(ln)) { secs.push(cur); cur = { heading: ln.slice(3).trim(), ls: [ln] }; } else cur.ls.push(ln); }
  secs.push(cur); const seen = new Map();
  for (const s of secs) { const text = s.ls.join('\n'); if (s.heading === '(preamble)') { if (!text.trim()) continue; nPre++; } else nH2++; const k = seen.get(s.heading) ?? 0; seen.set(s.heading, k + 1); U1.push({ file, heading: s.heading, id: `${file}::${s.heading}${k ? ` #${k + 1}` : ''}`, text, sec: sid(file, s.heading) }); }
}
const secText = new Map(U1.map((u) => [u.sec, u.text]));
const sectionOfU1 = new Map(U1.map((u) => [u.id, u.sec]));

// ---- U2: litectx's own md chunks (read from the 7b doc-path index; nodes are 0-based inclusive lines) ----
const d7 = new Database(join(S7, 'bm25.db'), { readonly: true });
const nodeCount = d7.prepare('SELECT COUNT(*) c FROM nodes').get().c; if (nodeCount !== 1607) throw new Error('node count ' + nodeCount);
const U2 = d7.prepare('SELECT path, start_line, end_line, body FROM nodes ORDER BY path, start_line, id').all().map((r) => ({ id: `${r.path}::${r.start_line}-${r.end_line}`, file: r.path, start0: r.start_line, text: r.body }));
d7.close();
if (new Set(U2.map((u) => u.id)).size !== U2.length) throw new Error('U2 id collision');

// ---- U3: ~1000-char windows. Rule: per file, accumulate whole lines; close the window at the first BLANK line once >=1000 chars
// are accumulated (paragraph boundary), or at any line boundary once >=1600 chars (hard cap; a lone longer line rides whole).
// Windows ignore H2 boundaries (may span them); a window's section = the H2 containing its start line. Whitespace-only windows dropped.
const U3 = [];
for (const f of FILES) {
  const L = lines[f]; let start = 0, chars = 0;
  const flush = (end) => { const text = L.slice(start, end + 1).join('\n'); if (text.trim()) U3.push({ id: `${f}::${start}-${end}`, file: f, start0: start, text }); start = end + 1; chars = 0; };
  for (let i = 0; i < L.length; i++) { chars += L[i].length + 1; if ((chars >= 1000 && L[i].trim() === '') || chars >= 1600) flush(i); }
  if (start < L.length) flush(L.length - 1);
}

const ASKS = Q.flatMap((q) => ['A', 'B'].map((w) => ({ key: `${q.id}/${w}`, q: q['ask' + w] })));
const mapHit = (u) => sectionOfLine1(u.file, u.start0 + 1);

async function memRun(units, name, embeddings, n, toSec) {
  const dbPath = join(OUT, name); for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  const ctx = new LiteCtx({ root: join(OUT, 'root'), dbPath, embeddings });
  for (const u of units) await ctx.remember(u.id, u.text, { kind: 'fact' });
  const stored = ctx.store.db.prepare('SELECT COUNT(*) c FROM mem_text').get().c, embRows = ctx.store.db.prepare('SELECT COUNT(*) c FROM mem_embeddings').get().c;
  if (stored !== units.length) throw new Error('stored mismatch ' + name);
  if (embeddings && (!ctx.embeddings || embRows !== units.length)) throw new Error('embeddings degraded ' + name);
  const hits = {};
  for (const a of ASKS) { const res = await ctx.recall(a.q, { kind: 'fact', n }); hits[a.key] = [...new Set(res.map((h) => toSec(h.path)))].slice(0, 10); }
  ctx.store.db.close?.(); return { hits, stored, embRows };
}
const byId2 = new Map([...U2, ...U3].map((u) => [u.id, u]));
const toSecChunk = (id) => { const u = byId2.get(id); if (!u) throw new Error('unknown ' + id); return mapHit(u); };
const toSecU1 = (id) => { const s = sectionOfU1.get(id); if (!s) throw new Error('unknown ' + id); return s; };
const M = {}; const stores = {};
for (const [tag, units, toSec, n] of [['U1', U1, toSecU1, 10], ['U2', U2, toSecChunk, 50], ['U3', U3, toSecChunk, 50]]) {
  for (const emb of [true, false]) { const r = await memRun(units, `${tag}-${emb ? 'emb' : 'bm25'}.db`, emb, n, toSec); M[`${tag}-${emb ? 'emb' : 'bm25'}`] = r.hits; stores[`${tag}-${emb ? 'emb' : 'bm25'}`] = { stored: r.stored, embRows: r.embRows }; }
}

// ---- Part 2: M-stem — plain FTS5, unicode61 vs porter unicode61. Body = indexBody({path:id, body}) (what litectx's mem stores);
// query = ftsMatch(q) from src/tokenize.js (identifier-split keywords, stopwords + <3 chars dropped, OR of quoted terms); ORDER BY bm25 (asc), rowid tiebreak; top 10.
for (const [name, tok] of [['stem-unicode61', 'unicode61'], ['stem-porter', 'porter unicode61']]) {
  const db = new Database(':memory:'); db.exec(`CREATE VIRTUAL TABLE t USING fts5(path UNINDEXED, body, tokenize='${tok}')`);
  const ins = db.prepare('INSERT INTO t(path, body) VALUES (?, ?)'); for (const u of U1) ins.run(u.id, indexBody({ path: u.id, body: u.text }));
  const sel = db.prepare('SELECT path FROM t WHERE t MATCH ? ORDER BY bm25(t), rowid LIMIT 10'); const hits = {};
  for (const a of ASKS) { const m = ftsMatch(a.q); hits[a.key] = m ? sel.all(m).map((r) => sectionOfU1.get(r.path)) : []; }
  M[name] = hits; db.close();
}
// M-cap: one section per file (keep first rank) applied to round-8 equivalents (U1-emb / U1-bm25)
for (const b of ['emb', 'bm25']) M[`cap-U1-${b}`] = Object.fromEntries(Object.entries(M[`U1-${b}`]).map(([k, v]) => { const seen = new Set(); return [k, v.filter((s) => { const f = s.split(' › ')[0]; if (seen.has(f)) return false; seen.add(f); return true; })]; }));

// ---- scoring (round-8 metrics) ----
const mappable = (g) => U1.some((u) => u.file === g.file && u.heading === g.heading);
const golds = (q, set) => {
  const gl = q.gold.map((g) => ({ ...g, id: sid(g.file, g.heading), mappable: mappable(g) }));
  for (const X of [set >= 1 ? EXTRA : null, set >= 2 ? EXTRA2 : null]) if (X) for (const e of X[q.id] ?? []) { const id = sid(e.file, e.heading); if (!gl.some((g) => g.id === id)) gl.push({ ...e, id, primary: false, mappable: true, extra: true }); }
  return gl;
};
const metrics = (secs, gl) => {
  const goldIds = gl.filter((g) => g.mappable).map((g) => g.id); const prim = gl.find((g) => g.primary);
  const uniq = [...new Set(secs)]; const cov = (k) => goldIds.filter((g) => uniq.slice(0, k).includes(g)).length / gl.length;
  const pr = prim.mappable ? secs.indexOf(prim.id) + 1 : 0; const goldFiles = new Set(gl.map((g) => g.file));
  return { p1: +(pr === 1), p5: +(pr >= 1 && pr <= 5), p10: +(pr >= 1 && pr <= 10), any5: +goldIds.some((g) => secs.slice(0, 5).includes(g)), cov5: cov(5), cov10: cov(10), gf5: +secs.slice(0, 5).some((s) => goldFiles.has(s.split(' › ')[0])) };
};
const multi = Object.fromEntries(Q.map((q) => [q.id, new Set(q.gold.map((g) => g.file)).size > 1]));
const MK = ['p1', 'p5', 'p10', 'any5', 'cov5', 'cov10', 'gf5'];
const evalAll = (set) => { const res = {}; for (const [m, hits] of Object.entries(M)) { res[m] = {}; for (const w of ['A', 'B']) for (const g of ['all', 'single', 'multi']) { const qs = Q.filter((q) => g === 'all' || (g === 'multi') === multi[q.id]); const rows = qs.map((q) => metrics(hits[`${q.id}/${w}`], golds(q, set))); res[m][`${w}/${g}`] = { n: qs.length, ...Object.fromEntries(MK.map((k) => [k, rows.reduce((a, r) => a + r[k], 0) / rows.length])) }; } } return res; };
const S = { base: evalAll(0), extra: evalAll(1), ...(EXTRA2 ? { extra2: evalAll(2) } : {}) };
// sanity: U1 must equal round 8's mem-emb / mem-bm25 exactly
const mism = [];
for (const [mine, theirs] of [['U1-emb', 'mem-emb'], ['U1-bm25', 'mem-bm25']]) for (const [set, r8] of [['base', R8.metrics], ['extra', R8.metricsWithGoldExtra]].filter(([, r]) => r)) for (const k of Object.keys(r8[theirs])) for (const mk of MK) if (Math.abs(S[set][mine][k][mk] - r8[theirs][k][mk]) > 1e-12) mism.push(`${mine}/${set}/${k}/${mk}`);
// also: top-5 section lists must equal stage8/hits.json
const H8 = JSON.parse(readFileSync(join(S8, 'hits.json')));
for (const [mine, theirs] of [['U1-emb', 'mem-emb'], ['U1-bm25', 'mem-bm25']]) for (const q of Q) for (const w of ['A', 'B']) { const a = M[mine][`${q.id}/${w}`].slice(0, 5).join('|'), b = H8[q.id][w][theirs].map((h) => sid(h.file, h.heading)).join('|'); if (a !== b) mism.push(`${mine}/hits/${q.id}/${w}`); }
if (mism.length) console.error('ROUND-8 MISMATCH', mism.join(','));

// ---- Part 3: blind-grading top-up ----
const key8 = JSON.parse(readFileSync(join(S8, 'grade/key.json')));
const judged = new Set(Object.values(key8).map((r) => `${r.qid}|${r.file}|${r.heading}`));
const NEWM = ['U2-emb', 'U2-bm25', 'U3-emb', 'U3-bm25', 'stem-unicode61', 'stem-porter', 'cap-U1-emb', 'cap-U1-bm25'];
const pool = new Map(); let unmapped = 0;
for (const q of Q) {
  const ex = new Set([...q.gold.map((g) => sid(g.file, g.heading)), ...(EXTRA[q.id] ?? []).map((e) => sid(e.file, e.heading)), ...(EXTRA2?.[q.id] ?? []).map((e) => sid(e.file, e.heading))]);
  for (const a of ['A', 'B']) for (const m of NEWM) for (const s of M[m][`${q.id}/${a}`].slice(0, 5)) {
    if (ex.has(s)) continue; const [file, ...r] = s.split(' › '); const heading = r.join(' › ');
    if (judged.has(`${q.id}|${file}|${heading}`)) continue;
    const pairId = sha(`${q.id}|${file}|${heading}`).slice(0, 10); let rec = pool.get(pairId);
    if (!rec) { rec = { pairId, q, qid: q.id, file, heading, methods: new Set(), asks: new Set() }; pool.set(pairId, rec); } rec.methods.add(m); rec.asks.add(a);
  }
}
const pairs = [...pool.values()].sort((x, y) => (x.pairId < y.pairId ? -1 : 1)); const CAP = 5000;
for (const p of pairs) { let t = secText.get(p.file ? sid(p.file, p.heading) : ''); if (t === undefined) { unmapped++; p.text = '[missing]'; continue; } if (t.length > CAP) t = t.slice(0, CAP) + `\n[…section continues, ${t.length - CAP} more chars]`; p.text = t; }
let seed = 20260930; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
const size = (p) => p.text.length + 400; const totalChars = pairs.reduce((a, p) => a + size(p), 0);
const NP = Math.max(1, Math.ceil(pairs.length / 110), Math.ceil(totalChars / 330000));
for (const f of readdirSync(join(OUT, 'grade'))) if (/^packet-/.test(f)) rmSync(join(OUT, 'grade', f));
const packs = Array.from({ length: NP }, () => ({ items: [], chars: 0 }));
for (const { p, i } of pairs.map((p, i) => ({ p, i })).sort((a, b) => size(b.p) - size(a.p) || a.i - b.i)) { const t = packs.filter((k) => k.items.length < 110).reduce((a, b) => (b.chars < a.chars ? b : a)); t.items.push({ p, i }); t.chars += size(p); }
const key = {}; const packRep = [];
packs.forEach((pk, n) => {
  pk.items.sort((a, b) => a.i - b.i);
  const body = pk.items.map(({ p }) => { key[p.pairId] = { qid: p.qid, file: p.file, heading: p.heading, methods: [...p.methods].sort(), asks: [...p.asks].sort() }; return JSON.stringify({ pairId: p.pairId, question: { topic: p.q.topic, askA: p.q.askA, askB: p.q.askB }, file: p.file, heading: p.heading, text: p.text }); }).join('\n') + '\n';
  writeFileSync(join(OUT, 'grade', `packet-${n + 1}.jsonl`), body); packRep.push({ packet: n + 1, pairs: pk.items.length, chars: body.length, sha256: sha(body) });
});
const keyBody = JSON.stringify(Object.fromEntries(Object.keys(key).sort().map((k) => [k, key[k]])), null, 1); writeFileSync(join(OUT, 'grade', 'key.json'), keyBody);

// ---- outputs ----
const topSecs = Object.fromEntries(Object.entries(M).map(([m, h]) => [m, Object.fromEntries(Object.entries(h).map(([k, v]) => [k, v.slice(0, 10)]))]));
const out = { units: { U1: { total: U1.length, h2: nH2, preambles: nPre }, U2: { total: U2.length, nodeCount, meanChars: Math.round(U2.reduce((a, u) => a + u.text.length, 0) / U2.length) }, U3: { total: U3.length, meanChars: Math.round(U3.reduce((a, u) => a + u.text.length, 0) / U3.length) } }, stores, round8Mismatches: mism, newPairs: { count: pairs.length, unmappedText: unmapped, packets: packRep, keySha256: sha(keyBody) }, extra2Present: !!EXTRA2, metrics: S, hits: topSecs };
const rj = JSON.stringify(out, null, 1); writeFileSync(join(OUT, 'results.json'), rj);
const f = (x) => x.toFixed(3);
const tbl = (title, R, ms) => { let s = `## ${title}\n| method | ask | group | p@1 | prim@5 | prim@10 | any@5 | cov@5 | cov@10 | goldfile@5 |\n|---|---|---|---|---|---|---|---|---|---|\n`; for (const m of ms) for (const w of ['A', 'B']) for (const g of ['all', 'single', 'multi']) { const x = R[m][`${w}/${g}`]; s += `| ${m} | ${w} | ${g} (${x.n}) | ${MK.map((k) => f(x[k])).join(' | ')} |\n`; } return s + '\n'; };
let rp = `# stage9 report\n\nUnits: U1 ${U1.length} (H2 ${nH2}, pre ${nPre}); U2 ${U2.length} (node count ${nodeCount}); U3 ${U3.length}. Round-8 mismatches: ${mism.length ? mism.join(',') : 'none'}\nNew pairs to grade: ${pairs.length}\n\n`;
for (const [k, R] of Object.entries(S)) { rp += tbl(`Part 1 (${k})`, R, ['U1-emb', 'U2-emb', 'U3-emb', 'U1-bm25', 'U2-bm25', 'U3-bm25']); rp += tbl(`Part 2 (${k})`, R, ['stem-unicode61', 'stem-porter', 'U1-emb', 'cap-U1-emb', 'U1-bm25', 'cap-U1-bm25']); }
writeFileSync(join(OUT, 'report.md'), rp);
console.log(JSON.stringify({ units: out.units, stores, mism, newPairs: out.newPairs, resultsSha: sha(rj) }, null, 1));
