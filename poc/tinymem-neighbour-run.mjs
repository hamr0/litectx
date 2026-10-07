// POC arm A2 = arm A (copied from tinymem-answer-harness.mjs) + neighbour sections on `get --lines`, with full tool traces.
// usage: node poc/tinymem-neighbour-run.mjs <qid,qid,...|file-of-qids> [--tag A2]   (skips existing outputs)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path'; import { homedir } from 'node:os';
const ROOT = join(homedir(), '.cache/tinymem-probe/out'), BASE = join(ROOT, 'answer'), CTRL = process.argv.includes('CTRL'), OUT = join(ROOT, CTRL ? 'neighbour-control' : 'neighbour'), LX = CTRL ? join(BASE, 'scratch/lx') : join(ROOT, 'neighbour/scratch/lx2'), SCRATCH = join(BASE, 'scratch/pilot');
const BAD = /hit your .*limit|session limit|usage limit|please run \/login|not logged in|invalid api key|credit balance|OAuth/i;
export function runA2(repo, question, { model = 'sonnet', maxTurns = 15 } = {}) {
  const lroot = join(BASE, repo, 'lroot');
  const TOOLDESC = CTRL ? `You have one tool, Bash, which may only run "${LX} recall \\"<query>\\" --kind doc -n <N>" (ranked search over the repo's docs and past Claude Code session logs; prints score, path, "→ section:startLine-endLine") and "${LX} get <path> --lines A-B" (prints that section; copy the range exactly as recall printed it; omit --lines for the whole file). Paths are relative to the corpus root. Run exactly one command per Bash call, starting with the absolute path above (no cd, no ;, &&, pipes or relative paths).` : `You have one tool, Bash, which may only run "${LX} recall \\"<query>\\" --kind doc -n <N>" (ranked search over the repo's docs and past Claude Code session logs; prints score, path, "→ section:startLine-endLine") and "${LX} get <path> --lines A-B" (prints that section, followed by the immediately previous and next sections of the same file, marked; copy the range exactly as recall printed it; omit --lines for the whole file). Paths are relative to the corpus root. Run exactly one command per Bash call, starting with the absolute path above (no cd, no ;, &&, pipes or relative paths).`;
  const sys = `You answer questions about the decisions and history of a software project ("${repo}") from its docs and past working sessions. ${TOOLDESC}\nAnswer the question, quote the supporting text verbatim, and cite each source as \`path:line-range\`. If you are not sure or cannot find it, say "not found".`;
  const args = ['-p', question, '--model', model, '--output-format', 'stream-json', '--verbose', '--system-prompt', sys, '--strict-mcp-config', '--no-session-persistence',
    '--setting-sources', '', '--disable-slash-commands', '--permission-mode', 'dontAsk',
    '--tools=Bash', '--allowedTools', `Bash(${LX} recall:*)`, `Bash(${LX} get:*)`, '--max-turns', String(maxTurns),
    '--disallowedTools', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Edit', 'Write'];
  const t = Date.now();
  const r = spawnSync('claude', args, { cwd: SCRATCH, encoding: 'utf8', env: { ...process.env, LX_ROOT: lroot }, timeout: 600000, maxBuffer: 1 << 27 });
  const events = (r.stdout || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const res = events.findLast(e => e.type === 'result') ?? { parseError: true, stderr: r.stderr?.slice(0, 1000) };
  const calls = [], byId = {};
  for (const e of events) for (const c of (e.message?.content ?? [])) {
    if (c.type === 'tool_use') { const o = { tool: c.name, input: c.input?.command ?? c.input, resultBytes: null, isError: null }; byId[c.id] = o; calls.push(o); }
    if (c.type === 'tool_result' && byId[c.tool_use_id]) { const s = typeof c.content === 'string' ? c.content : JSON.stringify(c.content); Object.assign(byId[c.tool_use_id], { resultBytes: s.length, isError: !!c.is_error, hasNeighbour: /--- (PREVIOUS|NEXT) SECTION/.test(s), preview: s.slice(0, 160) }); }
  }
  return { repo, question, ms: Date.now() - t, result: res, calls, nEvents: events.length, raw: r.stdout };
}
if (process.argv[1].endsWith('tinymem-neighbour-run.mjs')) {
  const arg = process.argv[2]; const tag = CTRL ? 'CTRL' : (process.argv[4] ?? 'A2');
  const ids = existsSync(arg) ? readFileSync(arg, 'utf8').split(/[\s,]+/).filter(Boolean) : arg.split(',');
  const Q = {}; for (const repo of ['bareagent', 'bareloop']) for (const q of JSON.parse(readFileSync(join(BASE, 'questions', repo + '.json')))) Q[q.id] = { ...q, repo };
  mkdirSync(join(OUT, 'runs'), { recursive: true }); mkdirSync(join(OUT, 'traces'), { recursive: true }); mkdirSync(SCRATCH, { recursive: true });
  for (const id of ids) {
    const f = join(OUT, 'runs', `${id}.${tag}.json`); if (existsSync(f)) continue; const q = Q[id]; if (!q) { console.error('unknown', id); continue; }
    let o; for (let a = 0; a < 2; a++) { o = runA2(q.repo, q.question); const txt = o.result.result ?? '';
      if (o.result.parseError || typeof o.result.result !== 'string' || o.result.is_error || (BAD.test(txt) && txt.length < 600)) { console.error('REFUSED (bad/limit/error result)', id, txt.slice(0, 200)); o = null; continue; } break; }
    if (!o) { console.error('giving up', id); continue; }
    writeFileSync(join(OUT, 'traces', `${id}.${tag}.jsonl`), o.raw); delete o.raw; o.qid = id;
    writeFileSync(f, JSON.stringify(o, null, 1));
    console.log(id, 'turns', o.result.num_turns, 'cost', o.result.total_cost_usd?.toFixed(4), 'calls', o.calls.length);
  }
}
