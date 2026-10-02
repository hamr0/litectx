// THROWAWAY POC — tinymem module 0, round 5: BUILD topics from the docs instead of using the 29 fixed pages.
// Units = every H2 section (+ preamble) of every frozen bareloop doc (out/stage1/pieces-docs.jsonl). Docs only.
// Method A: TF-IDF cosine + average-linkage agglomerative clustering at several thresholds.
// Method B: term recurrence + co-occurrence graph (Jaccard) -> communities (label propagation / connected comps) -> units assigned to <=2 topics.
// Scored as co-membership against the existing answer key (labels-structured-*.jsonl), with seeded random-partition baselines.
// Deterministic, no model, no deps. Writes ONLY out/stage5/{results.json,report.md,topics.md}.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.TINYMEM_PROBE_DIR || join(homedir(), ".cache", "tinymem-probe");
const FILTER = process.env.TOPICS_FILTER === "1";   // round 5b: exam file exclusions + near-duplicate collapse
const S1 = join(ROOT, "out", "stage1"), S2 = join(ROOT, "out", "stage2"), OUT = join(ROOT, "out", FILTER ? "stage5b" : "stage5");
mkdirSync(OUT, { recursive: true });
const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const r4 = (x) => Math.round(x * 10000) / 10000;

// ---------- units ----------
let units = readJsonl(join(S1, "pieces-docs.jsonl"))
  .sort((a, b) => cmp(a.path, b.path) || a.startLine - b.startLine || cmp(a.id, b.id));
const allIds = units.map((u) => u.id);
const filterInfo = { enabled: FILTER };
let uidx;
if (FILTER) {
  // 5b filter 1: same exclusion as the structured exam (tinymem-sample-poc.mjs:73 draws only bucket wiki|logs; tinymem.md:297
  // "The archive and the three generated top-level files are left out"). Cut script buckets: archive, other (README/index/log).
  const before = units.length;
  const dropped = {}; units.forEach((u) => { if (u.bucket === "archive" || u.bucket === "other") dropped[u.bucket] = (dropped[u.bucket] || 0) + 1; });
  units = units.filter((u) => u.bucket !== "archive" && u.bucket !== "other");
  filterInfo.excluded = { buckets: ["archive", "other"], dropped, before, after: units.length };
  // 5b filter 2: near-duplicate collapse, 3-word shingle Jaccard >= 0.8, greedy against representatives, rep = lowest unit index.
  const sh = units.map((u) => { const w = u.text.toLowerCase().match(/[a-z0-9_]+/g) || []; const s = new Set(); if (w.length < 3) s.add(w.join(" ")); for (let i = 0; i + 2 < w.length; i++) s.add(w[i] + " " + w[i + 1] + " " + w[i + 2]); return s; });
  const reps = [], repOf = new Array(units.length);
  for (let i = 0; i < units.length; i++) {
    let hit = -1;
    for (const r of reps) {
      const a = sh[i], b = sh[r]; if (Math.min(a.size, b.size) / Math.max(a.size, b.size) < 0.8) continue;
      let inter = 0; for (const x of a) if (b.has(x)) inter++;
      if (inter / (a.size + b.size - inter) >= 0.8) { hit = r; break; }
    }
    if (hit < 0) { reps.push(i); repOf[i] = i; } else repOf[i] = hit;
  }
  const fam = new Map(); repOf.forEach((r, i) => { if (!fam.has(r)) fam.set(r, []); fam.get(r).push(i); });
  const fams = [...fam.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
  filterInfo.dedupe = { shingle: 3, jaccard: 0.8, unitsBefore: units.length, collapsed: units.length - reps.length, unitsAfter: reps.length, familiesGt1: fams.length,
    biggestFamilies: fams.slice(0, 12).map((g) => ({ size: g.length, rep: `${units[g[0]].heading} [${units[g[0]].path.split("/").pop()}]`, members: [...new Set(g.map((i) => `${units[i].heading} [${units[i].path.split("/").pop()}]`))].slice(0, 4) })) };
  const newIndex = new Map(reps.map((r, k) => [r, k]));
  uidx = new Map(); units.forEach((u, i) => uidx.set(u.id, newIndex.get(repOf[i])));
  units = reps.map((r) => units[r]);
}
const N = units.length;
if (!FILTER) uidx = new Map(units.map((u, i) => [u.id, i]));
const pages = JSON.parse(readFileSync(join(S1, "pages.json"), "utf8")).sort((a, b) => cmp(a.path, b.path))
  .map((p, i) => ({ ...p, pid: "P" + String(i + 1).padStart(2, "0") }));
const pagePath = new Map(pages.map((p) => [p.pid, p.path]));

// ---------- tokeniser ----------
const STOP = new Set(`a about above after again against all also am an and any are aren as at be because been before being below between both but by can cannot could did do does doing don down during each few for from further had has have having he her here hers him his how i if in into is isn it its itself just let me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours yet via per etc ie eg vs also may might must shall one two three first second new use used using like get got set see via within without across whether since still both either neither`.split(/\s+/));
const HEX = /^[0-9a-f]{7,}$/;
function tokenize(text) {
  const out = [];
  const lower = text.toLowerCase();
  const raws = lower.match(/[a-z0-9_]+(?:[.\-][a-z0-9_]+)*/g) || [];
  const add = (t) => {
    if (t.length < 3 || t.length > 40) return;
    if (!/[a-z]/.test(t)) return;               // pure numbers / dates
    if (HEX.test(t) && /\d/.test(t)) return;    // hashes
    if (STOP.has(t)) return;
    out.push(t);
  };
  for (const raw of raws) {
    add(raw);                                    // intact token (index-yield, foo.js, better_sqlite3)
    if (/[.\-_]/.test(raw)) for (const part of raw.split(/[.\-_]+/)) add(part); // its parts too
  }
  return out;
}
const toks = units.map((u) => tokenize(u.text));
const df = new Map();
for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);

