// A2 blind grader (copy of tinymem-answer-grade.mjs, same prompt/model; items come from out/neighbour/runs). build | <shard> <n>
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path'; import { homedir } from 'node:os';
const BASE = join(homedir(), '.cache/tinymem-probe/out/answer'); const NB = join(homedir(), '.cache/tinymem-probe/out', process.env.GNB ?? 'neighbour'); const G = join(NB, 'grades');
mkdirSync(join(G, 'items'), { recursive: true }); mkdirSync(join(G, 'out'), { recursive: true });
function rng(s) { return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
if (process.argv[2] === 'build') {
  let items;
  if (process.env.GNB) { // joint pool: control runs (this dir) + A2 runs of the same qids, one blind shuffle
    const A2D = join(homedir(), '.cache/tinymem-probe/out/neighbour/runs'); items = [];
    for (const f of readdirSync(join(NB, 'runs')).filter(f => f.endsWith('.CTRL.json'))) { const o = JSON.parse(readFileSync(join(NB, 'runs', f))); items.push({ repo: o.repo, qid: o.qid, arm: 'CTRL', answer: o.result.result });
      const a = JSON.parse(readFileSync(join(A2D, o.qid + '.A2.json'))); items.push({ repo: a.repo, qid: a.qid, arm: 'A2', answer: a.result.result }); }
  } else items = readdirSync(join(NB, 'runs')).filter(f => f.endsWith('.A2.json')).map(f => { const o = JSON.parse(readFileSync(join(NB, 'runs', f))); return { repo: o.repo, qid: o.qid, arm: 'A2', answer: o.result.result }; });
  const r = rng(process.env.GNB ? 987123 : 54321); for (let i = items.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [items[i], items[j]] = [items[j], items[i]]; }
  const key = {}; items.forEach((it, i) => { const id = (process.env.GNB ? 'k' : 'n') + String(i).padStart(3, '0') + Math.floor(r() * 1e6).toString(36); key[id] = { repo: it.repo, qid: it.qid, arm: it.arm };
    writeFileSync(join(G, 'items', id + '.json'), JSON.stringify({ id, repo: it.repo, qid: it.qid, answer: it.answer })); });
  writeFileSync(join(NB, 'grades.key.json'), JSON.stringify(key, null, 1)); console.log(items.length, 'items'); process.exit(0);
}
const [shard, n] = process.argv.slice(2).map(Number);
const Q = {}; for (const repo of ['bareagent', 'bareloop']) for (const q of JSON.parse(readFileSync(join(BASE, 'questions', repo + '.json')))) Q[q.id] = q;
const files = readdirSync(join(G, 'items')).sort();
files.forEach((fn, i) => { if (i % n !== shard) return; const id = fn.replace('.json', ''); const of = join(G, 'out', id + '.json'); if (existsSync(of)) return;
  const it = JSON.parse(readFileSync(join(G, 'items', fn))); const q = Q[it.qid]; const corpus = join(BASE, it.repo, 'corpus');
  const sys = `You are a strict, careful grader. You may read the corpus at ${corpus} (docs/ and sessions/ subfolders) using Read/Grep/Glob. Paths cited in answers are relative to that corpus root; line ranges are 1-based. Output ONLY a single JSON object, no prose.`;
  const prompt = `QUESTION: ${q.question}\n\nGOLD ANSWER: ${q.gold}\n\nMUST FACTS:\n${q.must.map(m => '- ' + m).join('\n')}\n\nGOLD SOURCES: ${q.sources.join('; ')}\n\nANSWER TO GRADE:\n<<<\n${it.answer}\n>>>\n\nInstructions: Open EACH citation in the answer (path:line-range under ${corpus}) and quote the lines you actually read. Then judge:\n- correct: "yes" = all must facts are present in the answer and nothing contradicts gold; "partial" = some must facts present; "no" otherwise (including "not found" or no answer).\n- cited: "yes" = at least one citation whose lines actually contain the answer (any valid location, not only gold sources); "no" otherwise (no citations, wrong lines, fabricated).\nReturn strict JSON: {"correct":"yes|partial|no","cited":"yes|no","evidence":"<quoted lines you read, or 'NO CITATIONS' if the answer has none>","reason":"<specific, item-unique reasoning>"}`;
  let out;
  for (let t = 0; t < 3; t++) {
    const r = spawnSync('claude', ['-p', prompt, '--model', 'sonnet', '--output-format', 'json', '--system-prompt', sys, '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands', '--permission-mode', 'dontAsk',
      '--tools=Read,Grep,Glob', '--allowedTools', `Read(/${corpus}/**)`, `Grep(/${corpus}/**)`, `Glob(/${corpus}/**)`, '--add-dir', corpus, '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch', 'Edit', 'Write', '--max-turns', '20'],
      { cwd: join(BASE, 'scratch/pilot'), encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 26 });
    let j; try { j = JSON.parse(r.stdout); } catch { console.error('noparse', r.stderr?.slice(0,200)); continue; }
    const m = (j.result ?? '').match(/\{[\s\S]*\}/); let p; try { p = JSON.parse(m[0]); } catch { console.error('badjson', j.is_error, (j.result||'').slice(0,300)); continue; }
    if (process.env.GDBG) console.error('P', JSON.stringify(p).slice(0,400));
    if (!['yes', 'partial', 'no'].includes(p.correct) || !['yes', 'no'].includes(p.cited)) continue;
    const hasCit = /\S+\.md:\d+/.test(it.answer);
    if (hasCit && (!p.evidence || String(p.evidence).trim().length < 10)) continue;
    out = { id, grade: p, cost: j.total_cost_usd, turns: j.num_turns, attempt: t + 1 }; break;
  }
  writeFileSync(of, JSON.stringify(out ?? { id, failed: true })); });
