// Step-1 hybrid answer test harness (PREREG: poc/tinymem-step1-PREREG.md). Arms A2 / D / B (k repeats) and C (k=1).
// Reuses the stream-json trace + guard approach of tinymem-neighbour-run.mjs, the grader prompt of tinymem-answer-grade.mjs,
// and the lx2 wrapper (out/neighbour/scratch/lx2) and corpus/lroot of go/no-go 1 (out/answer/<repo>/{corpus,lroot}).
//
// env: STEP1_DIR  output dir (default ~/.cache/tinymem-probe/out/step1)    STEP1_QDIR questions dir (default $STEP1_DIR/questions)
//      STEP1_CORPUS_ROOT corpus+lroot parent (default out/answer; out/step1-scale/root5x for ~5x)   STEP1_SIZE x1|x5 (default x1; run id = qid.arm.size.rN)   STEP1_K repeats for D/B (default 3)   STEP1_QIDS comma list to restrict questions (pilot)   STEP1_ARMS e.g. D,B,C (C skipped unless x1)
//      STEP1_POOL_DIRS dir1,dir2 : grade-build/grade/score take runs from these dirs (one joint blind pool, one key); the grader's corpus per item = that run's recorded corpusRoot
// usage: node poc/tinymem-step1.mjs run <shard> <nshards>       resumable; exits 3 on limit/login hit
//        node poc/tinymem-step1.mjs grade-build <round>         round 1 = all runs; round 2/3 = triggered by the PREREG rules
//        node poc/tinymem-step1.mjs grade <round> <shard> <n>   resumable
//        node poc/tinymem-step1.mjs score                       writes score.md / rows.json, prints outcome
//        node poc/tinymem-step1.mjs audit [seed]                20 seeded items for the orchestrator's full re-read
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path'; import { homedir } from 'node:os';