// ---------- labels ----------
const labels = [];
for (const h of ["tune", "held"]) for (const l of readJsonl(join(S2, `labels-structured-${h}.jsonl`))) {
  if (uidx.has(l.id)) labels.push({ ...l, ui: uidx.get(l.id) });
}
if (FILTER) {
  // all labelled pieces must still be units (directly or via a collapsed representative); a collapsed piece keeps ITS OWN page label,
  // scored at its representative's topic membership. Pieces from excluded buckets would fail this assert.
  const missing = labels.filter((l) => !uidx.has(l.id));
  if (missing.length) throw new Error("labelled pieces missing from units: " + missing.length);
  const direct = labels.filter((l) => units[uidx.get(l.id)].id === l.id).length;
  const byRep = new Map(); labels.forEach((l) => byRep.set(l.ui, (byRep.get(l.ui) || 0) + 1));
  filterInfo.labels = { total: labels.length, ownUnit: direct, viaRepresentative: labels.length - direct, repsCarryingMultipleLabels: [...byRep.values()].filter((c) => c > 1).length };
  const all = new Set(allIds); filterInfo.labels.allInFrozenPieces = labels.every((l) => all.has(l.id));
}
const labPaged = labels.filter((l) => l.page !== "none");
const labSure = labPaged.filter((l) => l.sure);

// ---------- Method A ----------
const idf = (w) => Math.log(N / df.get(w));
const vec = toks.map((t) => {
  const tf = new Map();
  for (const w of t) if (df.get(w) >= 2) tf.set(w, (tf.get(w) || 0) + 1);   // df==1 tokens can match nothing: dropped
  const v = new Map(); let n2 = 0;
  for (const [w, c] of [...tf].sort((a, b) => cmp(a[0], b[0]))) { const x = (1 + Math.log(c)) * idf(w); v.set(w, x); n2 += x * x; }
  const n = Math.sqrt(n2) || 1;
  for (const [w, x] of v) v.set(w, x / n);
  return v;
});
const S = new Float64Array(N * N);
for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
  let a = vec[i], b = vec[j]; if (a.size > b.size) [a, b] = [b, a];
  let d = 0; for (const [w, x] of a) { const y = b.get(w); if (y) d += x * y; }
  S[i * N + j] = S[j * N + i] = d;
}
const simValues = []; for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) simValues.push(S[i * N + j]);
simValues.sort((a, b) => a - b);
const pct = (p) => r4(simValues[Math.floor(p * (simValues.length - 1))]);
const simDist = { p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), p999: pct(0.999) };

