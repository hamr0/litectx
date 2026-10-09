// Offline replay: failed `get` calls in step8 arm F traces + simulate S1/S2/S3 fixes. No API calls.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const Database = createRequire(new URL('../package.json', import.meta.url))('better-sqlite3');
const O = process.env.HOME + '/.cache/tinymem-probe/out';
const TR = O + '/step8/traces', OUT = O + '/step8/getreplay';
mkdirSync(OUT, { recursive: true });
const lroot = (repo, size) => size === 'x1' ? `${O}/step2/root/${repo}/lroot` : `${O}/step4/${repo}-big/lroot`;
const dbs = {};
const dbOf = (repo, size) => dbs[repo + size] ??= new Database(join(lroot(repo, size), '.litectx/index.db'), { readonly: true });
const qs = {};
for (const r of ['bareagent', 'bareloop']) for (const q of JSON.parse(readFileSync(`${O}/fresh/questions/${r}.json`, 'utf8'))) qs[q.id] = q;
const parseSrc = s => { const m = /^(.*):(\d+)(?:-(\d+))?$/.exec(s); return m ? { path: m[1], a: +m[2], b: +(m[3] ?? m[2]) } : null; };
const sectionsOf = (db, path) => db.prepare("SELECT start_line s,end_line e,symbol,body FROM nodes WHERE path=? AND kind='doc' ORDER BY start_line").all(path).map(r => ({ a: r.s + 1, b: r.e + 1, sym: r.symbol, bytes: Buffer.byteLength(r.body) }));
const ov = (a, b, c, d) => Math.max(a, c) <= Math.min(b, d);
const fails = [], perTrace = [];
for (const f of readdirSync(TR).filter(f => /\.F\./.test(f)).sort()) {
  const [id, , size] = f.split('.'); const repo = id.split('-')[0];
  const ev = readFileSync(join(TR, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const calls = []; const byId = {}; let turn = 0; let result = null;
  for (const d of ev) {
    if (d.type === 'assistant') { turn++; for (const c of d.message.content) if (c.type === 'tool_use') { const o = { id: c.id, turn, cmd: c.input.command ?? JSON.stringify(c.input), tool: c.name }; calls.push(o); byId[c.id] = o; } }
    else if (d.type === 'user') { for (const c of d.message.content) if (c.type === 'tool_result' && byId[c.tool_use_id]) { const o = byId[c.tool_use_id]; o.res = typeof c.content === 'string' ? c.content : c.content.map(x => x.text ?? '').join(''); o.err = !!c.is_error; } }
    else if (d.type === 'result') result = d;
  }
  const seen = {}; // path -> Set of printed "A-B"
  const rec = { f, id, size, repo, turns: result?.num_turns, cost: result?.total_cost_usd, outTok: result?.usage?.output_tokens, nfail: 0 };
  calls.forEach((c, i) => {
    const m = /lx5 recall/.test(c.cmd);
    if (m && c.res) for (const l of c.res.split('\n')) { const t = l.split('\t'); const mm = /:(\d+)-(\d+)$/.exec(t[3] ?? ''); if (mm && t[2]) (seen[t[2]] ??= new Set()).add(`${mm[1]}-${mm[2]}`); }
    const g = /lx5 get (\S+)(?: --lines (\d+)-(\d+))?/.exec(c.cmd);
    if (g && c.err !== undefined && /litectx: /.test(c.res ?? '') && c.err) {
      rec.nfail++;
      const after = calls.slice(i + 1); // later calls (same-turn parallel ones included)
      
      const readBytes = after.reduce((s, x) => s + Buffer.byteLength(x.res ?? ''), 0);
      let act = 'gave up/answered';
      const sameFile = after.find(x => /lx5 get/.test(x.cmd) && x.cmd.includes(g[1]) && x.cmd !== c.cmd);
      if (sameFile) { const r2 = /--lines (\d+-\d+)/.exec(sameFile.cmd); act = r2 && seen[g[1]]?.has(r2[1]) ? 'retry w/ printed range' : 'retry other get'; if (sameFile.err) act += ' (failed again)'; }
      else if (after.some(x => x.tool === 'Read' || /\b(cat|sed|head|tail|grep|rg)\b/.test(x.cmd))) act = 'fell back to Read/shell';
      else if (after.some(x => /lx5 (get|recall)/.test(x.cmd))) act = 'other lx call(s)';
      fails.push({ f, id, size, repo, path: g[1], req: g[2] ? `${g[2]}-${g[3]}` : null, err: (c.res ?? '').split('\n').slice(-1)[0].slice(0, 160), printedForPath: [...(seen[g[1]] ?? [])], act, laterCalls: after.length, later: after.filter(x => x !== c).map(x => x.cmd.replace(/.*lx5 /, 'lx ').slice(0, 90)), readBytes, turns: rec.turns, cost: rec.cost });
    }
  });
  perTrace.push(rec);
}
// simulation
for (const x of fails) {
  const db = dbOf(x.repo, x.size); const secs = sectionsOf(db, x.path);
  const gold = [...(qs[x.id].sources ?? [])].map(parseSrc).filter(Boolean);
  const goldAlso = [...(qs[x.id].also ?? [])].map(parseSrc).filter(Boolean);
  let drift = 'n/a';
  try { const h = db.prepare('SELECT content_hash h FROM file_index WHERE path=?').get(x.path)?.h; const disk = readFileSync(join(lroot(x.repo, x.size), x.path), 'utf8'); drift = h === createHash('sha256').update(disk).digest('hex') ? 'current' : 'DRIFTED'; } catch { drift = 'missing'; }
  x.drift = drift; x.nsec = secs.length;
  if (!x.req || !secs.length) { x.sim = null; continue; }
  const [a, b] = x.req.split('-').map(Number);
  const gOv = (list) => g2 => list.filter(g => g.path === x.path && ov(g.a, g.b, g2.a, g2.b)).length > 0;
  const goldHit = (served) => served.some(s => gold.some(g => g.path === x.path && ov(g.a, g.b, s.a, s.b)));
  const goldCover = (served) => gold.filter(g => g.path === x.path).length ? gold.filter(g => g.path === x.path).every(g => served.some(s => ov(g.a, g.b, s.a, s.b))) : null;
  const ovl = secs.filter(s => ov(s.a, s.b, a, b));
  const cont = secs.filter(s => s.a <= a && s.b >= b);
  const near = secs.map(s => ({ s, d: ov(s.a, s.b, a, b) ? 0 : Math.min(Math.abs(s.a - b), Math.abs(a - s.b)) })).sort((p, q) => p.d - q.d).slice(0, 4).map(o => o.s);
  const sum = l => l.reduce((t, s) => t + s.bytes, 0);
  x.gold = gold.filter(g => g.path === x.path).map(g => `${g.a}-${g.b}`);
  x.goldOtherFiles = [...new Set(gold.filter(g => g.path !== x.path).map(g => g.path))];
  x.sim = {
    S1: { served: cont.length === 1, secs: cont.map(s => `${s.a}-${s.b}`), bytes: cont.length === 1 ? sum(cont) : 0, gold: cont.length === 1 ? goldHit(cont) : false, coverAll: cont.length === 1 ? goldCover(cont) : null },
    S2: { served: ovl.length > 0, n: ovl.length, secs: ovl.map(s => `${s.a}-${s.b}`), bytes: sum(ovl), gold: goldHit(ovl), coverAll: goldCover(ovl) },
    S3: { hint: near.map(s => `${s.a}-${s.b}`), overlapsReq: ovl.length, goldInHint: goldHit(near), goldInOvl: goldHit(ovl) },
    reqSpan: b - a + 1, reqInGoldFile: gold.some(g => g.path === x.path)
  };
}
writeFileSync(OUT + '/results.json', JSON.stringify({ perTrace, fails }, null, 1));
// report
const L = []; const P = s => L.push(s);
const nF = perTrace.length, withFail = perTrace.filter(t => t.nfail);
const allGets = 0;
P(`F traces: ${nF}; traces with >=1 failed get: ${withFail.length}; failed get calls: ${fails.length}`);
for (const sz of ['x1', 'big']) P(`  ${sz}: traces ${perTrace.filter(t => t.size === sz).length}, failed calls ${fails.filter(x => x.size === sz).length}`);
const avg = (a, k) => a.length ? (a.reduce((s, t) => s + (t[k] ?? 0), 0) / a.length) : 0;
const clean = perTrace.filter(t => !t.nfail);
P(`avg turns: fail-traces ${avg(withFail, 'turns').toFixed(2)} vs clean ${avg(clean, 'turns').toFixed(2)}; avg cost $: ${avg(withFail, 'cost').toFixed(4)} vs ${avg(clean, 'cost').toFixed(4)}; avg outTok ${avg(withFail, 'outTok').toFixed(0)} vs ${avg(clean, 'outTok').toFixed(0)}`);
P('\nPER FAILED CALL');
fails.forEach((x, i) => { P(`#${i + 1} ${x.f} ${x.path} req=${x.req} drift=${x.drift} nsec=${x.nsec}\n   printed for file: ${x.printedForPath.join(' ') || '(none)'}\n   next: ${x.act}; later calls ${x.laterCalls}; bytes read after ${x.readBytes}; trace turns ${x.turns} cost $${x.cost?.toFixed(4)}\n   later: ${x.later.join(' || ')}\n   gold in file: ${x.gold?.join(' ')} ${x.goldOtherFiles?.length ? '(gold also in ' + x.goldOtherFiles.join(',') + ')' : ''}`);
  if (x.sim) P(`   S1: ${x.sim.S1.served ? `serve ${x.sim.S1.secs} ${x.sim.S1.bytes}B goldhit=${x.sim.S1.gold}` : 'not served (0 or >1 containing)'} | S2: n=${x.sim.S2.n} [${x.sim.S2.secs}] ${x.sim.S2.bytes}B goldhit=${x.sim.S2.gold} coverAll=${x.sim.S2.coverAll} | S3 hint=[${x.sim.S3.hint}] overlapsReq=${x.sim.S3.overlapsReq} goldInHint=${x.sim.S3.goldInHint}`); });
P('\nSUMMARY');
const by = (k) => fails.reduce((m, x) => (m[x[k]] = (m[x[k]] || 0) + 1, m), {});
P('next action: ' + JSON.stringify(by('act')));
P('drift: ' + JSON.stringify(by('drift')));
const cls = x => x.sim ? (x.sim.S2.n === 1 ? 'req==1 section' : (x.printedForPath.join(' ') && x.sim.S2.secs.every(r => x.printedForPath.includes(r)) ? 'merge of printed sections' : 'range includes unprinted sections')) : 'no req';
P('cause: ' + JSON.stringify(fails.reduce((m, x) => (m[cls(x)] = (m[cls(x)] || 0) + 1, m), {})));
const goldHere = fails.filter(x => x.gold?.length);
P(`failed calls whose file holds gold: ${goldHere.length}/${fails.length}`);
for (const k of ['S1', 'S2']) P(`${k}: served ${fails.filter(x => x.sim?.[k].served).length}; gold-overlap (of gold-file calls) ${goldHere.filter(x => x.sim[k].gold).length}/${goldHere.length}; full gold cover ${goldHere.filter(x => x.sim[k].coverAll).length}; bytes avg ${(fails.filter(x => x.sim?.[k].served).reduce((t, x) => t + x.sim[k].bytes, 0) / Math.max(1, fails.filter(x => x.sim?.[k].served).length)).toFixed(0)}; served>3 sections ${fails.filter(x => x.sim?.[k].n > 3).length}`);
P(`S3: hint overlaps gold ${goldHere.filter(x => x.sim.S3.goldInHint).length}/${goldHere.length}; hint always exact chunk ranges (4 listed)`);
writeFileSync(OUT + '/report.txt', L.join('\n'));
console.log(L.join('\n'));
