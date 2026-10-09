// Stage 3 runner shard: node poc/tinymem-answer-run.mjs <shard> <nshards>
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path'; import { homedir } from 'node:os';
import { runArm } from './tinymem-answer-harness.mjs';
const BASE = join(homedir(), '.cache/tinymem-probe/out/answer');
const [shard, n] = process.argv.slice(2).map(Number);
const jobs = [];
for (const repo of ['bareagent', 'bareloop']) { mkdirSync(join(BASE, 'runs', repo), { recursive: true });
  for (const q of JSON.parse(readFileSync(join(BASE, 'questions', repo + '.json')))) for (const arm of ['A', 'B', 'C']) jobs.push({ repo, q, arm }); }
mkdirSync(join(BASE, 'scratch/pilot'), { recursive: true });
jobs.forEach((jb, i) => { if (i % n !== shard) return;
  const f = join(BASE, 'runs', jb.repo, `${jb.q.id}.${jb.arm}.json`); if (existsSync(f)) return;
  let o; for (let t = 0; t < 2; t++) { o = runArm(jb.arm, jb.repo, jb.q.question); const r = o.result;
    if (/hit your .*limit/i.test(r.result||'')) { console.error('LIMIT HIT'); process.exit(3); }
    if (!r.parseError && typeof r.result === 'string' && !(r.is_error && /api|overload|rate|network|ECONN/i.test(r.result))) break; o.retried = t + 1; }
  o.qid = jb.q.id; writeFileSync(f, JSON.stringify(o, null, 1)); });
