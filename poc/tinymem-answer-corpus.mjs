// Answer test, stage 1: build frozen corpora (tracked md docs + converted Claude Code main-thread sessions).
// usage: node poc/tinymem-answer-corpus.mjs   -> ~/.cache/tinymem-probe/out/answer/<repo>/corpus/{docs,sessions,README.md,MANIFEST.json}
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const OUT = join(homedir(), '.cache/tinymem-probe/out/answer');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const REPOS = ['bareloop', 'bareagent'];

// secret scrubbing: nothing key-shaped may reach the corpus or any printed output
const SECRET = [/sk-ant-[A-Za-z0-9_-]{10,}/g, /sk-[A-Za-z0-9_-]{20,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g, /xox[baprs]-[A-Za-z0-9-]{10,}/g, /npm_[A-Za-z0-9]{30,}/g, /AIza[0-9A-Za-z_-]{30,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/g, /((?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g];
let redactions = 0;
const scrub = (t) => { for (const re of SECRET) t = t.replace(re, (m, p1) => { redactions++; return (typeof p1 === 'string' && p1 && m.startsWith(p1) ? p1 : '') + '[REDACTED]'; }); return t; };

const WRAP = /^\s*<(task-notification|local-command-|command-name|command-message|command-args|bash-stdout|bash-input|bash-stderr|system-reminder|user-prompt-submit-hook|local-command)/;
const textOf = (c) => typeof c === 'string' ? c : (Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');
const noise = (t) => WRAP.test(t) || /^\s*\[Request interrupted/.test(t) || /^Another Claude session sent a message/.test(t) || /^Base directory for this skill/.test(t) || /^Caveat: The messages below/.test(t);

function convert(file) {
  const raw = readFileSync(file, 'utf8'); const rows = []; const ent = new Set(); let first = null, id = null;
  for (const l of raw.split('\n')) {
    if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.entrypoint) ent.add(o.entrypoint); if (o.sessionId) id ||= o.sessionId;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (o.isSidechain || o.isMeta || (o.origin && o.origin.kind !== 'human')) continue;
    if (o.type === 'user' && Array.isArray(o.message?.content) && o.message.content.some((b) => b.type === 'tool_result')) continue;
    const t = textOf(o.message?.content).trim(); if (!t || noise(t)) continue;
    first ||= o.timestamp; rows.push({ ts: o.timestamp, role: o.type, t });
  }
  return { raw: raw.length, ent: [...ent], id, first, rows };
}

const stats = {};
for (const repo of REPOS) {
  const gitRoot = join(homedir(), 'PycharmProjects', repo), base = join(OUT, repo), corpus = join(base, 'corpus');
  rmSync(corpus, { recursive: true, force: true }); mkdirSync(join(corpus, 'docs'), { recursive: true }); mkdirSync(join(corpus, 'sessions'), { recursive: true });
  const head = execFileSync('git', ['-C', gitRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // docs: tracked md at HEAD (git show, so the frozen text is the committed text)
  let docBytes = 0; const docs = execFileSync('git', ['-C', gitRoot, 'ls-files', '*.md'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort();
  let nDocs = 0;
  for (const f of docs) { let b; try { b = execFileSync('git', ['-C', gitRoot, 'show', `HEAD:${f}`], { maxBuffer: 1 << 27 }); } catch { continue; }
    mkdirSync(dirname(join(corpus, 'docs', f)), { recursive: true }); writeFileSync(join(corpus, 'docs', f), b); docBytes += b.length; nDocs++; }
  // sessions
  const pdir = join(homedir(), '.claude/projects', `-home-hamr-PycharmProjects-${repo}`);
  const files = readdirSync(pdir).filter((f) => f.endsWith('.jsonl')).sort();
  const excl = { headless_sdk_cli: 0, no_human_turns: 0, no_entrypoint_marker_but_empty: 0 }; let kept = 0, rawKept = 0, sessBytes = 0, sections = 0, rawAll = 0;
  const seen = new Map(); let dupSections = 0;
  for (const f of files) {
    const c = convert(join(pdir, f)); rawAll += c.raw;
    if (c.ent.includes('sdk-cli') || c.ent.includes('sdk-ts') || c.ent.includes('sdk-py')) { excl.headless_sdk_cli++; continue; }
    if (!c.rows.some((r) => r.role === 'user')) { excl.no_human_turns++; continue; }
    const id = c.id || f.replace('.jsonl', ''), date = (c.first || '').slice(0, 10);
    let md = `# Session ${id} (${c.first})\n\n`;
    for (const r of c.rows) { const k = sha(r.t); if (seen.has(k)) dupSections++; seen.set(k, 1); md += `## ${r.ts} — ${r.role}\n\n${scrub(r.t)}\n\n`; sections++; }
    writeFileSync(join(corpus, 'sessions', `${date}-${id.slice(0, 8)}.md`), md); kept++; rawKept += c.raw; sessBytes += md.length;
  }
  // manifest + README
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  const all = walk(corpus).sort();
  const manifest = all.map((p) => ({ path: p.slice(corpus.length + 1), bytes: statSync(p).size, sha256: sha(readFileSync(p)) }));
  writeFileSync(join(corpus, 'MANIFEST.json'), JSON.stringify({ repo, head, files: manifest }, null, 1));
  stats[repo] = { head, mdDocs: nDocs, docBytes, sessionFilesFound: files.length, sessionsKept: kept, excluded: excl, rawBytesAllJsonl: rawAll, rawBytesKeptJsonl: rawKept, sessionBytesAfter: sessBytes, sessionSections: sections, duplicateSectionBodiesAcrossSessions: dupSections, redactionsApplied: redactions, totalCorpusBytes: docBytes + sessBytes };
  writeFileSync(join(base, 'README.md'), `repo ${repo} @ ${head}\nmd docs: ${nDocs} (${docBytes} bytes)\nsessions kept: ${kept}; excluded: ${JSON.stringify(excl)}\nsession sections (main-thread text only): ${sections}; session bytes ${sessBytes} (raw jsonl kept ${rawKept})\ntotal bytes: ${docBytes + sessBytes}\n`);
  redactions = 0;
}
writeFileSync(join(OUT, 'corpus-stats.json'), JSON.stringify(stats, null, 1));
console.log(JSON.stringify(stats, null, 1));
