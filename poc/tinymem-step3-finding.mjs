// Step 3: tabulate E vs B per question (from rows.json written by `tinymem-step1.mjs score`) and measure "finding cost" from traces.
// usage: STEP1_QDIR=<questions dir> node poc/tinymem-step3-finding.mjs <m3 dir>   -> prints tables, writes finding.json
// finding cost:  E = rank (1-based, order printed) of the first hit in E's FIRST recall whose file is a gold file (and whether its line range overlaps a gold range);
//                B = number of Grep/Glob calls up to and including the first call that touches a gold file (a Read of it, or a result that names it); null = never touched.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { homedir } from 'node:os';
const D = process.argv[2], QDIR = process.env.STEP1_QDIR ?? join(homedir(), '.cache/tinymem-probe/out/step3/questions');
const med = (a) => { a = a.filter(x => x != null).sort((x, y) => x - y); const m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : NaN; };
const Q = {}; for (const r of ['bareloop', 'bareagent']) for (const q of JSON.parse(readFileSync(join(QDIR, r + '.json')))) Q[q.id] = q;
const gold = (qid) => Q[qid].sources.map(s => { const [, p, a, b] = /^(.+):(\d+)-(\d+)$/.exec(s); return { p, a: +a, b: +b }; });
const rows = JSON.parse(readFileSync(join(D, 'rows.json')));
// ---- per-question E vs B wins
const qids = [...new Set(rows.map(r => r.qid))].sort(); let tot = { E: 0, B: 0, nE: 0, nB: 0 };
console.log('| qid | E wins | B wins |\n|---|---|---|');
for (const q of qids) { const w = (arm) => rows.filter(r => r.qid === q && r.arm === arm && r.win !== null); const e = w('E'), b = w('B');
  console.log(`| ${q} | ${e.filter(r => r.win).length}/${e.length} | ${b.filter(r => r.win).length}/${b.length} |`);
  tot.E += e.filter(r => r.win).length; tot.nE += e.length; tot.B += b.filter(r => r.win).length; tot.nB += b.length; }
console.log(`TOTAL E ${tot.E}/${tot.nE}  B ${tot.B}/${tot.nB}`);
// ---- finding cost
const out = [];
for (const f of readdirSync(join(D, 'runs')).filter(f => f.endsWith('.json'))) {
  const run = JSON.parse(readFileSync(join(D, 'runs', f))), G = gold(run.qid), isGold = (s) => G.some(g => s.includes(g.p.replace(/^docs\//, '')) || s.includes(g.p));
  const ev = readFileSync(join(D, 'traces', run.id + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const uses = {}, seq = [];
  for (const e of ev) for (const c of (e.message?.content ?? [])) {
    if (c.type === 'tool_use') { uses[c.id] = { name: c.name, input: c.input }; seq.push(c.id); }
    if (c.type === 'tool_result' && uses[c.tool_use_id]) { let s = c.content; if (Array.isArray(s)) s = s.map(x => x.text ?? '').join('\n'); uses[c.tool_use_id].res = String(s ?? ''); } }
  if (run.arm === 'E') { const first = seq.map(i => uses[i]).find(u => u.name === 'Bash' && / recall /.test(u.input?.command ?? '')); let rank = null, rankOverlap = null, nhits = 0;
    if (first?.res) { const hits = first.res.split('\n').map(l => l.split('\t')).filter(t => t.length >= 4); nhits = hits.length;
      hits.forEach((t, i) => { const m = /(\d+)-(\d+)$/.exec(t[3]); const path = t[2];
        if (rank == null && G.some(g => path === g.p)) rank = i + 1;
        if (rankOverlap == null && m && G.some(g => path === g.p && +m[1] <= g.b && +m[2] >= g.a)) rankOverlap = i + 1; }); }
    out.push({ id: run.id, qid: run.qid, arm: 'E', nhits, rank, rankOverlap }); }
  else if (run.arm === 'B') { let greps = 0, touch = null;
    for (const i of seq) { const u = uses[i]; if (u.name === 'Grep' || u.name === 'Glob') greps++;
      const hit = (u.name === 'Read' && isGold(u.input?.file_path ?? '')) || ((u.name === 'Grep' || u.name === 'Glob') && G.some(g => (u.res ?? '').includes(g.p)));
      if (hit) { touch = greps; break; } }
    out.push({ id: run.id, qid: run.qid, arm: 'B', greps: touch, totalGreps: seq.filter(i => ['Grep', 'Glob'].includes(uses[i].name)).length }); }
}
const E = out.filter(o => o.arm === 'E'), B = out.filter(o => o.arm === 'B');
console.log(`E first recall: gold FILE in list ${E.filter(o => o.rank != null).length}/${E.length}, median rank ${med(E.map(o => o.rank))}, rank-1 ${E.filter(o => o.rank === 1).length}, in top5 ${E.filter(o => o.rank != null && o.rank <= 5).length}; with line-range overlap: ${E.filter(o => o.rankOverlap != null).length}/${E.length}, median ${med(E.map(o => o.rankOverlap))}`);
console.log(`B greps to first gold touch: touched ${B.filter(o => o.greps != null).length}/${B.length}, median ${med(B.map(o => o.greps))}, mean ${(B.filter(o => o.greps != null).reduce((a, o) => a + o.greps, 0) / (B.filter(o => o.greps != null).length || 1)).toFixed(2)}, 1 grep ${B.filter(o => o.greps === 1).length}, >=3 greps ${B.filter(o => o.greps >= 3).length}; median total greps/run ${med(B.map(o => o.totalGreps))}`);
writeFileSync(join(D, 'finding.json'), JSON.stringify(out, null, 1));
