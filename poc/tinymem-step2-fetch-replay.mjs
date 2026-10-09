// POC: offline replay of every lx3 `get` call in the M2 arm-E traces under alternative doc-fetch policies. No LLM, no network.
// usage: node poc/tinymem-step2-fetch-replay.mjs [out-root=~/.cache/tinymem-probe/out]  -> prints table + writes <out>/step2/m2/replay.md
// Policies (doc files only): P0 as run (prev section + requested + 60 fwd lines); P1 requested only; P2 prev+req+next section;
// P3 requested + next section; P4 prev + requested + 20 fwd lines. Read/Grep/recall output kept as-is (reading.json).
// Coverage follows /dinv/cov.mjs: lines seen = Read ranges + get ranges; recall/Grep text is not counted. Offline: calls held fixed.
import { readFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path'; import { createRequire } from 'node:module';
const Database = createRequire(import.meta.url)('better-sqlite3');
const O = process.argv[2] ?? join(process.env.HOME, '.cache/tinymem-probe/out'), M = join(O, 'step2/m2'), S = join(O, 'step2');
const med = a => { a = [...a].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const reading = JSON.parse(readFileSync(join(M, 'reading.json')));
const Q = {}; for (const r of ['bareloop', 'bareagent']) for (const q of JSON.parse(readFileSync(join(S, `questions/${r}.json`)))) Q[q.id] = q;
const dbs = {}; const db = r => dbs[r] ??= new Database(join(S, `${r}-docs/lroot/.litectx/index.db`), { readonly: true });
const nl = s => s ? s.split('\n').length : 0;
const POL = { P0: 'as run (prev + req + 60 fwd)', P1: 'requested only', P2: 'prev + req + next', P3: 'req + next', P4: 'prev + req + 20 fwd' };
// render a get result: header + requested body, then extras; returns {text, ranges (1-based inclusive)}
function render(repo, path, A, B, pol) {
  const rows = db(repo).prepare("SELECT start_line s,end_line e,symbol,body FROM nodes WHERE path=? AND kind='doc' ORDER BY start_line").all(path);
  const i = rows.findIndex(r => r.s === A - 1 && r.e === B - 1); if (i < 0) return null;
  let t = `doc/md\tfile\t${path}\n${rows[i].body}`; const rg = [[A, B]];
  const sec = (r, lab) => { t += `\n\n--- ${lab} SECTION (--lines ${r.s + 1}-${r.e + 1}, section "${r.symbol}") ---\n${r.body}`; rg.push([r.s + 1, r.e + 1]); };
  const fwd = n => { const L = readFileSync(join(S, `${repo}-docs/lroot`, path), 'utf8').split('\n'); if (L.at(-1) === '') L.pop();
    const from = B, to = Math.min(L.length - 1, B - 1 + n); if (from > to) { t += '\n\n--- FOLLOWING TEXT: none (end of file) ---'; return; }
    t += `\n\n--- FOLLOWING TEXT (--lines ${from + 1}-${to + 1}) ---\n${L.slice(from, to + 1).join('\n')}`; rg.push([from + 1, to + 1]); };
  const prev = rows[i - 1], next = rows[i + 1];
  if (pol === 'P0' || pol === 'P4') { if (prev) sec(prev, 'PREVIOUS'); fwd(pol === 'P0' ? 60 : 20); }
  if (pol === 'P2') { if (prev) sec(prev, 'PREVIOUS'); if (next) sec(next, 'NEXT'); }
  if (pol === 'P3' && next) sec(next, 'NEXT');
  return { t, rg };
}
const per = []; let mism = [], calls = 0, nochunk = 0, p0diff = 0;
for (const r of reading.filter(x => x.arm === 'E')) {
  const repo = r.id.split('-')[0], q = Q[r.id.split('.')[0]];
  const ev = readFileSync(join(M, 'traces', r.id + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const use = {}, reads = []; const gets = []; // gets: {path,A,B,actual}
  for (const e of ev) for (const c of (e.message?.content ?? [])) {
    if (c.type === 'tool_use') use[c.id] = c;
    if (c.type === 'tool_result' && use[c.tool_use_id]) { const u = use[c.tool_use_id]; let s = c.content; if (Array.isArray(s)) s = s.map(x => x.text ?? '').join('\n'); s = String(s ?? '');
      if (u.name === 'Read') { const p = u.input.file_path.replace(/^.*\/corpus\//, ''); const a = u.input.offset ?? 1; reads.push([p, a, a + Math.min(u.input.limit ?? 2000, nl(s)) - 1]); }
      if (u.name === 'Bash' && / get /.test(u.input.command)) { const m = u.input.command.match(/ get (\S+)(?:.*--lines (\d+)-(\d+))?/); gets.push({ path: m[1], A: +m[2], B: +m[3], actual: nl(s), err: /no chunk at/.test(s) }); } } }
  const res = {};
  for (const pol of Object.keys(POL)) {
    let getLines = 0; const seen = reads.map(([f, a, b]) => ({ f, a, b }));
    for (const g of gets) { if (pol === 'P0') { calls++; nochunk += g.err; }
      if (g.err || !g.A) { getLines += g.actual; continue; }
      const o = render(repo, g.path, g.A, g.B, pol); if (!o) { getLines += g.actual; mism.push(`${r.id} ${g.path} ${g.A}-${g.B} no node`); continue; }
      const n = nl(o.t.replace(/\n+$/, '')); getLines += n; o.rg.forEach(([a, b]) => seen.push({ f: g.path, a, b }));
      if (pol === 'P0' && Math.abs(n - g.actual) > 1) { p0diff++; mism.push(`${r.id} ${g.path} ${g.A}-${g.B} P0 model ${n} vs trace ${g.actual}`); } }
    const actualGet = gets.reduce((a, g) => a + g.actual, 0);
    const cov = q.sources.map(s => { const m = s.match(/^(.*):(\d+)-(\d+)$/), f = m[1], a = +m[2], b = +m[3]; let t = 0; for (let l = a; l <= b; l++) if (seen.some(x => x.f === f && x.a <= l && x.b >= l)) t++; return t / (b - a + 1); });
    res[pol] = { lines: pol === 'P0' ? r.lines : r.lines - actualGet + getLines, getLines, full: cov.every(c => c === 1), minCov: Math.min(...cov), anyLost: cov.some(c => c < 1) };
  }
  per.push({ id: r.id, ngets: gets.length, actualGet: gets.reduce((a, g) => a + g.actual, 0), res });
}
const Bm = med(reading.filter(x => x.arm === 'B').map(x => x.lines));
let md = `# M2 doc-fetch replay (offline)\n\nReplays all ${calls} lx3 \`get\` calls (${per.length} arm-E runs, ${nochunk} of them benign "no chunk at" errors kept as-is) under alternative doc fetch policies. Script: poc/tinymem-step2-fetch-replay.mjs\n\n`;
md += `| policy | definition | median lines/run | mean get-lines/run | runs gold fully covered (of ${per.length}) | runs with any gold source lost | runs worse than P0 |\n|---|---|---|---|---|---|---|\n`;
for (const pol of Object.keys(POL)) { const x = per.map(p => p.res[pol]);
  md += `| ${pol} | ${POL[pol]} | ${med(x.map(v => v.lines))} | ${(x.reduce((a, v) => a + v.getLines, 0) / x.length).toFixed(1)} | ${x.filter(v => v.full).length} | ${x.filter(v => v.anyLost).length} | ${per.filter(p => p.res[pol].full === false && p.res.P0.full).length} |\n`; }
md += `| B (grep-only, reference) | as run | ${Bm} | - | - | - | - |\n\n`;
md += `Lines per get call (mean over ${per.reduce((a, p) => a + p.ngets, 0)} calls incl. errors): ${Object.keys(POL).map(p => p + '=' + (per.reduce((a, q) => a + q.res[p].getLines, 0) / per.reduce((a, q) => a + q.ngets, 0)).toFixed(1)).join(', ')}\n\n`;
md += `Model check: P0 re-rendering vs actual trace get-output line counts, ${p0diff} calls differ by >1 line.${mism.length ? '\n\n' + mism.map(m => '- ' + m).join('\n') : ''}\n\n`;
md += `## Caveats\n- Offline replay holds the agent's calls fixed (same paths, same --lines); a live agent given less text may issue extra get/Read/Grep calls (more lines elsewhere) or behave differently, and with more text may stop sooner. Savings here are an upper bound on what the policy would save.\n- Coverage counts only Read ranges + get output (cov.mjs logic). Text seen via recall hit listings or Grep is not counted, so "lost" can overstate real loss. It is also strict: some gold sources are redundant with others.\n- Totals = reading.json lines with each run's actual lx3 get output replaced by the policy's; Read/Grep/recall left as-is. P2 "next section" is the following nodes row; P4 keeps the previous section and cuts the forward window to 20 lines.\n- sessions/ policy untouched (no session files in this corpus).\n`;
writeFileSync(join(M, 'replay.md'), md); console.log(md);
