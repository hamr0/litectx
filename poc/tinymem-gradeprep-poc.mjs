// Throwaway POC: build blind grading packets from stage8 hits (non-gold top-5 pool). Outputs only under stage8/grade/.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = join(homedir(), '.cache/tinymem-probe/out');
const CORPUS = join(BASE, 'stage7b/corpus'), OUT = join(BASE, 'stage8/grade');
mkdirSync(OUT, { recursive: true });
const SEED = 20260930, CAP = 5000, NPACK = 4;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const Q = JSON.parse(readFileSync(join(BASE, 'stage7b/questions.json')));
const H = JSON.parse(readFileSync(join(BASE, 'stage8/hits.json')));

// H2 units: identical splitting to tinymem-mempath-poc.mjs (first occurrence wins for duplicate headings)
const units = new Map();
for (const d of ['wiki', 'product', 'logs']) for (const f of readdirSync(join(CORPUS, d)).filter((x) => x.endsWith('.md')).sort()) {
  const file = `${d}/${f}`; const L = readFileSync(join(CORPUS, file), 'utf8').split('\n');
  let fence = false, cur = { heading: '(preamble)', lines: [] }; const secs = [];
  for (const ln of L) {
    if (/^\s*(```|~~~)/.test(ln)) fence = !fence;
    if (!fence && /^## /.test(ln)) { secs.push(cur); cur = { heading: ln.slice(3).trim(), lines: [ln] }; } else cur.lines.push(ln);
  }
  secs.push(cur);
  for (const s of secs) { const text = s.lines.join('\n'); if (s.heading === '(preamble)' && !text.trim()) continue; const k = `${file}\x1f${s.heading}`; if (!units.has(k)) units.set(k, text); }
}

const pool = new Map(); // pairId -> rec
let missing = 0;
for (const q of Q) {
  const gold = new Set(q.gold.map((g) => `${g.file}\x1f${g.heading}`));
  for (const a of ['A', 'B']) for (const m of ['doc-bm25', 'doc-emb', 'mem-bm25', 'mem-emb']) for (const h of (H[q.id]?.[a]?.[m] ?? []).slice(0, 5)) {
    const k = `${h.file}\x1f${h.heading}`; if (gold.has(k)) continue;
    const pairId = sha(`${q.id}|${h.file}|${h.heading}`).slice(0, 10);
    let r = pool.get(pairId);
    if (!r) { r = { pairId, q, qid: q.id, file: h.file, heading: h.heading, methods: new Set(), asks: new Set() }; pool.set(pairId, r); }
    r.methods.add(m); r.asks.add(a);
  }
}
const pairs = [...pool.values()].sort((x, y) => (x.pairId < y.pairId ? -1 : 1));
for (const p of pairs) {
  let t = units.get(`${p.file}\x1f${p.heading}`);
  if (t === undefined) { missing++; p.text = null; p.missing = true; continue; }
  if (t.length > CAP) t = t.slice(0, CAP) + `\n[…section continues, ${t.length - CAP} more chars]`;
  p.text = t;
}
// seeded shuffle (mulberry32 + Fisher-Yates)
let s = SEED; const rnd = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
// balance by size: greedy (largest first) into lightest packet; ignore question grouping
const size = (p) => (p.text ?? '').length + 300;
const packs = Array.from({ length: NPACK }, () => ({ items: [], chars: 0 }));
const order = pairs.map((p, i) => ({ p, i })).sort((a, b) => size(b.p) - size(a.p) || a.i - b.i);
for (const { p, i } of order) { const t = packs.reduce((a, b) => (b.chars < a.chars ? b : a)); t.items.push({ p, i }); t.chars += size(p); }
const key = {};
const rep = [];
packs.forEach((pk, n) => {
  pk.items.sort((a, b) => a.i - b.i);
  const body = pk.items.map(({ p }) => { key[p.pairId] = { qid: p.qid, file: p.file, heading: p.heading, methods: [...p.methods].sort(), asks: [...p.asks].sort() };
    return JSON.stringify({ pairId: p.pairId, question: { topic: p.q.topic, askA: p.q.askA, askB: p.q.askB }, file: p.file, heading: p.heading, text: p.text ?? '[missing]' }); }).join('\n') + '\n';
  writeFileSync(join(OUT, `packet-${n + 1}.jsonl`), body);
  rep.push({ packet: n + 1, pairs: pk.items.length, textChars: pk.items.reduce((a, { p }) => a + (p.text ?? '').length, 0), sha256: sha(body) });
});
const keyBody = JSON.stringify(Object.fromEntries(Object.keys(key).sort().map((k) => [k, key[k]])), null, 1);
writeFileSync(join(OUT, 'key.json'), keyBody);
console.log(JSON.stringify({ seed: SEED, pool: pairs.length, expected: 427, missing, packets: rep, keySha256: sha(keyBody) }, null, 1));
