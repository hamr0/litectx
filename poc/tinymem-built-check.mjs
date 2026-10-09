// Round 14: score the BUILT code (ctx.index() with per-section md rows + recall kind:'doc') on the round-12 fresh
// questions, the STRICT way (hit.path == primary.path && hit.chunk.startLine == primary.line-1), embeddings off and on.
// Same corpora/loaders/question files as round 13 (hash-pinned). Also times the cold first index and records db size.
// Expect ~22/19 (off) and ~25/23 (on) of 30 for bareloop/bareagent (the round-12 sections numbers).
import { LiteCtx } from '../src/index.js';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const BASE = join(homedir(), '.cache/tinymem-probe/out'), S12 = join(BASE, 'stage12'), OUT = join(BASE, 'stage14'), QDIR = join(S12, 'questions'), S7CORPUS = join(BASE, 'stage7b/corpus');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const chk = (p, h) => { if (sha(readFileSync(p)) !== h) throw new Error('hash mismatch ' + p); };
chk(join(QDIR, 'bareloop.json'), 'cce11be3d46c2dba3baef4196cdaa76f70583924b189e65b9a4a0a70c42d8085');
chk(join(QDIR, 'bareagent.json'), 'd6cb21d8400057b80949efa3fc08c1486bd5aa4f90e48fb45aa0a0eac53103c7');
const BA = join(homedir(), 'PycharmProjects/bareagent'), BA_HEAD = '4de9da273f940b3106ff59526cdefe22015b1e24';
if (execFileSync('git', ['-C', BA, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== BA_HEAD) throw new Error('bareagent HEAD mismatch');
mkdirSync(OUT, { recursive: true });

const loadBareloop = () => { const o = {}; for (const d of ['wiki', 'product', 'logs']) for (const f of readdirSync(join(S7CORPUS, d)).filter((x) => x.endsWith('.md')).sort()) o[`${d}/${f}`] = readFileSync(join(S7CORPUS, d, f), 'utf8'); return o; };
const EXCL = { 'CHANGELOG.md': 1, 'docs/index.md': 1, 'docs/archive/wiki-index.md': 1 };
const loadBareagent = () => { const o = {}; for (const f of execFileSync('git', ['-C', BA, 'ls-files', '*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()) {
  if (f.startsWith('node_modules/') || f.includes('/node_modules/') || EXCL[f]) continue;
  o[f] = execFileSync('git', ['-C', BA, 'show', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 1 << 26 }); } return o; };

const agg = (ranks) => { const r = Object.values(ranks); return { p1: r.filter((x) => x === 1).length, p5: r.filter((x) => x >= 1 && x <= 5).length, p10: r.filter((x) => x >= 1 && x <= 10).length }; };
const dbBytes = (p) => ['', '-wal', '-shm'].reduce((a, s) => { try { return a + statSync(p + s).size; } catch { return a; } }, 0);

async function runCorpus(name, files) {
  const Q = JSON.parse(readFileSync(join(QDIR, name + '.json')));
  const root = join(OUT, 'root-' + name); rmSync(root, { recursive: true, force: true });
  for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), t); }
  const res = { name, nQuestions: Q.length, nFiles: Object.keys(files).length };
  for (const [cfg, emb] of [['off', false], ['on', true]]) {
    const dbPath = join(OUT, `built-${name}-${cfg}.db`); for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    const ctx = new LiteCtx({ root, dbPath, embeddings: emb });
    if (emb) await ctx._embedSafe('warm up the model'); // model load excluded from the index timing
    const t0 = Date.now(); const ir = await ctx.index(); const indexMs = Date.now() - t0;
    const nDocRows = ctx.store.db.prepare("SELECT COUNT(*) c FROM doc_fts WHERE kind='doc'").get().c;
    const rS = {}, rF = {}; let nullChunk = 0;
    for (const q of Q) {
      const hits = await ctx.recall(q.question, { kind: 'doc', n: 10, log: false });
      rF[q.id] = hits.findIndex((h) => h.path === q.primary.path) + 1;
      rS[q.id] = hits.findIndex((h) => h.path === q.primary.path && h.chunk && h.chunk.startLine === q.primary.line - 1) + 1;
      nullChunk += hits.filter((h) => !h.chunk).length;
    }
    res[cfg] = { strict: agg(rS), file: agg(rF), indexMs, indexResult: ir, docRows: nDocRows, sectionVectors: ctx.store.sectionEmbeddingCount(), hitsWithNullChunk: nullChunk, dbBytes: dbBytes(dbPath), ranksStrict: rS };
    ctx.close();
  }
  return res;
}
const R = [await runCorpus('bareloop', loadBareloop()), await runCorpus('bareagent', loadBareagent())];
writeFileSync(join(OUT, 'built-check.json'), JSON.stringify(R, null, 1));
for (const r of R) {
  console.log(`\n${r.name} (${r.nQuestions} questions, ${r.nFiles} files)`);
  for (const c of ['off', 'on']) { const x = r[c]; console.log(`  ${c}: STRICT p1 ${x.strict.p1} p5 ${x.strict.p5} p10 ${x.strict.p10} | FILE p5 ${x.file.p5} | index ${(x.indexMs / 1000).toFixed(1)}s, ${x.docRows} doc rows, ${x.sectionVectors} section vecs, db ${(x.dbBytes / 1048576).toFixed(1)} MB, null-chunk hits ${x.hitsWithNullChunk}`); }
}
