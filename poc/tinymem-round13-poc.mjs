// Throwaway POC: round 13 — SHIPPED whole-file doc search (ctx.index() + recall kind:'doc') as baseline on round-12 fresh questions.
// F1 embeddings off | F2 embeddings on. STRICT = right file AND chunk.startLine == primary.line-1; FILE = right file only.
// Also re-runs round-12 S1/S4 on 5 questions per corpus (against the saved round-12 sections dbs, read-only copies) to confirm reproduction.
import { LiteCtx } from '../src/index.js';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const BASE = join(homedir(), '.cache/tinymem-probe/out'), S12 = join(BASE, 'stage12'), OUT = join(BASE, 'stage13'), QDIR = join(S12, 'questions'), S7CORPUS = join(BASE, 'stage7b/corpus');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const chk = (p, h) => { if (sha(readFileSync(p)) !== h) throw new Error('hash mismatch ' + p); };
chk(join(QDIR, 'bareloop.json'), 'cce11be3d46c2dba3baef4196cdaa76f70583924b189e65b9a4a0a70c42d8085');
chk(join(QDIR, 'bareagent.json'), 'd6cb21d8400057b80949efa3fc08c1486bd5aa4f90e48fb45aa0a0eac53103c7');
const BA = join(homedir(), 'PycharmProjects/bareagent'), BA_HEAD = '4de9da273f940b3106ff59526cdefe22015b1e24';
if (execFileSync('git', ['-C', BA, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== BA_HEAD) throw new Error('bareagent HEAD mismatch');
mkdirSync(OUT, { recursive: true });

// ---- corpora: identical loaders to round 12 ----
const loadBareloop = () => { const o = {}; for (const d of ['wiki', 'product', 'logs']) for (const f of readdirSync(join(S7CORPUS, d)).filter((x) => x.endsWith('.md')).sort()) o[`${d}/${f}`] = readFileSync(join(S7CORPUS, d, f), 'utf8'); return o; };
const EXCL = { 'CHANGELOG.md': 1, 'docs/index.md': 1, 'docs/archive/wiki-index.md': 1 };
const loadBareagent = () => { const o = {}; for (const f of execFileSync('git', ['-C', BA, 'ls-files', '*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort()) {
  if (f.startsWith('node_modules/') || f.includes('/node_modules/') || EXCL[f]) continue;
  o[f] = execFileSync('git', ['-C', BA, 'show', `HEAD:${f}`], { encoding: 'utf8', maxBuffer: 1 << 26 }); } return o; };

const metrics = (rank) => ({ rank, p1: +(rank === 1), p5: +(rank >= 1 && rank <= 5), p10: +(rank >= 1 && rank <= 10), rr: rank >= 1 && rank <= 10 ? 1 / rank : 0 });
const aggOf = (ranks) => { const ms = Object.values(ranks).map(metrics), n = ms.length; return { n, p1: ms.reduce((a, m) => a + m.p1, 0), p5: ms.reduce((a, m) => a + m.p5, 0), p10: ms.reduce((a, m) => a + m.p10, 0), mrr10: +(ms.reduce((a, m) => a + m.rr, 0) / n).toFixed(4) }; };
const r12 = JSON.parse(readFileSync(join(S12, 'results.json')));

async function runCorpus(name, files) {
  const Q = JSON.parse(readFileSync(join(QDIR, name + '.json')));
  const root = join(OUT, 'root-' + name); rmSync(root, { recursive: true, force: true });
  for (const [f, t] of Object.entries(files)) { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), t); }
  const res = { name, nQuestions: Q.length, nFiles: Object.keys(files).length, F: {}, ranksStrict: {}, ranksFile: {}, wrongSection: {}, repro: {} };
  const ctxs = {};
  for (const [cfg, emb] of [['F1', false], ['F2', true]]) {
    const dbPath = join(OUT, `whole-${name}-${cfg}.db`); for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
    const ctx = new LiteCtx({ root, dbPath, embeddings: emb }); if (emb) await ctx._embedSafe('warm up the model');
    const ir = await ctx.index();
    const nDoc = ctx.store.db.prepare("SELECT COUNT(*) c FROM docs WHERE kind='doc'").get().c;
    if (nDoc !== res.nFiles) throw new Error(`${name} ${cfg}: indexed docs ${nDoc} != corpus files ${res.nFiles}`);
    const rS = {}, rF = {}; let inTop5 = 0, rightSec = 0;
    for (const q of Q) {
      const hits = await ctx.recall(q.question, { kind: 'doc', n: 10, log: false });
      rF[q.id] = hits.findIndex((h) => h.path === q.primary.path) + 1;
      rS[q.id] = hits.findIndex((h) => h.path === q.primary.path && h.chunk && h.chunk.startLine === q.primary.line - 1) + 1;
      if (rF[q.id] >= 1 && rF[q.id] <= 5) { inTop5++; const h = hits[rF[q.id] - 1]; if (h.chunk && h.chunk.startLine === q.primary.line - 1) rightSec++; }
    }
    res.F[cfg] = { strict: aggOf(rS), file: aggOf(rF) }; res.ranksStrict[cfg] = rS; res.ranksFile[cfg] = rF;
    res.wrongSection[cfg] = { fileInTop5: inTop5, chunkCorrect: rightSec, chunkWrongOrNull: inTop5 - rightSec };
    res.indexed = ir; ctxs[cfg] = ctx;
  }
  // round-12 S1/S4 reproduction on first 5 questions, using saved round-12 sections db (copied; read-only use)
  const r12c = r12.corpora.find((c) => c.name === name);
  const sdb = join(OUT, `repro-${name}.db`); for (const s of ['', '-wal', '-shm']) rmSync(sdb + s, { force: true }); copyFileSync(join(S12, `sections-${name}.db`), sdb);
  const rroot = join(OUT, 'root-repro-' + name); mkdirSync(rroot, { recursive: true });
  const on = new LiteCtx({ root: rroot, dbPath: sdb, embeddings: true }); await on._embedSafe('warm up the model');
  const off = new LiteCtx({ root: rroot, dbPath: sdb, embeddings: false });
  const rp = [];
  for (const q of Q.slice(0, 5)) {
    const pre = `${q.primary.path}#${q.primary.line - 1}-`;
    const rk = async (c) => ((await c.recall(q.question, { kind: 'doc', n: 50, log: false })).findIndex((h) => h.path.startsWith(pre)) + 1);
    const s1 = await rk(off), s4 = await rk(on);
    rp.push({ q: q.id, s1, s1_r12: r12c.ranks.S1[q.id], s4, s4_r12: r12c.ranks.S4[q.id], match: s1 === r12c.ranks.S1[q.id] && s4 === r12c.ranks.S4[q.id] });
  }
  res.repro = { questions: rp, allMatch: rp.every((x) => x.match) };
  res.S12 = { S1: r12c.agg.S1, S4: r12c.agg.S4 };
  res.passBar = { S4_minus_F2_strict_p5: r12c.agg.S4.p5 - res.F.F2.strict.p5, S1_minus_F1_strict_p5: r12c.agg.S1.p5 - res.F.F1.strict.p5 };
  res.passBar.meets = res.passBar.S4_minus_F2_strict_p5 >= 3 && res.passBar.S1_minus_F1_strict_p5 >= 3;
  return res;
}
const R = [await runCorpus('bareloop', loadBareloop()), await runCorpus('bareagent', loadBareagent())];
const verdict = R.every((r) => r.passBar.meets) ? 'CONFIRMED' : 'NOT CONFIRMED';
const bar = 'Sections beat whole files if, on BOTH corpora, round-12 S4 (sections + embeddings) beats F2 (STRICT) on primary@5 by >= 3 of 30, AND S1 beats F1 (STRICT) by >= 3 of 30. Tie or smaller margin on either corpus = NOT CONFIRMED.';
const out = { bar, verdict, corpora: R };
const rj = JSON.stringify(out, null, 1); writeFileSync(join(OUT, 'results.json'), rj);
let rp = `# stage13 report (round 13)\n\nBar: ${bar}\n\nVerdict: **${verdict}**\n`;
for (const r of R) { rp += `\n## ${r.name} (${r.nQuestions} questions, ${r.nFiles} files)\n\n| cfg | p@1 | p@5 | p@10 | MRR@10 |\n|---|---|---|---|---|\n`;
  for (const c of ['F1', 'F2']) for (const m of ['strict', 'file']) { const a = r.F[c][m]; rp += `| ${c} ${m} | ${a.p1} | ${a.p5} | ${a.p10} | ${a.mrr10} |\n`; }
  for (const c of ['S1', 'S4']) { const a = r.S12[c]; rp += `| ${c} (round 12) | ${a.p1} | ${a.p5} | ${a.p10} | ${a.mrr10} |\n`; }
  rp += `\nPass-bar margins: ${JSON.stringify(r.passBar)}\nRight file in top 5 -> chunk pointer correct: ${JSON.stringify(r.wrongSection)}\nS1/S4 reproduction (5 qs): allMatch=${r.repro.allMatch} ${JSON.stringify(r.repro.questions)}\n`; }
writeFileSync(join(OUT, 'report.md'), rp);
console.log(rp); console.log(JSON.stringify({ resultsSha: sha(rj), reportSha: sha(rp) }));