const A_TH = [0.10, 0.15, 0.25, 0.35];
const minTh = Math.min(...A_TH);
// UPGMA (average linkage), merges recorded until best sim < minTh
const C = Float64Array.from(S); const size = new Int32Array(N).fill(1); const active = new Uint8Array(N).fill(1);
const best = new Int32Array(N).fill(-1), bestv = new Float64Array(N).fill(-1);
const rescan = (i) => { let bj = -1, bv = -1; for (let j = 0; j < N; j++) if (active[j] && j !== i && C[i * N + j] > bv) { bv = C[i * N + j]; bj = j; } best[i] = bj; bestv[i] = bv; };
for (let i = 0; i < N; i++) rescan(i);
const merges = [];
for (;;) {
  let a = -1, bv = -1; for (let i = 0; i < N; i++) if (active[i] && bestv[i] > bv) { bv = bestv[i]; a = i; }
  if (a < 0 || bv < minTh) break;
  const b = best[a]; merges.push([a, b, bv]);
  const sa = size[a], sb = size[b]; active[b] = 0;
  for (let k = 0; k < N; k++) if (active[k] && k !== a) { const v = (sa * C[a * N + k] + sb * C[b * N + k]) / (sa + sb); C[a * N + k] = C[k * N + a] = v; }
  size[a] = sa + sb; rescan(a);
  for (let i = 0; i < N; i++) if (active[i] && i !== a) { if (best[i] === a || best[i] === b) rescan(i); else if (C[i * N + a] > bestv[i]) { best[i] = a; bestv[i] = C[i * N + a]; } }
}
function cutA(th) {
  const p = Array.from({ length: N }, (_, i) => i); const f = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  for (const [a, b, v] of merges) if (v >= th) p[f(b)] = f(a);
  const groups = new Map(); for (let i = 0; i < N; i++) { const r = f(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const topics = [...groups.values()].filter((g) => g.length >= 2);
  return topics.map((g) => ({ units: g, name: nameByCentroid(g) }));
}
function nameByCentroid(g) {
  const sum = new Map();
  for (const i of g) for (const [w, x] of vec[i]) sum.set(w, (sum.get(w) || 0) + x);
  return [...sum].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 5).map((x) => x[0]);
}

// ---------- Method B ----------
const DF_MIN = 3, DF_MAX = Math.floor(0.10 * N);
const cand = [...df].filter(([, c]) => c >= DF_MIN && c <= DF_MAX).map(([w]) => w).sort();
const candSet = new Set(cand);
const topExcluded = [...df].filter(([, c]) => c > DF_MAX).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 25).map(([w, c]) => `${w}:${c}`);
const tooRare = [...df].filter(([, c]) => c < DF_MIN).length;
const unitTerms = toks.map((t) => new Set(t.filter((w) => candSet.has(w))));
const postings = new Map(cand.map((w) => [w, []]));
unitTerms.forEach((s, i) => { for (const w of s) postings.get(w).push(i); });
function coGraph(jcut) {
  const co = new Map();
  unitTerms.forEach((s) => { const a = [...s].sort(); for (let x = 0; x < a.length; x++) for (let y = x + 1; y < a.length; y++) { const k = a[x] + "\u0001" + a[y]; co.set(k, (co.get(k) || 0) + 1); } });
  const adj = new Map(cand.map((w) => [w, []]));
  let edges = 0;
  for (const [k, c] of [...co].sort((a, b) => cmp(a[0], b[0]))) {
    if (c < 3) continue;
    const [a, b] = k.split("\u0001"); const j = c / (df.get(a) + df.get(b) - c);
    if (j >= jcut) { adj.get(a).push([b, j]); adj.get(b).push([a, j]); edges++; }
  }
  return { adj, edges };
}
function components(adj) {
  const seen = new Set(), comps = [];
  for (const w of cand) { if (seen.has(w)) continue; const st = [w], c = []; seen.add(w); while (st.length) { const x = st.pop(); c.push(x); for (const [y] of adj.get(x)) if (!seen.has(y)) { seen.add(y); st.push(y); } } comps.push(c); }
  return comps;
}
function labelProp(adj) {
  const lab = new Map(cand.map((w) => [w, w]));
  for (let it = 0; it < 30; it++) {
    let changed = false;
    for (const w of cand) {
      const nb = adj.get(w); if (!nb.length) continue;
      const sc = new Map(); for (const [y, j] of nb) sc.set(lab.get(y), (sc.get(lab.get(y)) || 0) + j);
      let bl = lab.get(w), bs = -1; for (const [l, s] of [...sc].sort((a, b) => cmp(a[0], b[0]))) if (s > bs + 1e-12) { bs = s; bl = l; }
      if (bl !== lab.get(w)) { lab.set(w, bl); changed = true; }
    }
    if (!changed) break;
  }
  const g = new Map(); for (const w of cand) { const l = lab.get(w); if (!g.has(l)) g.set(l, []); g.get(l).push(w); }
  return [...g.values()];
}
function assignUnits(termGroups) {
  const groups = termGroups.filter((g) => g.length >= 2).sort((a, b) => b.length - a.length || cmp(a[0], b[0]));
  const members = groups.map(() => []);
  const tsets = groups.map((g) => new Set(g));
  for (let i = 0; i < N; i++) {
    const hits = groups.map((_, t) => { let h = 0; for (const w of unitTerms[i]) if (tsets[t].has(w)) h++; return h; });
    const order = hits.map((h, t) => [h, t]).filter(([h]) => h >= 2).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    if (!order.length) continue;
    members[order[0][1]].push(i);
    if (order[1] && order[1][0] >= 0.5 * order[0][0]) members[order[1][1]].push(i);
  }
  const topics = [];
  groups.forEach((g, t) => { if (members[t].length >= 2) topics.push({ units: members[t], name: [...g].sort((a, b) => df.get(b) - df.get(a) || cmp(a, b)).slice(0, 5), terms: [...g].sort((a, b) => df.get(b) - df.get(a) || cmp(a, b)) }); });
  return topics;
}

