// Throwaway POC: same 20 frozen questions through litectx's MEMORY path (H2 section = one fact) vs the doc path (7b).
// Outputs only to ~/.cache/tinymem-probe/out/stage8/.
import { LiteCtx } from '../src/index.js';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = join(homedir(), '.cache/tinymem-probe/out');
const S7 = join(BASE, 'stage7b'), OUT = join(BASE, 'stage8'), CORPUS = join(S7, 'corpus');
mkdirSync(join(OUT, 'root'), { recursive: true });
const QSHA = '2c38c60040edbcecf277956e4899b335c1119e30e6d039f1679fd05ce97c62fc';
const qraw = readFileSync(join(S7, 'questions.json'));
if (createHash('sha256').update(qraw).digest('hex') !== QSHA) throw new Error('questions.json hash mismatch');
const Q = JSON.parse(qraw);
const R7 = JSON.parse(readFileSync(join(S7, 'results.json')));
const extraPath = join(OUT, 'gold-extra.json');
const EXTRA = existsSync(extraPath) ? JSON.parse(readFileSync(extraPath)) : null;
const SKIPPED = new Set(['PRD.md', 'FINDINGS.md', 'UPSTREAM-ASKS.md', 'TESTGEN-PREREG.md']);
const sid = (f, h) => `${f} › ${h}`;