const ROOT = join(homedir(), '.cache/tinymem-probe/out'), BASE = join(ROOT, 'answer');
const OUT = process.env.STEP1_DIR ?? join(ROOT, 'step1'), QDIR = process.env.STEP1_QDIR ?? join(OUT, 'questions');
const CROOT = process.env.STEP1_CORPUS_ROOT ?? BASE; // holds <repo>/corpus and <repo>/lroot (built litectx index); point at a padded copy for the 10x runs
const K = +(process.env.STEP1_K ?? 3), REPOS = ['bareloop', 'bareagent'];
const LX3 = join(ROOT, 'step1-dprime/scratch/lx3'), LX2 = join(ROOT, 'neighbour/scratch/lx2'), SCRATCH = join(BASE, 'scratch/pilot');
const ARMS = (process.env.STEP1_ARMS ?? 'D,B,C').split(',');
const SIZE = process.env.STEP1_SIZE ?? 'x1', SIZES = ['x1', 'x5']; // size tag recorded in every run; C is only ever run at x1
const POOL = process.env.STEP1_POOL_DIRS?.split(',').filter(Boolean); // grade-build/score: runs from several STEP1_DIRs into one joint pool (STEP1_DIR then holds grades/score)
const BAD = /hit your .*limit|session limit|usage limit|please run \/login|not logged in|invalid api key|credit balance|OAuth/i;
for (const d of ['runs', 'traces', 'grades']) mkdirSync(join(OUT, d), { recursive: true });
mkdirSync(SCRATCH, { recursive: true });
const rng = (s) => () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
const shuffle = (a, seed) => { const r = rng(seed); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const loadQ = () => { const Q = {}; const only = process.env.STEP1_QIDS?.split(',');
  for (const repo of REPOS) { const f = join(QDIR, repo + '.json'); if (!existsSync(f)) continue; for (const q of JSON.parse(readFileSync(f))) if (!only || only.includes(q.id)) Q[q.id] = { ...q, repo }; } return Q; };

// ---------- runs ----------
const A2_SENTF = (LX2) => `You have one tool, Bash, which may only run "${LX2} recall \\"<query>\\" --kind doc -n <N>" (ranked search over the repo's docs and past Claude Code session logs; prints score, path, "→ section:startLine-endLine") and "${LX2} get <path> --lines A-B" (prints that section, followed by the immediately previous and next sections of the same file, marked; copy the range exactly as recall printed it; omit --lines for the whole file). Paths are relative to the corpus root. Run exactly one command per Bash call, starting with the absolute path above (no cd, no ;, &&, pipes or relative paths).`;
const A2_SENT = A2_SENTF(LX2), E_SENT = A2_SENTF(LX3); // arm E (D'): sentence byte-identical to D except the wrapper path; only the tool OUTPUT differs (wider get, FILE span lines)
export function runArm(arm, repo, question, { model = 'sonnet', maxTurns = 15 } = {}) {
  const corpus = join(CROOT, repo, 'corpus'), lroot = join(CROOT, repo, 'lroot');
  const B_SENT = `You have the tools Read, Grep and Glob over the corpus directory ${corpus} (subfolders docs/ = the repo's markdown docs, sessions/ = past Claude Code session logs as markdown).`;
  const D_SENT = `You also have Read, Grep and Glob over ${corpus} (docs/ and sessions/). Use search to find where to look; use grep and read when you need more of a file.`; // FROZEN (PREREG)
  const tool = { A2: A2_SENT, D: A2_SENT + ' ' + D_SENT, E: E_SENT + ' ' + D_SENT, B: B_SENT, C: 'You have no tools. Answer from your own knowledge only.' }[arm];
  const sys = `You answer questions about the decisions and history of a software project ("${repo}") from its docs and past working sessions. ${tool}\nAnswer the question, quote the supporting text verbatim, and cite each source as \`path:line-range\`. If you are not sure or cannot find it, say "not found".`;
  const args = ['-p', question, '--model', model, '--output-format', 'stream-json', '--verbose', '--system-prompt', sys, '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--max-turns', String(maxTurns)];
  const rd = [`Read(/${corpus}/**)`, `Grep(/${corpus}/**)`, `Glob(/${corpus}/**)`], bash = [`Bash(${LX2} recall:*)`, `Bash(${LX2} get:*)`], bashE = [`Bash(${LX3} recall:*)`, `Bash(${LX3} get:*)`], X = ['WebFetch', 'WebSearch', 'Edit', 'Write'];
  if (arm === 'A2') args.push('--tools=Bash', '--allowedTools', ...bash, '--disallowedTools', 'Read', 'Grep', 'Glob', ...X);
  if (arm === 'D') args.push('--tools=Bash,Read,Grep,Glob', '--allowedTools', ...bash, ...rd, '--add-dir', corpus, '--disallowedTools', ...X);
  if (arm === 'E') args.push('--tools=Bash,Read,Grep,Glob', '--allowedTools', ...bashE, ...rd, '--add-dir', corpus, '--disallowedTools', ...X);
  if (arm === 'B') args.push('--tools=Read,Grep,Glob', '--allowedTools', ...rd, '--add-dir', corpus, '--disallowedTools', 'Bash', ...X);
  if (arm === 'C') args.push('--tools=', '--disallowedTools', 'Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep', 'Agent', 'Workflow', 'ToolSearch', ...X, 'NotebookEdit');
  const t = Date.now();
  const r = spawnSync('claude', args, { cwd: SCRATCH, encoding: 'utf8', env: { ...process.env, LX_ROOT: lroot }, timeout: 600000, maxBuffer: 1 << 28 });
  const events = (r.stdout || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const res = events.findLast(e => e.type === 'result') ?? { parseError: true, stderr: r.stderr?.slice(0, 1000) };
  const calls = [], byId = {};
  for (const e of events) for (const c of (e.message?.content ?? [])) {
    if (c.type === 'tool_use') { const o = { tool: c.name, input: c.name === 'Bash' ? c.input?.command : c.input, resultBytes: null, isError: null }; byId[c.id] = o; calls.push(o); }
    if (c.type === 'tool_result' && byId[c.tool_use_id]) { const s = typeof c.content === 'string' ? c.content : JSON.stringify(c.content); Object.assign(byId[c.tool_use_id], { resultBytes: s.length, isError: !!c.is_error, hasNeighbour: /--- (PREVIOUS|NEXT) SECTION/.test(s), preview: s.slice(0, 160) }); }
  }
  return { arm, repo, question, ms: Date.now() - t, result: res, calls, nEvents: events.length, raw: r.stdout };
}
// a result may be saved only if it is a real answer
export const badResult = (res) => res.parseError || typeof res.result !== 'string' || res.is_error || (BAD.test(res.result) && res.result.length < 600);
export const limitHit = (res) => BAD.test(res.result ?? '') && (res.result ?? '').length < 600 || BAD.test(res.stderr ?? '');
export const tokens = (r) => { const u = r.usage || {}; return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0); };
const runId = (qid, arm, rep) => `${qid}.${arm}.${SIZE}.r${rep}`;
function jobs() { const Q = loadQ(), js = [];
  for (const q of Object.values(Q)) for (const arm of ARMS) if (arm !== 'C' || SIZE === 'x1') for (let rep = 1; rep <= (arm === 'C' ? 1 : K); rep++) js.push({ q, arm, rep, id: runId(q.id, arm, rep) });
  return shuffle(js, 20261007); } // one interleaved, shuffled batch (arms and repeats mixed)
function cmdRun(shard, n) {
  jobs().forEach((jb, i) => { if (i % n !== shard) return; const f = join(OUT, 'runs', jb.id + '.json'); if (existsSync(f)) return;
    let o = null;
    for (let a = 0; a < 3 && !o; a++) { const x = runArm(jb.arm, jb.q.repo, jb.q.question);
      if (limitHit(x.result)) { console.error('LIMIT/LOGIN HIT - exiting shard, nothing saved', jb.id, (x.result.result ?? x.result.stderr ?? '').slice(0, 200)); process.exit(3); }
      if (badResult(x.result)) { console.error('REFUSED (bad/error result), attempt', a + 1, jb.id, (x.result.result ?? x.result.stderr ?? '').slice(0, 200)); continue; } o = x; }
    if (!o) { console.error('giving up (unsaved, rerun later)', jb.id); return; }
    writeFileSync(join(OUT, 'traces', jb.id + '.jsonl'), o.raw); delete o.raw; Object.assign(o, { corpusRoot: CROOT, size: SIZE, id: jb.id, qid: jb.q.id, rep: jb.rep });
    o.tokens = tokens(o.result); o.cost = o.result.total_cost_usd; writeFileSync(f, JSON.stringify(o, null, 1));
    console.log(jb.id, 'turns', o.result.num_turns, 'cost', o.cost?.toFixed(4), 'tok', o.tokens, 'calls', o.calls.length); });
}

// ---------- grading ----------
const G = join(OUT, 'grades');
// legacy runs (pre-size-tag, id qid.arm.rN) count as x1; ids must be unique across pool dirs
const loadRuns = () => { const seen = new Set(), all = [];
  for (const d of POOL ?? [OUT]) for (const f of readdirSync(join(d, 'runs')).filter(f => f.endsWith('.json'))) { const o = JSON.parse(readFileSync(join(d, 'runs', f))); o.size ??= 'x1';
    if (seen.has(o.id)) throw new Error('duplicate run id across pool dirs: ' + o.id); seen.add(o.id); all.push(o); }
  return all; };
const gradeOf = (round, id) => { const f = join(G, `r${round}`, 'out', id + '.json'); return existsSync(f) ? JSON.parse(readFileSync(f)) : null; };
const keyOf = (round) => { const f = join(G, `r${round}.key.json`); return existsSync(f) ? JSON.parse(readFileSync(f)) : {}; };
const winOf = (g) => g && g.grade && g.grade.correct === 'yes' && g.grade.cited === 'yes';
// per run id: grades by round
function gradesByRun() { const m = {}; for (const round of [1, 2, 3]) for (const [id, k] of Object.entries(keyOf(round))) { const g = gradeOf(round, id); if (g && !g.failed) (m[k.runId] ??= {})[round] = g; } return m; }
const MISSING = /missing|unreadable|not readable|cannot (be )?read|could not read|couldn.t read|does not exist|doesn.t exist|no such|out of range|beyond|past the end|empty|not found at|nonexistent|fabricat/i;
function cmdBuild(round) {
  const runs = loadRuns(), Q = loadQ(); let items;
  if (round === 1) items = runs.map(o => ({ runId: o.id, repo: o.repo, qid: o.qid, arm: o.arm, size: o.size, corpusRoot: o.corpusRoot ?? CROOT, answer: o.result.result }));
  else {
    const gb = gradesByRun(); items = [];
    // rule 4 needs the odd-one-out view per (question, arm): first-grade win/not-win of the other repeats
    const first = {}; for (const o of runs) if (gb[o.id]?.[1]) first[o.id] = winOf(gb[o.id][1]);
    for (const o of runs) { const g1 = gb[o.id]?.[1]; if (!g1) continue; const p = g1.grade;
      if (round === 2) {
        const hasCit = /\S+:\d+/.test(o.result.result);
        const sibs = runs.filter(x => x.qid === o.qid && x.arm === o.arm && x.id !== o.id && first[x.id] !== undefined);
        const odd = sibs.length >= 2 && sibs.every(x => first[x.id] === first[sibs[0].id]) && first[sibs[0].id] !== first[o.id];
        const t = p.correct === 'partial' || (p.correct === 'yes' && p.cited === 'no') || (p.correct === 'no' && hasCit) || (odd && MISSING.test(p.reason ?? ''));
        if (t) items.push({ runId: o.id, repo: o.repo, qid: o.qid, arm: o.arm, size: o.size, corpusRoot: o.corpusRoot ?? CROOT, answer: o.result.result });
      } else { const g2 = gb[o.id]?.[2]; if (g2 && winOf(g1) !== winOf(g2)) items.push({ runId: o.id, repo: o.repo, qid: o.qid, arm: o.arm, size: o.size, corpusRoot: o.corpusRoot ?? CROOT, answer: o.result.result }); } }
  }
  const done = new Set(Object.values(keyOf(round)).map(k => k.runId)); items = items.filter(it => !done.has(it.runId));
  if (Object.keys(keyOf(round)).length && items.length) { console.error('round', round, 'already built; refusing to rebuild (would change the blind pool)'); process.exit(2); }
  shuffle(items, 5150 + round); const r = rng(777 + round), key = keyOf(round); mkdirSync(join(G, `r${round}`, 'items'), { recursive: true }); mkdirSync(join(G, `r${round}`, 'out'), { recursive: true });
  items.forEach((it, i) => { const id = `g${round}${String(i).padStart(3, '0')}${Math.floor(r() * 1e6).toString(36)}`; key[id] = { runId: it.runId, repo: it.repo, qid: it.qid, arm: it.arm, size: it.size, corpusRoot: it.corpusRoot };
    writeFileSync(join(G, `r${round}`, 'items', id + '.json'), JSON.stringify({ id, repo: it.repo, qid: it.qid, answer: it.answer || '(no answer: run error)' })); }); // grader sees opaque id, repo, qid, answer only
  writeFileSync(join(G, `r${round}.key.json`), JSON.stringify(key, null, 1)); console.log('round', round, items.length, 'items; arms mixed:', JSON.stringify(items.reduce((a, x) => (a[x.arm] = (a[x.arm] || 0) + 1, a), {})));
}
// neutral grader view: gview/<hash of real path>/ symlinks to the real corpus, so x1 and x5 paths look alike (padding files opened inside still reveal size: known limit)
function gview(real) { const d = join(ROOT, 'step1/gview'), l = join(d, createHash('sha256').update(real).digest('hex').slice(0, 10)); mkdirSync(d, { recursive: true }); if (!existsSync(l)) symlinkSync(real, l); return l; }
function cmdGrade(round, shard, n) {
  const Q = loadQ(); const dir = join(G, `r${round}`), key = keyOf(round);
  readdirSync(join(dir, 'items')).sort().forEach((fn, i) => { if (i % n !== shard) return; const id = fn.replace('.json', ''), of = join(dir, 'out', id + '.json'); if (existsSync(of)) return;
    const it = JSON.parse(readFileSync(join(dir, 'items', fn))), q = Q[it.qid] ?? loadAllQ()[it.qid], real = join(key[it.id]?.corpusRoot ?? CROOT, it.repo, 'corpus'), corpus = gview(real); // grader sees a neutral opaque path (hides size: root5x vs answer)
    if (process.env.STEP1_DRY) { console.log(id, corpus); return; }
    const sys = `You are a strict, careful grader. You may read the corpus at ${corpus} (docs/ and sessions/ subfolders) using Read/Grep/Glob. Paths cited in answers are relative to that corpus root; line ranges are 1-based. Output ONLY a single JSON object, no prose.`;
    const prompt = `QUESTION: ${q.question}\n\nGOLD ANSWER: ${q.gold}\n\nMUST FACTS:\n${q.must.map(m => '- ' + m).join('\n')}\n\nGOLD SOURCES: ${q.sources.join('; ')}\n\nANSWER TO GRADE:\n<<<\n${it.answer}\n>>>\n\nInstructions: Open EACH citation in the answer (path:line-range under ${corpus}) and quote the lines you actually read. Then judge:\n- correct: "yes" = all must facts are present in the answer and nothing contradicts gold; "partial" = some must facts present; "no" otherwise (including "not found" or no answer).\n- cited: "yes" = at least one citation whose lines actually contain the answer (any valid location, not only gold sources); "no" otherwise (no citations, wrong lines, fabricated).\nReturn strict JSON: {"correct":"yes|partial|no","cited":"yes|no","evidence":"<quoted lines you read, or 'NO CITATIONS' if the answer has none>","reason":"<specific, item-unique reasoning>"}`;
    let out, cost = 0;
    for (let t = 0; t < 3; t++) {
      const r = spawnSync('claude', ['-p', prompt, '--model', 'sonnet', '--output-format', 'json', '--system-prompt', sys, '--strict-mcp-config', '--no-session-persistence', '--setting-sources', '', '--disable-slash-commands', '--permission-mode', 'dontAsk',
        '--tools=Read,Grep,Glob', '--allowedTools', `Read(/${corpus}/**)`, `Grep(/${corpus}/**)`, `Glob(/${corpus}/**)`, '--add-dir', corpus, '--disallowedTools', 'Bash', 'WebFetch', 'WebSearch', 'Edit', 'Write', '--max-turns', '20'],
        { cwd: SCRATCH, encoding: 'utf8', timeout: 600000, maxBuffer: 1 << 26 });
      let j; try { j = JSON.parse(r.stdout); } catch { if (BAD.test(r.stdout + r.stderr)) { console.error('LIMIT/LOGIN HIT in grader - exiting'); process.exit(3); } console.error('noparse', r.stderr?.slice(0, 200)); continue; }
      cost += j.total_cost_usd ?? 0;
      if (BAD.test(j.result ?? '') && (j.result ?? '').length < 600) { console.error('LIMIT/LOGIN HIT in grader - exiting'); process.exit(3); }
      const m = (j.result ?? '').match(/\{[\s\S]*\}/); let p; try { p = JSON.parse(m[0]); } catch { console.error('badjson', (j.result || '').slice(0, 200)); continue; }
      if (!['yes', 'partial', 'no'].includes(p.correct) || !['yes', 'no'].includes(p.cited)) continue;
      if (/\S+\.md:\d+/.test(it.answer) && (!p.evidence || String(p.evidence).trim().length < 10)) continue;
      out = { id, grade: p, cost, turns: j.num_turns, attempt: t + 1 }; break; }
    writeFileSync(of, JSON.stringify(out ?? { id, failed: true, cost })); console.log(id, out ? `${out.grade.correct}/${out.grade.cited}` : 'FAILED', cost.toFixed(4)); });
}
function loadAllQ() { return loadQ(); }

// ---------- scoring ----------
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const med = (a) => { a = [...a].sort((x, y) => x - y); const m = a.length >> 1; return a.length ? (a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2) : NaN; };
// one-sided exact Wilcoxon signed-rank (H1: median d > 0); zeros dropped; tied |d| get average ranks (doubled to integers for an exact DP over sign flips)
export function wilcoxon(d) {
  const nz = d.filter(x => Math.abs(x) > 1e-9), dropped = d.length - nz.length, n = nz.length; if (!n) return { p: 1, n, dropped };
  const idx = nz.map((x, i) => i).sort((a, b) => Math.abs(nz[a]) - Math.abs(nz[b])), rank2 = new Array(n);
  for (let i = 0; i < n;) { let j = i; while (j + 1 < n && Math.abs(Math.abs(nz[idx[j + 1]]) - Math.abs(nz[idx[i]])) < 1e-9) j++; for (let k = i; k <= j; k++) rank2[idx[k]] = i + j + 2; i = j + 1; }
  const tot = rank2.reduce((a, b) => a + b, 0), obs = nz.reduce((a, x, i) => a + (x > 0 ? rank2[i] : 0), 0);
  let dp = new Float64Array(tot + 1); dp[0] = 1; for (const r of rank2) { const nx = new Float64Array(tot + 1); for (let s = 0; s <= tot; s++) if (dp[s]) { nx[s] += dp[s] / 2; nx[s + r] += dp[s] / 2; } dp = nx; }
  let p = 0; for (let s = obs; s <= tot; s++) p += dp[s]; return { p, n, dropped };
}
function finalRows() {
  const runs = loadRuns(), gb = gradesByRun(), rows = [];
  for (const o of runs) { const gs = gb[o.id]; if (!gs?.[1]) continue; let w1 = winOf(gs[1]), fin = w1, how = 'first';
    if (gs[2]) { const w2 = winOf(gs[2]); if (w1 === w2) how = 'second-agrees'; else if (gs[3]) { fin = [w1, w2, winOf(gs[3])].filter(Boolean).length >= 2; how = 'majority-of-3'; } else { fin = null; how = 'PENDING-THIRD'; } }
    rows.push({ id: o.id, size: o.size, capped: o.result.subtype === 'error_max_turns', qid: o.qid, repo: o.repo, arm: o.arm, rep: o.rep, win: fin, how, g1: gs[1].grade, tok: o.tokens, cost: o.cost, turns: o.result.num_turns, ms: o.ms, ncalls: o.calls.length,
      usedLx: o.calls.some(c => c.tool === 'Bash'), usedGrep: o.calls.some(c => ['Grep', 'Glob', 'Read'].includes(c.tool)) }); }
  return rows;
}
// one-sided exact sign test (H1: more positive than negative); zeros dropped
export function signTest(g) { const nz = g.filter(x => Math.abs(x) > 1e-9), n = nz.length, pos = nz.filter(x => x > 0).length; let p = 0, c = 1;
  const C = []; for (let k = 0; k <= n; k++) { C.push(c); c = c * (n - k) / (k + 1); } for (let k = pos; k <= n; k++) p += C[k] / 2 ** n; return { p: n ? p : 1, n, pos, dropped: g.length - n }; }
function cmdScore() {
  const Q = loadAllQ(), rows = finalRows(), runs = loadRuns(); let out = `# Step-1 v2 score (grades dir ${OUT}, pool ${POOL ? POOL.join(' + ') : OUT}, k=${K})\n`;
  const qs = Object.values(Q).map(q => q.id), pend = rows.filter(r => r.win === null).length;
  const sizes = SIZES.filter(z => runs.some(r => r.size === z)), armsAt = (z) => ARMS.filter(a => a !== 'C' || z === 'x1');
  const exp = (arm) => qs.length * (arm === 'C' ? 1 : K), have = (arm, z) => rows.filter(r => r.arm === arm && r.size === z && r.win !== null).length;
  const incompleteAt = (z) => armsAt(z).filter(a => have(a, z) < exp(a));
  out += `runs graded: ${rows.length}, pending third grade: ${pend}\n`; for (const z of sizes) out += `incomplete at ${z}: ${incompleteAt(z).map(a => `${a} ${have(a, z)}/${exp(a)}`).join(', ') || 'none'}\n`;
  const s = (qid, arm, z) => { const r = rows.filter(x => x.qid === qid && x.arm === arm && x.size === z && x.win !== null); return r.length ? r.filter(x => x.win).length / r.length : null; };
  const tokQ = (qid, arm, z) => { const r = rows.filter(x => x.qid === qid && x.arm === arm && x.size === z); return r.length ? med(r.map(x => x.tok)) : null; };
  const ratio = (id, z) => tokQ(id, 'D', z) / tokQ(id, 'B', z);
  const slice = { all: () => true, docs: q => q.type === 'docs', sessions: q => q.type === 'sessions' || q.type === 'session',
    neighbour_spanning: q => /\bslice:neighbour\b/.test(q.notes ?? '') || q.span === true || q.neighbour === true || (q.tags ?? []).includes('slice:neighbour'),
    superseded: q => /\bslice:superseded\b/.test(q.notes ?? '') || q.superseded === true || (q.tags ?? []).includes('slice:superseded') };
  const cmp = (X, Y, z, f = () => true, repo = null) => { const ids = qs.filter(id => (!repo || Q[id].repo === repo) && f(Q[id]) && s(id, X, z) !== null && s(id, Y, z) !== null);
    const d = ids.map(id => s(id, X, z) - s(id, Y, z)); const w = wilcoxon(d), sd = Math.sqrt(mean(d.map(x => (x - mean(d)) ** 2)) / Math.max(1, d.length - 1) || 0);
    return { n: ids.length, meanD: mean(d), sd, wil: w, tokRatio: med(ids.map(id => ratio(id, z)).filter(Number.isFinite)), wins: [d.filter(x => x > 1e-9).length, d.filter(x => x < -1e-9).length] }; };
  const fmt = (c) => `n=${c.n} meanD=${c.meanD.toFixed(3)} (se ${c.sd.toFixed(3)}) wilcoxon p=${c.wil.p.toFixed(4)} (n=${c.wil.n}, ties dropped ${c.wil.dropped}) up/down=${c.wins.join('/')} tokRatio(med)=${c.tokRatio.toFixed(2)}`;
  const outcomes = {}, P = {};
  for (const z of sizes) {
    out += `\n## Size ${z}\n| arm | runs | win rate | 0 | 1/3 | 2/3 | 3/3 (k-scaled) | tok med | cost $ | cost/run | turns mean | turn-cap share |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const a of armsAt(z)) { const r = rows.filter(x => x.arm === a && x.size === z && x.win !== null), rr = runs.filter(x => x.arm === a && x.size === z), ss = qs.map(id => s(id, a, z)).filter(x => x !== null), dist = (v) => ss.filter(x => Math.abs(x - v) < 1e-9).length, tc = rr.reduce((t, x) => t + (x.cost || 0), 0);
      out += `| ${a} | ${r.length} | ${(mean(r.map(x => +x.win)) || 0).toFixed(3)} | ${dist(0)} | ${dist(1 / 3)} | ${dist(2 / 3)} | ${dist(1)} | ${Math.round(med(r.map(x => x.tok)))} | ${tc.toFixed(3)} | ${(tc / (rr.length || 1)).toFixed(4)} | ${mean(r.map(x => x.turns)).toFixed(1)} | ${(rr.filter(x => x.result.subtype === 'error_max_turns').length / (rr.length || 1)).toFixed(2)} |\n`; }
    const p = cmp('D', 'B', z); P[z] = { all: p, repo: {} }; out += `\n### Primary D vs B @${z}\noverall: ${fmt(p)}\n`;
    for (const repo of REPOS) { P[z].repo[repo] = cmp('D', 'B', z, () => true, repo); out += `${repo}: ${P[z].repo[repo].n ? fmt(P[z].repo[repo]) : 'n/a'}\n`; }
    const pr = P[z].repo, has = REPOS.every(r => pr[r].n), c1 = p.meanD >= 0.10, c2 = has && REPOS.every(r => pr[r].meanD >= 0.05), c3 = p.wil.p < 0.05, c4 = p.tokRatio <= 0.75;
    const cheaper = p.meanD >= -0.05 && has && REPOS.every(r => pr[r].meanD >= -0.05) && c4, worse = p.meanD <= -0.10 || (has && REPOS.every(r => pr[r].meanD < 0));
    out += `bar: (1) meanD>=+0.10 ${c1}; (2) each repo >=+0.05 ${c2}; (3) wilcoxon p<0.05 ${c3}; (4) token ratio<=0.75 ${c4}\n`;
    outcomes[z] = incompleteAt(z).length || pend ? 'INCOMPLETE (not scored)' : (c1 && c2 && c3 && c4) ? 'PASS' : cheaper ? 'PASS-CHEAPER (not a pass)' : worse ? 'FAIL-WORSE' : 'FAIL';
    out += `OUTCOME @${z}: ${outcomes[z]}\n\nSlices D-B @${z}:\n`;
    for (const [nm, f] of Object.entries(slice)) { const n = qs.filter(id => f(Q[id])).length; out += n ? `  ${nm} (${n} q): ${(c => c.n ? c.meanD.toFixed(3) : 'n/a')(cmp('D', 'B', z, f))}\n` : `  ${nm}: no questions flagged\n`; }
  }
  out += '\n## SCALE: g = d(x5) - d(x1) per question\n';
  if (sizes.includes('x1') && sizes.includes('x5')) {
    const dq = (id, z) => (s(id, 'D', z) !== null && s(id, 'B', z) !== null) ? s(id, 'D', z) - s(id, 'B', z) : null, ids = qs.filter(id => dq(id, 'x1') !== null && dq(id, 'x5') !== null), g = (l) => l.map(id => dq(id, 'x5') - dq(id, 'x1'));
    const gs = g(ids), sg = signTest(gs), wl = wilcoxon(gs), rch = ids.map(id => ratio(id, 'x5') - ratio(id, 'x1')).filter(Number.isFinite);
    out += `questions with both sizes: ${ids.length} of ${qs.length}\nmean g overall: ${mean(gs).toFixed(3)}\n`; for (const repo of REPOS) { const l = ids.filter(id => Q[id].repo === repo); out += `mean g ${repo}: ${l.length ? mean(g(l)).toFixed(3) : 'n/a'} (n=${l.length})\n`; }
    out += `sign test (one-sided, H1 g>0): p=${sg.p.toFixed(4)} (positive ${sg.pos} of ${sg.n} nonzero; zeros dropped ${sg.dropped})\nwilcoxon (secondary, one-sided) on g: p=${wl.p.toFixed(4)} (n=${wl.n}, ties dropped ${wl.dropped})\n`;
    out += `token ratio D/B: median x1 ${P.x1.all.tokRatio.toFixed(2)}, median x5 ${P.x5.all.tokRatio.toFixed(2)}, change (x5-x1) ${(P.x5.all.tokRatio - P.x1.all.tokRatio).toFixed(2)}; median of per-question change ${med(rch).toFixed(2)}\n`;
    const grows = mean(gs) >= 0.05 && sg.p < 0.05, inc = outcomes.x1.startsWith('INCOMPLETE') || outcomes.x5.startsWith('INCOMPLETE');
    out += `SCALE OUTCOME: ${inc ? 'INCOMPLETE (not scored)' : grows ? 'GAP GROWS' : 'GAP DOES NOT GROW'}  [rule: mean g >= +0.05 AND sign-test p < 0.05]\n`;
  } else out += `needs both sizes present (have: ${sizes.join(',') || 'none'}) - INCOMPLETE\n`;
  const cw = (repo) => qs.filter(id => Q[id].repo === repo && s(id, 'C', 'x1') === 1).length; out += '\n## C floor, x1 only (leak flag if >=5 wins per repo)\n' + REPOS.map(r => `${r}: ${cw(r)} wins${cw(r) >= 5 ? '  LEAK-FLAG' : ''}`).join('; ') + '\n';
  const n1 = Object.keys(keyOf(2)).length, n3 = Object.keys(keyOf(3)).length; const flips = rows.filter(r => r.how === 'majority-of-3' || r.how === 'PENDING-THIRD').length;
  out += `\n## Grading\nfirst grades ${Object.keys(keyOf(1)).length}; second grades ${n1}; third grades ${n3}; second-grade items that differed on win/not-win (went to third): ${flips}\n`;
  const gcost = [1, 2, 3].reduce((t, rd) => t + Object.keys(keyOf(rd)).reduce((a, id) => a + (gradeOf(rd, id)?.cost ?? 0), 0), 0), rcost = runs.reduce((t, x) => t + (x.cost || 0), 0);
  out += `\n## Cost\nrun cost $${rcost.toFixed(3)}; grader cost $${gcost.toFixed(3)}; total $${(rcost + gcost).toFixed(3)} (PREREG v2 estimate ~$60-72; HARD STOP $90)\n`;
  out += '\n## D tool use (per run: Bash/lx vs Read/Grep/Glob)\n' + rows.filter(r => r.arm === 'D').map(r => `${r.id}: lx=${r.usedLx} grep/read=${r.usedGrep} calls=${r.ncalls}`).join('\n') + '\n';
  out += '\n## Per-question grid (win-fraction per arm.size)\n| qid | repo | type | ' + sizes.flatMap(z => armsAt(z).map(a => a + '.' + z)).join(' | ') + ' |\n|---|---|---|' + sizes.flatMap(z => armsAt(z).map(() => '---')).join('|') + '|\n';
  for (const id of qs.sort()) out += `| ${id} | ${Q[id].repo} | ${Q[id].type} | ${sizes.flatMap(z => armsAt(z).map(a => { const v = s(id, a, z); return v === null ? '-' : v.toFixed(2); })).join(' | ')} |\n`;
  writeFileSync(join(OUT, 'score.md'), out); writeFileSync(join(OUT, 'rows.json'), JSON.stringify(rows, null, 1)); console.log(out);
}
function cmdAudit(seed = 4242) { const rows = finalRows(); const pick = shuffle([...rows], +seed).slice(0, 20); writeFileSync(join(OUT, 'audit.json'), JSON.stringify({ seed: +seed, items: pick.map(r => ({ runId: r.id, arm: r.arm, qid: r.qid, finalWin: r.win, grade1: r.g1 })) }, null, 1)); console.log('audit sample (seed', seed, ') written to audit.json:', pick.map(r => r.id).join(' ')); }

if (process.argv[1].endsWith('tinymem-step1.mjs')) {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === 'run') cmdRun(+a[0] || 0, +a[1] || 1); else if (cmd === 'grade-build') cmdBuild(+a[0]); else if (cmd === 'grade') cmdGrade(+a[0], +a[1] || 0, +a[2] || 1);
  else if (cmd === 'score') cmdScore(); else if (cmd === 'audit') cmdAudit(a[0]); else { console.error('usage: run|grade-build|grade|score|audit'); process.exit(2); }
}
