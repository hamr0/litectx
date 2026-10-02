// Throwaway POC: does shipped litectx recall find sources for frozen real questions, and does a
// page grown from askA help askB? Outputs only to ~/.cache/tinymem-probe/out/stage7b/.
import { LiteCtx } from '../src/index.js';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const OUT = join(homedir(), '.cache/tinymem-probe/out/stage7b');
const SRC = join(homedir(), '.cache/tinymem-probe/frozen/docs');
const CORPUS = join(OUT, 'corpus');
const QSHA = '2c38c60040edbcecf277956e4899b335c1119e30e6d039f1679fd05ce97c62fc';
const qraw = readFileSync(join(OUT, 'questions.json'));
if (createHash('sha256').update(qraw).digest('hex') !== QSHA) throw new Error('questions.json hash mismatch');
const Q = JSON.parse(qraw);

// 1. filtered corpus copy (no archive, no top-level generated files)
rmSync(CORPUS, { recursive: true, force: true });
let nCopied = 0;
for (const d of ['wiki', 'product', 'logs']) {
  mkdirSync(join(CORPUS, d), { recursive: true });
  for (const f of readdirSync(join(SRC, d)).filter((f) => f.endsWith('.md')).sort()) { copyFileSync(join(SRC, d, f), join(CORPUS, d, f)); nCopied++; }
}
// H2 map per file (fence-aware)
const h2 = {}; // file -> [{line(1-based), heading}]
for (const d of ['wiki', 'product', 'logs']) for (const f of readdirSync(join(CORPUS, d)).sort()) {
  const rel = `${d}/${f}`; const L = readFileSync(join(CORPUS, rel), 'utf8').split('\n'); const arr = []; let fence = false;
  L.forEach((ln, i) => { if (/^\s*(```|~~~)/.test(ln)) fence = !fence; else if (!fence && /^## /.test(ln)) arr.push({ line: i + 1, heading: ln.slice(3).trim() }); });
  h2[rel] = arr;
}
const sid = (file, heading) => `${file} › ${heading}`;
function sectionOf(file, startLine) { // chunk start line (API is 0-based; +1 applied) -> containing H2
  const a = h2[file] ?? []; let cur = null;
  for (const s of a) if (s.line <= startLine) cur = s; else break;
  return cur ? sid(file, cur.heading) : sid(file, '(preamble)');
}

const STOP = new Set(('a an the and or but if of to in on at by for with from as is are was were be been being do does did done doing have has had having it its this that these those we our us you your they them their he she his her i me my not no yes so than then there here what which who whom whose when where why how can could should would will shall may might must about into over under out up down off again also just more most some any all each such only own same too very via vs per after before during between both few other than s t').split(/\s+/));
const terms = (s) => [...new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)))];

async function runMode(embeddings, dbName) {
  const dbPath = join(OUT, dbName);
  for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
  const ctx = new LiteCtx({ root: CORPUS, dbPath, embeddings });
  const r = await ctx.index();
  const nodes = ctx.store.db.prepare("SELECT COUNT(*) c FROM nodes").get().c;
  const filesWithNodes = ctx.store.db.prepare("SELECT COUNT(DISTINCT path) c FROM nodes").get().c;
  const idx = { filesIndexed: r.files, added: r.added, expectedFiles: nCopied, nodes, filesWithNodes, h2Total: Object.values(h2).reduce((a, b) => a + b.length, 0) };
  if (r.files !== nCopied || r.added !== nCopied || filesWithNodes !== nCopied || nodes < nCopied) throw new Error('index size check failed ' + JSON.stringify(idx));
  const cache = new Map();
  async function ask(q) {
    if (cache.has(q)) return cache.get(q);
    const hits = await ctx.recall(q, { kind: 'doc', n: 10 });
    const res = hits.map((h) => ({ file: h.path, sec: h.chunk ? sectionOf(h.path, h.chunk.startLine + 1) : sid(h.path, '(no-chunk)'), sym: h.chunk?.symbol ?? null, ptr: Buffer.byteLength(JSON.stringify({ path: h.path, chunk: h.chunk })) }));
    cache.set(q, res); return res;
  }
  // sanity: symbol of chunk == mapped H2 heading when symbol is itself an H2 heading
  let symChecked = 0, symMismatch = 0;
  const per = [];
  for (const q of Q) {
    const gold = q.gold.map((g) => ({ ...g, id: sid(g.file, g.heading), mappable: (h2[g.file] ?? []).some((s) => s.heading === g.heading) }));
    const rec = { id: q.id, topic: q.topic, multi: new Set(q.gold.map((g) => g.file)).size > 1, gold, unmappable: gold.filter((g) => !g.mappable).map((g) => g.id) };
    for (const w of ['A', 'B']) {
      const res = await ask(q['ask' + w]);
      for (const h of res) if (h.sym && (h2[h.file] ?? []).some((s) => s.heading === h.sym)) { symChecked++; if (h.sec !== sid(h.file, h.sym)) symMismatch++; }
      rec['hits' + w] = res;
    }
    per.push(rec);
  }
  const metrics = (secs, rec) => { // secs: ordered section ids list (already cut)
    const goldIds = rec.gold.filter((g) => g.mappable).map((g) => g.id); const prim = rec.gold.find((g) => g.primary);
    const uniq = [...new Set(secs)];
    const cov = (k) => goldIds.filter((g) => uniq.slice(0, k).includes(g)).length / rec.gold.length;
    const pr = prim.mappable ? secs.indexOf(prim.id) + 1 : 0; // 0 = absent
    return { primRank: pr, p1: pr === 1, p5: pr >= 1 && pr <= 5, p10: pr >= 1 && pr <= 10, any5: goldIds.some((g) => secs.slice(0, 5).includes(g)), cov5: cov(5), cov10: cov(10) };
  };
  for (const rec of per) for (const w of ['A', 'B']) { rec['base' + w] = metrics(rec['hits' + w].map((h) => h.sec), rec); rec['ptr' + w] = rec['hits' + w].slice(0, 5).reduce((a, h) => a + h.ptr, 0); }
  const agg = (arr, f) => arr.length ? arr.reduce((a, r) => a + f(r), 0) / arr.length : null;
  const groups = { all: per, single: per.filter((r) => !r.multi), multi: per.filter((r) => r.multi) };
  const baseline = {};
  for (const [gn, g] of Object.entries(groups)) { baseline[gn] = { n: g.length }; for (const w of ['A', 'B']) baseline[gn][w] = { p1: agg(g, (r) => +r['base' + w].p1), p5: agg(g, (r) => +r['base' + w].p5), p10: agg(g, (r) => +r['base' + w].p10), any5: agg(g, (r) => +r['base' + w].any5), cov5: agg(g, (r) => r['base' + w].cov5), cov10: agg(g, (r) => r['base' + w].cov10), meanPtrBytesTop5: agg(g, (r) => r['ptr' + w]) }; }

  // 4. grow
  const goldIdsOf = (rec) => new Set(rec.gold.map((g) => g.id));
  const pagesFor = (variant) => {
    const pages = {};
    for (const rec of per) {
      const top = rec.hitsA.map((h) => h.sec); let leaves;
      if (variant === 'realistic') leaves = [...new Set(top.slice(0, 3))];
      else { const gi = goldIdsOf(rec); leaves = [...new Set(top.slice(0, 5))].filter((s) => gi.has(s)); }
      const qq = Q.find((x) => x.id === rec.id);
      pages[rec.id] = leaves.length ? { id: rec.id, topic: qq.topic, leaves, terms: new Set([...terms(qq.topic), ...terms(qq.askA)]) } : null;
    }
    return pages;
  };
  const grow = {}; const growPer = {};
  for (const variant of ['realistic', 'oracle']) {
    const pages = pagesFor(variant); const pl = Object.values(pages).filter(Boolean);
    grow[variant] = { pagesBuilt: pl.length, emptyPages: Object.entries(pages).filter(([, p]) => !p).map(([k]) => k) };
    const modes = { nopage: null, leaf: null, term: null };
    for (const mode of Object.keys(modes)) {
      const rows = [];
      for (const rec of per) {
        const q = Q.find((x) => x.id === rec.id); const s5 = rec.hitsB.slice(0, 5).map((h) => h.sec); let chosen = null;
        if (mode === 'leaf') { // page with most leaves in askB top5; tie -> best (lowest) rank of an overlapping hit, then id
          let best = null;
          for (const p of pl) { const ov = s5.map((s, i) => [s, i]).filter(([s]) => p.leaves.includes(s)); if (!ov.length) continue; const key = [-ov.length, ov[0][1], p.id]; if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) best = { p, key }; }
          chosen = best?.p ?? null;
        } else if (mode === 'term') { // page with most shared content terms (topic + askA terms vs askB terms); tie -> id
          const bt = terms(q.askB); let best = null;
          for (const p of pl) { const sh = bt.filter((t) => p.terms.has(t)).length; if (sh < 1) continue; if (!best || sh > best.sh || (sh === best.sh && p.id < best.p.id)) best = { p, sh }; }
          chosen = best?.p ?? null;
        }
        // merge: page leaves first (askA order), then askB recall in order, dedup, cut to 5
        const list = chosen ? [...new Set([...chosen.leaves, ...rec.hitsB.map((h) => h.sec)])].slice(0, 5) : [...new Set(rec.hitsB.map((h) => h.sec))].slice(0, 5);
        const m = metrics(list, rec); const gi = goldIdsOf(rec);
        const injected = chosen ? chosen.leaves.filter((l) => !s5.includes(l)) : [];
        rows.push({ id: rec.id, matched: !!chosen, page: chosen?.id ?? null, right: chosen?.id === rec.id, wrong: !!chosen && chosen.id !== rec.id, list, ...m, injected: injected.length, injectedNonGold: injected.filter((l) => !gi.has(l)).length, leavesNonGold: chosen ? chosen.leaves.filter((l) => !gi.has(l)).length : 0 });
      }
      growPer[`${variant}/${mode}`] = rows;
      const ag = (f) => agg(rows, f);
      grow[variant][mode] = { pageMatchRate: ag((r) => +r.matched), rightPage: rows.filter((r) => r.right).length, wrongPage: rows.filter((r) => r.wrong).length, cov5: ag((r) => r.cov5), primIn5: ag((r) => +r.p5), p1: ag((r) => +r.p1), any5: ag((r) => +r.any5), injectedLeavesTotal: rows.reduce((a, r) => a + r.injected, 0), injectedNonGoldTotal: rows.reduce((a, r) => a + r.injectedNonGold, 0), meanNonGoldInjectedPerQ: ag((r) => r.injectedNonGold), meanNonGoldPerMatchedQ: (() => { const m = rows.filter((r) => r.matched); return m.length ? m.reduce((a, r) => a + r.injectedNonGold, 0) / m.length : null; })() };
      if (mode !== 'nopage') { const np = growPer[`${variant}/nopage`]; grow[variant][mode].vsNoPage = { cov5Better: rows.filter((r, i) => r.cov5 > np[i].cov5).length, cov5Worse: rows.filter((r, i) => r.cov5 < np[i].cov5).length, primGained: rows.filter((r, i) => r.p5 && !np[i].p5).length, primLost: rows.filter((r, i) => !r.p5 && np[i].p5).length }; }
    }
  }
  ctx.store.db.close?.();
  return { idx, symChecked, symMismatch, baseline, grow, per, growPer };
}

const strip = (x) => JSON.parse(JSON.stringify(x));
const out = { questionsSha256: QSHA, corpusFiles: nCopied };
const prim = await runMode(false, 'bm25.db');
out.index = prim.idx; out.symbolCheck = { checked: prim.symChecked, mismatch: prim.symMismatch };
out.baseline = prim.baseline; out.grow = prim.grow;
out.perQuestion = prim.per.map((r) => ({ id: r.id, topic: r.topic, multi: r.multi, unmappable: r.unmappable, baseA: r.baseA, baseB: r.baseB, hitsA: r.hitsA.map((h) => h.sec), hitsB: r.hitsB.map((h) => h.sec), ptrA: r.ptrA, ptrB: r.ptrB }));
out.growPerQuestion = Object.fromEntries(Object.entries(prim.growPer).map(([k, v]) => [k, v.map(({ id, matched, page, right, list, p5, cov5, injected, injectedNonGold }) => ({ id, matched, page, right, list, p5, cov5, injected, injectedNonGold }))]));
out.unmappableGold = prim.per.flatMap((r) => r.unmappable);
// secondary: embeddings
try {
  const emb = await runMode(true, 'emb.db');
  out.embeddings = { ran: true, baseline: emb.baseline, grow: emb.grow, perQuestion: emb.per.map((r) => ({ id: r.id, baseA: r.baseA, baseB: r.baseB, hitsA: r.hitsA.map((h) => h.sec), hitsB: r.hitsB.map((h) => h.sec) })) };
} catch (e) { out.embeddings = { ran: false, reason: String(e.message).slice(0, 200) }; }
writeFileSync(join(OUT, 'results.json'), JSON.stringify(strip(out), null, 1));

// per-question.md (ids, ranks, file › heading only)
let md = '# per-question (ids, ranks, file › heading only)\n\n';
for (const r of out.perQuestion) {
  md += `## ${r.id} (${r.multi ? 'multi' : 'single'}-file) — ${r.topic}\n`;
  if (r.unmappable.length) md += `UNMAPPABLE gold: ${r.unmappable.join(' | ')}\n`;
  for (const w of ['A', 'B']) { const b = r['base' + w]; md += `- ask${w}: primary rank ${b.primRank || 'absent(top10)'}; cov@5 ${b.cov5.toFixed(2)}; cov@10 ${b.cov10.toFixed(2)}\n`; r['hits' + w].slice(0, 5).forEach((s, i) => { md += `    ${i + 1}. ${s}\n`; }); }
  md += '\n';
}
writeFileSync(join(OUT, 'per-question.md'), md);

// report.md
const f = (x) => x == null ? '-' : x.toFixed(3);
let rp = `# stage7b report\n\nIndex: ${JSON.stringify(out.index)}\nSymbol/range mapping check: ${JSON.stringify(out.symbolCheck)}\nUnmappable gold: ${out.unmappableGold.length ? out.unmappableGold.join('; ') : 'none'}\n\n`;
const bt = (title, B) => { let s = `## ${title}\n| group | ask | p@1 | p@5 | p@10 | any@5 | cov@5 | cov@10 | ptr bytes top5 |\n|---|---|---|---|---|---|---|---|---|\n`; for (const g of ['all', 'single', 'multi']) for (const w of ['A', 'B']) { const m = B[g][w]; s += `| ${g} (n=${B[g].n}) | ${w} | ${f(m.p1)} | ${f(m.p5)} | ${f(m.p10)} | ${f(m.any5)} | ${f(m.cov5)} | ${f(m.cov10)} | ${m.meanPtrBytesTop5.toFixed(0)} |\n`; } return s + '\n'; };
rp += bt('Baseline (BM25, embeddings off)', out.baseline);
if (out.embeddings.ran) rp += bt('Baseline (embeddings ON)', out.embeddings.baseline); else rp += `## Embeddings: not run (${out.embeddings.reason})\n\n`;
const gt = (title, G) => { let s = `## ${title}\n| variant | way | page match | right/wrong | cov@5 | prim in 5 | p@1 | nonGold injected/q | cov better/worse | prim gained/lost |\n|---|---|---|---|---|---|---|---|---|---|\n`; for (const v of ['realistic', 'oracle']) for (const m of ['nopage', 'leaf', 'term']) { const x = G[v][m]; s += `| ${v} (pages ${G[v].pagesBuilt}) | ${m} | ${f(x.pageMatchRate)} | ${x.rightPage}/${x.wrongPage} | ${f(x.cov5)} | ${f(x.primIn5)} | ${f(x.p1)} | ${f(x.meanNonGoldInjectedPerQ)} | ${x.vsNoPage ? x.vsNoPage.cov5Better + '/' + x.vsNoPage.cov5Worse : '-'} | ${x.vsNoPage ? x.vsNoPage.primGained + '/' + x.vsNoPage.primLost : '-'} |\n`; } return s + '\n'; };
rp += gt('Grow + askB (BM25)', out.grow);
rp += `Method: hits are file-level (one best chunk per file); chunk -> H2 by fence-aware line range (chunk start line within the last H2 at or before it). Merge: chosen page leaves (askA rank order) first, then askB recall order, dedup, cut to 5. Leaf-overlap pick: most page leaves in askB top5, tie by best overlapping rank then id. Term-overlap pick: most shared content terms (askB vs topic + askA terms, stopwords out, len>=3, no stemming), tie by id. Realistic = askA top 3; oracle = gold sections in askA top 5 (empty -> no page). Empty oracle pages: ${out.grow.oracle.emptyPages.join(',') || 'none'}.\n`;
writeFileSync(join(OUT, 'report.md'), rp);
console.log(rp);
