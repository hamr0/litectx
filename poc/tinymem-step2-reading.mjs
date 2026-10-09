// M2: per-run "reading" = lines/bytes of corpus text the agent received (Read, Grep, Glob, Bash lx recall/get results), from stream-json traces.
// usage: node poc/tinymem-step2-reading.mjs <m2 dir>   -> prints table + writes reading.json
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
const D = process.argv[2], rows = [];
const med = (a) => { a = [...a].sort((x, y) => x - y); const m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : NaN; };
for (const f of readdirSync(join(D, 'runs')).filter(f => f.endsWith('.json'))) {
  const run = JSON.parse(readFileSync(join(D, 'runs', f))), ev = readFileSync(join(D, 'traces', run.id + '.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const names = {}, per = { Read: 0, Grep: 0, Glob: 0, Bash: 0 }, by = { Read: 0, Grep: 0, Glob: 0, Bash: 0 }; let sess = 0;
  for (const e of ev) for (const c of (e.message?.content ?? [])) {
    if (c.type === 'tool_use') names[c.id] = c.name;
    if (c.type === 'tool_result' && names[c.tool_use_id]) { let s = c.content; if (Array.isArray(s)) s = s.map(x => x.text ?? '').join('\n'); s = String(s ?? ''); const n = names[c.tool_use_id]; if (!(n in per)) continue;
      per[n] += s ? s.split('\n').length : 0; by[n] += s.length; if (/sessions\//.test(s)) sess++; } }
  rows.push({ id: run.id, arm: run.arm, tok: run.tokens, cost: run.cost, lines: Object.values(per).reduce((a, b) => a + b, 0), bytes: Object.values(by).reduce((a, b) => a + b, 0), per, sessionsMentions: sess });
}
for (const arm of ['E', 'B']) { const r = rows.filter(x => x.arm === arm); console.log(arm, 'runs', r.length, 'median lines', med(r.map(x => x.lines)), 'median bytes', med(r.map(x => x.bytes)), 'median tokens', med(r.map(x => x.tok)), 'sessions/ mentions in results', r.reduce((a, x) => a + x.sessionsMentions, 0)); }
writeFileSync(join(D, 'reading.json'), JSON.stringify(rows, null, 1));
