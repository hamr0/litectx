// Answer test harness: run one question through arm A (litectx CLI) / B (Read,Grep,Glob on corpus) / C (no tools) via headless `claude -p`.
// usage: node poc/tinymem-answer-harness.mjs <arm A|B|C> <repo> "<question>" [model=sonnet]
// Prints the claude json result (also saved under out/answer/pilot-results/).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const BASE = join(homedir(), '.cache/tinymem-probe/out/answer'), SCRATCH = join(BASE, 'scratch/pilot'), LX = join(BASE, 'scratch/lx');
export function runArm(arm, repo, question, { model = 'sonnet', maxTurns = 15 } = {}) {
  const corpus = join(BASE, repo, 'corpus'), lroot = join(BASE, repo, 'lroot');
  const TOOLDESC = {
    A: `You have one tool, Bash, which may only run "${LX} recall \\"<query>\\" --kind doc -n <N>" (ranked search over the repo's docs and past Claude Code session logs; prints score, path, "→ section:startLine-endLine") and "${LX} get <path> --lines A-B" (prints that section; copy the range exactly as recall printed it; omit --lines for the whole file). Paths are relative to the corpus root. Run exactly one command per Bash call, starting with the absolute path above (no cd, no ;, &&, pipes or relative paths).`,
    B: `You have the tools Read, Grep and Glob over the corpus directory ${corpus} (subfolders docs/ = the repo's markdown docs, sessions/ = past Claude Code session logs as markdown).`,
    C: `You have no tools. Answer from your own knowledge only.`,
  }[arm];
  const sys = `You answer questions about the decisions and history of a software project ("${repo}") from its docs and past working sessions. ${TOOLDESC}\nAnswer the question, quote the supporting text verbatim, and cite each source as \`path:line-range\`. If you are not sure or cannot find it, say "not found".`;
  const args = ['-p', question, '--model', model, '--output-format', 'json', '--system-prompt', sys, '--strict-mcp-config', '--no-session-persistence',
    '--setting-sources', '', '--disable-slash-commands', '--permission-mode', 'dontAsk'];
  if (arm === 'A') args.push('--tools=Bash', '--allowedTools', `Bash(${LX} recall:*)`, `Bash(${LX} get:*)`, '--max-turns', String(maxTurns));
  if (arm === 'A') args.push('--disallowedTools', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Edit', 'Write');
  if (arm === 'B') args.push('--disallowedTools', 'Bash', 'WebFetch', 'WebSearch', 'Edit', 'Write');
  if (arm === 'B') args.push('--tools=Read,Grep,Glob', '--allowedTools', `Read(/${corpus}/**)`, `Grep(/${corpus}/**)`, `Glob(/${corpus}/**)`, '--add-dir', corpus, '--max-turns', String(maxTurns));
  if (arm === 'C') args.push('--tools=', '--disallowedTools', 'Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep', 'Agent', 'Workflow', 'ToolSearch', 'WebFetch', 'WebSearch', 'NotebookEdit');
  const t = Date.now();
  const r = spawnSync('claude', args, { cwd: SCRATCH, encoding: 'utf8', env: { ...process.env, LX_ROOT: lroot }, timeout: 600000, maxBuffer: 1 << 26 });
  let j; try { j = JSON.parse(r.stdout); } catch { j = { parseError: true, stdout: r.stdout?.slice(0, 2000), stderr: r.stderr?.slice(0, 2000) }; }
  return { arm, repo, question, ms: Date.now() - t, args: ['claude', ...args], result: j };
}
if (process.argv[1].endsWith('tinymem-answer-harness.mjs')) {
  const [arm, repo, q, model] = process.argv.slice(2); if (!/^[ABC]$/.test(arm ?? '') || !q) { console.error('usage: <A|B|C> <repo> "<question>" [model]'); process.exit(2); }
  mkdirSync(SCRATCH, { recursive: true }); mkdirSync(join(BASE, 'pilot-results'), { recursive: true });
  const o = runArm(arm, repo, q, { model });
  writeFileSync(join(BASE, 'pilot-results', `${repo}-${arm}-${Date.now()}.json`), JSON.stringify(o, null, 1));
  const r = o.result; console.log(JSON.stringify({ arm, repo, ms: o.ms, is_error: r.is_error, num_turns: r.num_turns, cost: r.total_cost_usd, usage: r.usage, denials: r.permission_denials, result: (r.result ?? JSON.stringify(r)).slice(0, 1500) }, null, 1));
}