// 1. H2 units (fence-aware; preamble = text before first H2, kept if non-blank)
const units = []; // {file, heading, id, text}
let nH2 = 0, nPre = 0, nDup = 0;
for (const d of ['wiki', 'product', 'logs']) for (const f of readdirSync(join(CORPUS, d)).filter((x) => x.endsWith('.md')).sort()) {
  const file = `${d}/${f}`; const L = readFileSync(join(CORPUS, file), 'utf8').split('\n');
  let fence = false, cur = { heading: '(preamble)', lines: [] }; const secs = [];
  for (const ln of L) {
    if (/^\s*(```|~~~)/.test(ln)) fence = !fence;
    if (!fence && /^## /.test(ln)) { secs.push(cur); cur = { heading: ln.slice(3).trim(), lines: [ln] }; } else cur.lines.push(ln);
  }
  secs.push(cur);
  const seen = new Map();
  for (const s of secs) {
    const text = s.lines.join('\n');
    if (s.heading === '(preamble)') { if (!text.trim()) continue; nPre++; } else nH2++;
    const k = seen.get(s.heading) ?? 0; seen.set(s.heading, k + 1);
    if (k) nDup++;
    units.push({ file, heading: s.heading, id: `${file}::${s.heading}${k ? ` #${k + 1}` : ''}`, text });
  }
}
const byId = new Map(units.map((u) => [u.id, u]));
if (byId.size !== units.length) throw new Error('id collision');
const secOfId = (id) => { const u = byId.get(id); if (!u) throw new Error('unknown id ' + id); return sid(u.file, u.heading); };

// 2. mem path
async function memRun(embeddings, name) {
  const dbPath = join(OUT, name);
  for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  const ctx = new LiteCtx({ root: join(OUT, 'root'), dbPath, embeddings });
  for (const u of units) await ctx.remember(u.id, u.text, { kind: 'fact' });
  const stored = ctx.store.db.prepare("SELECT COUNT(*) c FROM mem_text").get().c;
  const ftsRows = ctx.store.db.prepare("SELECT COUNT(*) c FROM mem").get().c;
  const embRows = ctx.store.db.prepare("SELECT COUNT(*) c FROM mem_embeddings").get().c;
  if (stored !== units.length) throw new Error(`stored ${stored} != units ${units.length}`);
  const hits = {};
  for (const q of Q) for (const w of ['A', 'B']) {
    const res = await ctx.recall(q['ask' + w], { kind: 'fact', n: 10 });
    hits[`${q.id}/${w}`] = res.map((h) => secOfId(h.path));
  }
  const embActive = ctx.embeddings;
  ctx.store.db.close?.();
  return { hits, stored, ftsRows, embRows, embActive };
}
const bm = await memRun(false, 'mem-bm25.db');
let em; try { em = await memRun(true, 'mem-emb.db'); if (!em.embActive || em.embRows !== units.length) em.degraded = true; } catch (e) { em = { error: String(e.message).slice(0, 200) }; }

// doc-path hits from stage7b results
const docHits = (r, key) => Object.fromEntries(r.perQuestion.flatMap((p) => ['A', 'B'].map((w) => [`${p.id}/${w}`, p['hits' + w]])));
const methods = { 'doc-bm25': docHits(R7), 'doc-emb': R7.embeddings.ran ? docHits(R7.embeddings) : null, 'mem-bm25': bm.hits, 'mem-emb': em.hits ?? null };

// 3. metrics (same as 7b; optional gold ∪ extra)
const golds = (q, useExtra) => {
  const base = q.gold.map((g) => ({ ...g, id: sid(g.file, g.heading) }));
  const mappable = (g) => units.some((u) => u.file === g.file && u.heading === g.heading);
  const gl = base.map((g) => ({ ...g, mappable: mappable(g) }));
  if (useExtra) for (const e of EXTRA[q.id] ?? []) { const id = sid(e.file, e.heading); if (!gl.some((g) => g.id === id)) gl.push({ ...e, id, primary: false, mappable: true, extra: true }); }
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
function evalAll(useExtra) {
  const res = {};
  for (const [m, hits] of Object.entries(methods)) {
    if (!hits) { res[m] = null; continue; }
    res[m] = {};
    for (const w of ['A', 'B']) for (const g of ['all', 'single', 'multi']) {
      const qs = Q.filter((q) => g === 'all' || (g === 'multi') === multi[q.id]);
      const rows = qs.map((q) => metrics(hits[`${q.id}/${w}`], golds(q, useExtra)));
      res[m][`${w}/${g}`] = { n: qs.length, ...Object.fromEntries(MK.map((k) => [k, rows.reduce((a, r) => a + r[k], 0) / rows.length])) };
    }
  }
  return res;
}
const resBase = evalAll(false);
const resExtra = EXTRA ? evalAll(true) : null;
// sanity: re-derived doc-bm25 metrics must equal 7b's stored baseline
const chk = []; for (const w of ['A', 'B']) for (const [k, k7] of [['p1', 'p1'], ['p5', 'p5'], ['p10', 'p10'], ['any5', 'any5'], ['cov5', 'cov5'], ['cov10', 'cov10']]) { const a = resBase['doc-bm25'][`${w}/all`][k], b = R7.baseline.all[w][k7]; if (Math.abs(a - b) > 1e-9) chk.push(`${w}/${k}: ${a} vs 7b ${b}`); }
if (R7.embeddings.ran) for (const w of ['A', 'B']) for (const k of ['p1', 'p5', 'p10', 'any5', 'cov5', 'cov10']) { const a = resBase['doc-emb'][`${w}/all`][k], b = R7.embeddings.baseline.all[w][k]; if (Math.abs(a - b) > 1e-9) chk.push(`emb ${w}/${k}: ${a} vs 7b ${b}`); }

// 5. skipped docs + distinct files in top5
const skipDist = {};
for (const [m, hits] of Object.entries(methods)) {
  if (!hits) { skipDist[m] = null; continue; }
  let skipped = 0, total = 0, files = 0, cnt = 0;
  for (const v of Object.values(hits)) { const t = v.slice(0, 5); total += t.length; skipped += t.filter((s) => SKIPPED.has(s.split(' › ')[0].split('/').pop())).length; files += new Set(t.map((s) => s.split(' › ')[0])).size; cnt++; }
  skipDist[m] = { skippedDocSlots: skipped, top5Slots: total, skippedFrac: skipped / total, meanDistinctFiles: files / cnt };
}

// 4. hits.json
const hitsOut = {};
for (const q of Q) { hitsOut[q.id] = {}; for (const w of ['A', 'B']) { hitsOut[q.id][w] = {}; for (const [m, h] of Object.entries(methods)) hitsOut[q.id][w][m] = h ? h[`${q.id}/${w}`].slice(0, 5).map((s) => { const [file, ...r] = s.split(' › '); return { file, heading: r.join(' › ') }; }) : null; } }
writeFileSync(join(OUT, 'hits.json'), JSON.stringify(hitsOut, null, 1));

const out = { questionsSha256: QSHA, units: { total: units.length, h2: nH2, preambles: nPre, dupHeadingsDisambiguated: nDup }, store: { bm25: { stored: bm.stored, memFts: bm.ftsRows, embRows: bm.embRows }, emb: em.error ? { error: em.error } : { stored: em.stored, memFts: em.ftsRows, embRows: em.embRows, embeddingsActive: em.embActive, degraded: !!em.degraded } }, docPathRederiveMismatches: chk, metrics: resBase, metricsWithGoldExtra: resExtra, goldExtraPresent: !!EXTRA, skippedDocsAndDistinctFiles: skipDist };
writeFileSync(join(OUT, 'results.json'), JSON.stringify(out, null, 1));

const f = (x) => x.toFixed(3);
let rp = `# stage8 report\n\nUnits ${units.length} (H2 ${nH2}, preambles ${nPre}, dup-heading ids disambiguated ${nDup}); stored bm25=${bm.stored}, emb=${em.stored ?? em.error}; mem_embeddings rows emb=${em.embRows}\nDoc-path re-derivation mismatches vs 7b: ${chk.length ? chk.join('; ') : 'none'}\n\n`;
const tbl = (title, R) => { let s = `## ${title}\n| method | ask | group | p@1 | prim@5 | prim@10 | any@5 | cov@5 | cov@10 | goldfile@5 |\n|---|---|---|---|---|---|---|---|---|---|\n`; for (const m of Object.keys(R)) for (const w of ['A', 'B']) for (const g of ['all', 'single', 'multi']) { const x = R[m]?.[`${w}/${g}`]; if (x) s += `| ${m} | ${w} | ${g} (${x.n}) | ${MK.map((k) => f(x[k])).join(' | ')} |\n`; } return s + '\n'; };
rp += tbl('Against original gold', resBase); if (resExtra) rp += tbl('Against gold ∪ gold-extra', resExtra);
rp += `## Skipped-doc slots and distinct files (top 5, 200 slots/method)\n| method | skipped-doc slots | frac | mean distinct files |\n|---|---|---|---|\n`;
for (const [m, x] of Object.entries(skipDist)) if (x) rp += `| ${m} | ${x.skippedDocSlots}/${x.top5Slots} | ${f(x.skippedFrac)} | ${x.meanDistinctFiles.toFixed(2)} |\n`;
writeFileSync(join(OUT, 'report.md'), rp);
console.log(rp);