// ---------- scoring ----------
function memberOf(topics) { const m = Array.from({ length: N }, () => []); topics.forEach((t, ti) => t.units.forEach((u) => m[u].push(ti))); return m; }
const share = (a, b) => a.some((x) => b.includes(x));
function pairScore(mem, L) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const same = L[i].page === L[j].page, sh = share(mem[L[i].ui], mem[L[j].ui]);
    if (sh && same) tp++; else if (sh) fp++; else if (same) fn++; else tn++;
  }
  const P = tp + fp ? tp / (tp + fp) : 0, R = tp + fn ? tp / (tp + fn) : 0;
  return { pairs: tp + fp + fn + tn, samePairs: tp + fn, tp, fp, fn, P, R, F1: P + R ? 2 * P * R / (P + R) : 0 };
}
function overlapScore(mem, topics) {
  const L = labPaged.filter((l) => l.second && l.second !== "none" && pagePath.has(l.second));
  let both = 0, prim = 0;
  const hasDoc = (ti, path, self) => topics[ti].units.some((u) => u !== self && units[u].path === path);
  for (const l of L) {
    const ts = mem[l.ui];
    if (ts.some((t) => hasDoc(t, pagePath.get(l.page), l.ui))) prim++;
    if (ts.some((t) => hasDoc(t, pagePath.get(l.page), l.ui) && hasDoc(t, pagePath.get(l.second), l.ui))) both++;
  }
  return { n: L.length, both, primaryOnly: prim, bothRate: L.length ? both / L.length : 0, primaryRate: L.length ? prim / L.length : 0 };
}
function primaryHit(mem, topics) {
  let h = 0; for (const l of labPaged) if (mem[l.ui].some((t) => topics[t].units.some((u) => u !== l.ui && units[u].path === pagePath.get(l.page)))) h++;
  return h / labPaged.length;
}
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffleTopics(topics, mem, seed) {   // permute unit->topic-set assignment across ALL units: keeps topic-size dist, multiplicity, #unassigned
  const r = rng(seed), idx = Array.from({ length: N }, (_, i) => i);
  for (let i = N - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const m2 = Array.from({ length: N }, (_, i) => mem[idx[i]]);
  const t2 = topics.map(() => ({ units: [] })); m2.forEach((ts, u) => ts.forEach((t) => t2[t].units.push(u)));
  return { mem: m2, topics: t2 };
}
function spearman(x, y) {
  const rank = (a) => { const o = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); let i = 0; while (i < o.length) { let j = i; while (j + 1 < o.length && o[j + 1][0] === o[i][0]) j++; for (let k = i; k <= j; k++) r[o[k][1]] = (i + j) / 2; i = j + 1; } return r; };
  const a = rank(x), b = rank(y), n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sx = 0, sy = 0; for (let i = 0; i < n; i++) { sxy += (a[i] - ma) * (b[i] - mb); sx += (a[i] - ma) ** 2; sy += (b[i] - mb) ** 2; }
  return sx && sy ? sxy / Math.sqrt(sx * sy) : 0;
}
const NRAND = 20;
function evaluate(name, topics) {
  topics = topics.sort((a, b) => b.units.length - a.units.length);
  const mem = memberOf(topics);
  const sizes = topics.map((t) => t.units.length);
  const inTopic = mem.filter((m) => m.length).length;
  const giant = sizes[0] || 0;
  const real = { all: pairScore(mem, labPaged), sure: pairScore(mem, labSure), overlap: overlapScore(mem, topics), primaryHit: primaryHit(mem, topics) };
  const rnd = { all: [], sure: [], both: [], prim: [], ph: [] };
  for (let s = 0; s < NRAND; s++) {
    const sh = shuffleTopics(topics, mem, 1000 + s);
    rnd.all.push(pairScore(sh.mem, labPaged)); rnd.sure.push(pairScore(sh.mem, labSure));
    const o = overlapScore(sh.mem, sh.topics); rnd.both.push(o.bothRate); rnd.ph.push(primaryHit(sh.mem, sh.topics));
  }
  const avg = (a, k) => a.reduce((s, x) => s + x[k], 0) / a.length;
  const avgArr = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const pr = (arr) => ({ P: r4(avg(arr, "P")), R: r4(avg(arr, "R")), F1: r4(avg(arr, "F1")) });
  const lg = mem.map((m) => (m.includes(0) ? 1 : 0)), tsz = mem.map((m) => (m.length ? Math.max(...m.map((t) => sizes[t])) : 0)), bytes = units.map((u) => u.bytes);
  const f = (o) => ({ P: r4(o.P), R: r4(o.R), F1: r4(o.F1), tp: o.tp, fp: o.fp, fn: o.fn, pairs: o.pairs, samePairs: o.samePairs });
  return {
    name, nTopics: topics.length, unitsInTopics: inTopic, unitsInNoTopic: N - inTopic,
    giantSize: giant, giantShareOfAllUnits: r4(giant / N), giantShareOfAssigned: r4(inTopic ? giant / inTopic : 0),
    sizeDist: { top10: sizes.slice(0, 10), median: sizes[Math.floor(sizes.length / 2)] || 0, size2: sizes.filter((s) => s === 2).length, size3to5: sizes.filter((s) => s >= 3 && s <= 5).length, size6to20: sizes.filter((s) => s >= 6 && s <= 20).length, over20: sizes.filter((s) => s > 20).length },
    pairAll: f(real.all), pairAllRandom: pr(rnd.all), pairSure: f(real.sure), pairSureRandom: pr(rnd.sure),
    overlap: { n: real.overlap.n, both: real.overlap.both, bothRate: r4(real.overlap.bothRate), primaryRateOnOverlapPieces: r4(real.overlap.primaryRate), randomBothRate: r4(avgArr(rnd.both)) },
    primaryHitRate: r4(real.primaryHit), primaryHitRandom: r4(avgArr(rnd.ph)),
    sizeCorr: { spearmanUnitBytesVsTopicSize: r4(spearman(bytes, tsz)), spearmanUnitBytesVsInGiant: r4(spearman(bytes, lg)), spearmanUnitBytesVsInAnyTopic: r4(spearman(bytes, mem.map((m) => (m.length ? 1 : 0)))) },
    topics,
  };
}

