// Step 5: tool-choice metric per run, from stream-json traces. Reuses the step-2 "lines read" logic (tinymem-step2-reading.mjs).
// usage: node poc/tinymem-step5-toolchoice.mjs <dir with runs/ + traces/> [picked.json]   -> prints per-run + per-(arm,type) table, writes <dir>/toolchoice.json
// per run: firstTool (recall|get|Grep|Glob|Read), nRecall, nGrep (Grep+Glob), nRead, handoff (a Grep/Glob whose path is a FILE the agent got from recall/get),
//          readRecalled (a Read of such a file), tokens, lines (corpus text received via Read/Grep/Glob/Bash results).
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'; import { join } from 'node:path'; import { homedir } from 'node:os';
const D = process.argv[2], PK = process.argv[3] ?? join(D, 'picked.json'), rows = [];
const types = existsSync(PK) ? Object.fromEntries(JSON.parse(readFileSync(PK)).picked.map(p => [p.id, p.type])) : {};
const med = (a) => { a = [...a].sort((x, y) => x - y); const m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : NaN; };
const PATH_RE = /(?:docs|sessions)\/[^\s"'`:\t]+?\.md/g;
const kind = (c) => c.name !== 'Bash' ? c.name : /\blx\d?\s+recall\b/.test(c.input?.command ?? '') ? 'recall' : /\blx\d?\s+get\b/.test(c.input?.command ?? '') ? 'get' : 'Bash-other';
for (const f of readdirSync(join(D, 'runs')).filter(f => f.endsWith('.json'))) {
  const run = JSON.parse(readFileSync(join(D, 'runs', f))), tf = join(D, 'traces', run.id + '.jsonl'); if (!existsSync(tf)) continue;
  const ev = readFileSync(tf, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byId = {}, order = [], got = new Set(), per = { Read: 0, Grep: 0, Glob: 0, Bash: 0 }; let handoff = 0, readRecalled = 0;
  for (const e of ev) for (const c of (e.message?.content ?? [])) {
    if (c.type === 'tool_use') { const k = kind(c); byId[c.id] = { name: c.name, k }; order.push(k);
      const inp = c.input ?? {}, target = inp.path ?? inp.file_path ?? '';
      if (k === 'get') { const m = /\bget\s+(\S+)/.exec(inp.command ?? ''); if (m) got.add(m[1]); }
      if ((k === 'Grep' || k === 'Glob') && [...got].some(p => target.endsWith(p))) handoff++;
      if (k === 'Read' && [...got].some(p => target.endsWith(p))) readRecalled++; }
    if (c.type === 'tool_result' && byId[c.tool_use_id]) { let s = c.content; if (Array.isArray(s)) s = s.map(x => x.text ?? '').join('\n'); s = String(s ?? ''); const b = byId[c.tool_use_id];
      if (b.name in per) per[b.name] += s ? s.split('\n').length : 0; if (b.k === 'recall') for (const p of s.match(PATH_RE) ?? []) got.add(p); }
  }
  const type = types[run.qid] ?? '?', n = (k) => order.filter(x => x === k).length;
  rows.push({ id: run.id, arm: run.arm, qid: run.qid, type, firstTool: order[0] ?? 'none', nRecall: n('recall'), nGet: n('get'), nGrep: n('Grep') + n('Glob'), nRead: n('Read'), handoff, readRecalled, tok: run.tokens, cost: run.cost, lines: Object.values(per).reduce((a, b) => a + b, 0) });
}
rows.sort((a, b) => a.id.localeCompare(b.id));
console.log('id\tfirst\trecall\tget\tgrep\tread\thandoff\treadRecalled\ttok\tlines'); for (const r of rows) console.log([r.id, r.firstTool, r.nRecall, r.nGet, r.nGrep, r.nRead, r.handoff, r.readRecalled, r.tok, r.lines].join('\t'));
console.log('\narm\ttype\truns\tfirst=recall\tmean recall\tmean grep\thandoff>0\ttok med\tlines med');
const keys = [...new Set(rows.map(r => r.arm + '\t' + r.type))].sort();
for (const k of keys) { const [a, t] = k.split('\t'), r = rows.filter(x => x.arm === a && x.type === t), avg = (f) => (r.reduce((s, x) => s + f(x), 0) / r.length).toFixed(2);
  console.log([a, t, r.length, r.filter(x => x.firstTool === 'recall').length + '/' + r.length, avg(x => x.nRecall), avg(x => x.nGrep), r.filter(x => x.handoff > 0).length + '/' + r.length, med(r.map(x => x.tok)), med(r.map(x => x.lines))].join('\t')); }
writeFileSync(join(D, 'toolchoice.json'), JSON.stringify(rows, null, 1));