// ---------- run ----------
const variants = [];
for (const th of A_TH) variants.push(evaluate(`A avg-link cos>=${th.toFixed(2)}`, cutA(th)));
for (const jc of [0.2, 0.35]) {
  const { adj, edges } = coGraph(jc);
  const lp = assignUnits(labelProp(adj)), cc = assignUnits(components(adj));
  const v1 = evaluate(`B label-prop jaccard>=${jc}`, lp), v2 = evaluate(`B conn-comp jaccard>=${jc}`, cc);
  v1.edges = v2.edges = edges; variants.push(v1, v2);
}

// ---------- output ----------
const uLabel = (i) => `${units[i].heading} [${units[i].path.split("/").pop()}]`;
const pickExamples = (g) => { const seen = new Set(), out = []; for (const i of g) { if (!seen.has(units[i].path)) { seen.add(units[i].path); out.push(i); } if (out.length === 5) break; } for (const i of g) { if (out.length >= 5) break; if (!out.includes(i)) out.push(i); } return out.slice(0, 5); };
const bucketCount = {}; units.forEach((u) => { bucketCount[u.bucket] = (bucketCount[u.bucket] || 0) + 1; });
const meta = {
  ...(FILTER ? { filter: filterInfo } : {}),
  units: N, byBucket: bucketCount, preambles: units.filter((u) => u.heading === "(preamble)").length, h2Units: units.filter((u) => u.heading !== "(preamble)").length,
  labelledStructured: labels.length, labelledWithPage: labPaged.length, labelledSure: labSure.length, labelledWithSecond: labPaged.filter((l) => l.second && l.second !== "none").length,
  samePagePairBaseRate: r4(pairScore(memberOf([]), labPaged).samePairs / pairScore(memberOf([]), labPaged).pairs),
  uniqueTokens: df.size, tokensDf1: [...df].filter(([, c]) => c === 1).length,
  methodA: { vectors: "sublinear tf * ln(N/df), L2-normalised, tokens with df<2 dropped", linkage: "average (UPGMA), thresholds " + A_TH.join("/"), topicMinSize: 2, pairSimilarityPercentiles: simDist },
  methodB: { dfMin: DF_MIN, dfMax: DF_MAX, candidateTerms: cand.length, tooRareTerms: tooRare, tooCommonTerms: [...df].filter(([, c]) => c > DF_MAX).length, topExcludedCommon: topExcluded, edgeRule: "co>=3 and Jaccard>=cut", assign: "unit joins topics hitting >=2 of its terms, top 2 (2nd needs >=half the 1st's hits); topics <2 units dropped" },
  randomBaseline: `${NRAND} seeded shuffles of unit->topic-set assignment, averaged`,
};
const strip = (v) => { const { topics, ...r } = v; return r; };
writeFileSync(join(OUT, "results.json"), JSON.stringify({ meta, variants: variants.map(strip) }, null, 1) + "\n");

const row = (v) => `| ${v.name} | ${v.nTopics} | ${v.unitsInNoTopic} | ${(v.giantShareOfAllUnits * 100).toFixed(1)}% (${v.giantSize}) | ${v.pairAll.P}/${v.pairAll.R}/${v.pairAll.F1} | ${v.pairAllRandom.P}/${v.pairAllRandom.R}/${v.pairAllRandom.F1} | ${v.pairSure.P}/${v.pairSure.R}/${v.pairSure.F1} | ${v.pairSureRandom.P}/${v.pairSureRandom.R}/${v.pairSureRandom.F1} | ${v.overlap.bothRate} (${v.overlap.both}/${v.overlap.n}) vs ${v.overlap.randomBothRate} | ${v.primaryHitRate} vs ${v.primaryHitRandom} | ${v.sizeCorr.spearmanUnitBytesVsTopicSize}/${v.sizeCorr.spearmanUnitBytesVsInGiant} |`;
let rep = `# tinymem round 5 — topics built from the docs\n\n## Units\n${JSON.stringify(meta, null, 1)}\n\n## Scores (P/R/F1 = "share a topic" vs "same labelled page"; random = seeded shuffle, same size distribution)\n\n| variant | topics | no topic | giant | pair all P/R/F1 | random | pair sure P/R/F1 | random | overlap both-pages vs random | primary-page hit vs random | size corr (topic size / giant) |\n|---|---|---|---|---|---|---|---|---|---|---|\n${variants.map(row).join("\n")}\n\n## Size distributions\n${variants.map((v) => `- ${v.name}: ${JSON.stringify(v.sizeDist)}`).join("\n")}\n`;
writeFileSync(join(OUT, "report.md"), rep);

let tm = "# Topics (15 largest per variant; examples = H2 heading + doc filename only)\n";
for (const v of variants) {
  tm += `\n## ${v.name}\n`;
  v.topics.slice(0, 15).forEach((t, k) => {
    tm += `\n### ${k + 1}. [${t.name.join(", ")}] — ${t.units.length} units\n`;
    if (t.terms) { const broad = t.terms.slice(0, 2), narrow = t.terms.slice(2, 12); tm += `broad: ${broad.join(", ")} | narrower: ${narrow.join(", ")}\n`; }
    for (const i of pickExamples(t.units)) tm += `- ${uLabel(i)}\n`;
  });
}
writeFileSync(join(OUT, "topics.md"), tm);
console.log("units", N, "variants", variants.length);
