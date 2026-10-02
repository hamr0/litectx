// THROWAWAY POC — tinymem module 0, round 6: ENTITY INDEX (term -> H2 sections), no model. Docs only.
// Does a labelled piece's entity set connect it to its labelled page's sections, and is that better than BM25-by-windows?
// Units = 848 filtered doc H2 units (round 5b exclusion: buckets archive/other dropped; NO near-dup collapse here).
// Deterministic, no deps. Writes ONLY out/stage6/{results.json,report.md,topics-sample.md}.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = process.env.TINYMEM_PROBE_DIR || join(homedir(), ".cache", "tinymem-probe");
const S1 = join(ROOT, "out", "stage1"), S2 = join(ROOT, "out", "stage2"), OUT = join(ROOT, "out", "stage6");
mkdirSync(OUT, { recursive: true });
const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const r4 = (x) => Math.round(x * 10000) / 10000;

// ---------- units (same order + filter as round 5b, without the dedupe) ----------
const all = readJsonl(join(S1, "pieces-docs.jsonl")).sort((a, b) => cmp(a.path, b.path) || a.startLine - b.startLine || cmp(a.id, b.id));
const units = all.filter((u) => u.bucket !== "archive" && u.bucket !== "other");
const N = units.length;
const uidx = new Map(units.map((u, i) => [u.id, i]));
const pages = JSON.parse(readFileSync(join(S1, "pages.json"), "utf8")).sort((a, b) => cmp(a.path, b.path)).map((p, i) => ({ ...p, pid: "P" + String(i + 1).padStart(2, "0") }));
const pidOfPath = new Map(pages.map((p) => [p.path, p.pid]));
const unitPage = units.map((u) => pidOfPath.get(u.path) || null);   // only product docs belong to a page (logs/wiki: null)

// ---------- tokeniser (round 5, verbatim) ----------
const STOP = new Set(`a about above after again against all also am an and any are aren as at be because been before being below between both but by can cannot could did do does doing don down during each few for from further had has have having he her here hers him his how i if in into is isn it its itself just let me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours yet via per etc ie eg vs also may might must shall one two three first second new use used using like get got set see via within without across whether since still both either neither`.split(/\s+/));
const HEX = /^[0-9a-f]{7,}$/;
function tokenize(text) {
  const out = [];
  const raws = text.toLowerCase().match(/[a-z0-9_]+(?:[.\-][a-z0-9_]+)*/g) || [];
  const add = (t) => { if (t.length < 3 || t.length > 40) return; if (!/[a-z]/.test(t)) return; if (HEX.test(t) && /\d/.test(t)) return; if (STOP.has(t)) return; out.push(t); };
  for (const raw of raws) { add(raw); if (/[.\-_]/.test(raw)) for (const part of raw.split(/[.\-_]+/)) add(part); }
  return out;
}

// ---------- literal keys (bake-off extractKeys, verbatim) ----------
const EXT = "js|mjs|cjs|ts|json|md|py|sh|yml|yaml";
function extractKeys(text) {
  const t = String(text), keys = new Set();
  const add = (m) => { for (const x of m) keys.add(x.toLowerCase()); };
  add(t.match(/(?:[\w.@~-]+\/)+[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,5}(?![\w])/g) || []);
  add(t.match(new RegExp(`(?<![\\w/.@-])[\\w-]+(?:\\.[\\w-]+)*\\.(?:${EXT})(?![\\w])`, "g")) || []);
  for (const m of t.matchAll(/`([^`\n]{3,60})`/g)) keys.add(m[1].toLowerCase());
  add(t.match(/(?<![A-Za-z0-9])[A-Z]{1,3}-?\d+(?![A-Za-z0-9])/g) || []);
  add(t.match(/(?<![A-Za-z0-9_-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![A-Za-z0-9_-])/g) || []);
  return keys;
}

// ---------- entities ----------
const MIN_FILES = 2, MAX_UNIT_FRAC = 0.03, MAX_UNITS = Math.floor(MAX_UNIT_FRAC * N);
const litSets = units.map((u) => extractKeys(u.text));
const tokSets = units.map((u) => new Set(tokenize(u.text)));
const tokFiles = new Map(), tokUnits = new Map();
tokSets.forEach((s, i) => { for (const w of s) { tokUnits.set(w, (tokUnits.get(w) || 0) + 1); if (!tokFiles.has(w)) tokFiles.set(w, new Set()); tokFiles.get(w).add(units[i].path); } });
const recurring = new Set([...tokUnits].filter(([w, n]) => tokFiles.get(w).size >= MIN_FILES && n <= MAX_UNITS).map(([w]) => w));
const recSets = tokSets.map((s) => new Set([...s].filter((w) => recurring.has(w))));
// namespace the kinds so a literal and a token with the same string stay distinct entities in "combined"
const entSets = {
  literal: litSets.map((s) => new Set([...s].map((k) => "L:" + k))),
  recurring: recSets.map((s) => new Set([...s].map((k) => "R:" + k))),
};
entSets.combined = entSets.literal.map((s, i) => new Set([...s, ...entSets.recurring[i]]));

function buildIndex(sets) {
  const ix = new Map();
  sets.forEach((s, i) => { for (const e of s) { if (!ix.has(e)) ix.set(e, []); ix.get(e).push(i); } });
  return ix;
}
const index = Object.fromEntries(Object.entries(entSets).map(([k, s]) => [k, buildIndex(s)]));
const idfOf = (ix, e) => Math.log(N / ix.get(e).length);
const entStats = (ix, sets) => ({
  entities: ix.size, entitiesGe2Units: [...ix.values()].filter((v) => v.length >= 2).length,
  unitsWithNoEntity: sets.filter((s) => s.size === 0).length,
  top20: [...ix].sort((a, b) => b[1].length - a[1].length || cmp(a[0], b[0])).slice(0, 20).map(([e, v]) => [e, v.length]),
});

// ---------- labels ----------
const labels = [];
for (const h of ["tune", "held"]) for (const l of readJsonl(join(S2, `labels-structured-${h}.jsonl`))) {
  if (!uidx.has(l.id)) throw new Error("labelled piece not in units: " + l.id);
  labels.push({ ...l, half: h, ui: uidx.get(l.id) });
}

// ---------- scoring ----------
// For piece with entity set E (own unit excluded): page score = sum over e in E of idf(e) for each page having >=1 OTHER unit containing e.
function score(ix, E, own) {
  const ps = new Map(); let reachedUnits = 0; const seen = new Set();
  for (const e of E) {
    const us = ix.get(e); if (!us) continue; const w = idfOf(ix, e);
    const pgs = new Set();
    for (const u of us) { if (u === own) continue; if (!seen.has(u)) { seen.add(u); } if (unitPage[u]) pgs.add(unitPage[u]); }
    for (const p of pgs) ps.set(p, (ps.get(p) || 0) + w);
  }
  const ranked = [...ps].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
  return { ranked, reachedUnits: seen.size };
}
const right = (p, l) => p === l.page || p === l.second;

function evalSet(kind, getE, subset) {
  const ix = index[kind];
  const withPage = subset.filter((l) => l.page !== "none"), none = subset.filter((l) => l.page === "none");
  let reach = 0, first = 0, top5 = 0, noEnt = 0, topicSz = 0, topicN = 0;
  const topNone = [], topPaged = [];
  for (const l of subset) {
    const E = getE(l); if (E.size === 0) noEnt++;
    const { ranked, reachedUnits } = score(ix, E, l.ui);
    topicSz += reachedUnits; topicN++;
    const top = ranked.length ? ranked[0][1] : 0;
    if (l.page === "none") topNone.push(top); else {
      topPaged.push(top);
      if (ranked.some(([p]) => right(p, l))) reach++;
      if (ranked.length && right(ranked[0][0], l)) first++;
      if (ranked.slice(0, 5).some(([p]) => right(p, l))) top5++;
    }
  }
  const frac = (arr, t) => arr.filter((x) => x <= t).length;
  return { pieces: subset.length, withPage: withPage.length, none: none.length, reach, first, top5, noEntity: noEnt, meanUnitsReached: topicSz / topicN,
    noneAnyPage: topNone.filter((x) => x > 0).length, noneTopLe: { "0": frac(topNone, 0), "3": frac(topNone, 3), "6": frac(topNone, 6) }, pagedTopLe: { "0": frac(topPaged, 0), "3": frac(topPaged, 3), "6": frac(topPaged, 6) } };
}

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const REPS = 20;
const vocab = Object.fromEntries(Object.entries(index).map(([k, ix]) => [k, [...ix.keys()].sort()]));
function randomEval(kind, subset) {
  const sums = null; const acc = { reach: 0, first: 0, top5: 0, noneAnyPage: 0, meanUnitsReached: 0 };
  for (let rep = 0; rep < REPS; rep++) {
    const R = rng(1000 + rep), draws = new Map();
    for (const l of subset) { const n = entSets[kind][l.ui].size, s = new Set(), v = vocab[kind]; while (s.size < Math.min(n, v.length)) s.add(v[Math.floor(R() * v.length)]); draws.set(l.id, s); }
    const r = evalSet(kind, (l) => draws.get(l.id), subset);
    for (const k of Object.keys(acc)) acc[k] += r[k] / REPS;
  }
  for (const k of Object.keys(acc)) acc[k] = Math.round(acc[k] * 100) / 100;
  return acc;
}

const halves = { tune: labels.filter((l) => l.half === "tune"), held: labels.filter((l) => l.half === "held") };
const results = { seed: "tinymem-stage6-v1", cuts: { minDocFiles: MIN_FILES, maxUnitFrac: MAX_UNIT_FRAC, maxUnits: MAX_UNITS, literalCut: "none (idf weighting only)", randomReps: REPS }, units: N, recurringTokens: recurring.size, entities: {}, scores: {}, random: {} };
for (const k of Object.keys(index)) results.entities[k] = entStats(index[k], entSets[k]);
for (const k of Object.keys(index)) { results.scores[k] = {}; results.random[k] = {}; for (const [h, sub] of Object.entries(halves)) { results.scores[k][h] = evalSet(k, (l) => entSets[k][l.ui], sub); results.random[k][h] = randomEval(k, sub); } }
results.bm25WindowsRound3 = { held: { pieces: 100, withPage: 74, first: 39, top5: 64 }, tune: "not in stage3/results.json (round 3 scored held only; tune used for thresholds)" };

// ---------- eyeball ----------
const eye = ["softgreen", "clipipe", "bundle", "hitl", "spawner"];
let topics = "# round 6 — entity topic samples (file > heading only)\n\n";
for (const w of eye) for (const kind of ["recurring", "literal"]) {
  const e = (kind === "recurring" ? "R:" : "L:") + w; const us = index[kind].get(e);
  topics += `## ${e}\n`;
  if (!us) { topics += "(not an entity under this kind)\n"; const n = tokUnits.get(w); if (kind === "recurring" && n) topics += `(token exists: ${n} units in ${tokFiles.get(w).size} files — cut out: ${tokFiles.get(w).size < MIN_FILES ? "<2 files" : ">" + MAX_UNITS + " units"})\n`; topics += "\n"; continue; }
  topics += `${us.length} units\n` + us.map((u) => `- ${units[u].path.split("/").slice(-2).join("/")} > ${units[u].heading}`).join("\n") + "\n\n";
  results.entities[kind].eyeball ||= {}; results.entities[kind].eyeball[w] = us.length;
}
writeFileSync(join(OUT, "topics-sample.md"), topics);

// ---------- report ----------
const row = (k, h) => { const s = results.scores[k][h], r = results.random[k][h]; return `| ${k} | ${h} | ${s.first}/${s.withPage} | ${s.top5}/${s.withPage} | ${s.reach}/${s.withPage} | ${r.first}/${r.top5}/${r.reach} | ${s.meanUnitsReached.toFixed(1)} (rand ${r.meanUnitsReached}) | ${s.noneAnyPage}/${s.none} (rand ${r.noneAnyPage}) | ${s.noEntity} |`; };
let rep = `# tinymem round 6 — entity index\n\nUnits ${N}; recurring tokens ${recurring.size} (>=${MIN_FILES} doc files, <=${MAX_UNITS} units = floor(3% x ${N})); literal keys uncut.\n\n## Entities\n${Object.entries(results.entities).map(([k, v]) => `- ${k}: ${v.entities} entities (${v.entitiesGe2Units} in >=2 units), ${v.unitsWithNoEntity} units with none. top20: ${v.top20.map((x) => x.join("=")).join(", ")}`).join("\n")}\n\n## Scores (pieces with a page)\n| entities | half | first | top5 | reach | random first/top5/reach (mean of ${REPS}) | mean units reached/piece | none-pieces reaching any page | pieces w/ no entity |\n|---|---|---|---|---|---|---|---|---|\n${["literal", "recurring", "combined"].flatMap((k) => ["tune", "held"].map((h) => row(k, h))).join("\n")}\n\nBM25/windows round 3 held: first 39/74, top5 64/74. Tune: ${results.bm25WindowsRound3.tune}\n\n## None handling: top score <= t (none-labelled vs paged pieces)\n${["literal", "recurring", "combined"].flatMap((k) => ["tune", "held"].map((h) => { const s = results.scores[k][h]; return `- ${k}/${h}: none n=${s.none} top<=0/3/6: ${s.noneTopLe[0]}/${s.noneTopLe[3]}/${s.noneTopLe[6]}; paged n=${s.withPage} top<=0/3/6: ${s.pagedTopLe[0]}/${s.pagedTopLe[3]}/${s.pagedTopLe[6]}`; })).join("\n")}\n`;
writeFileSync(join(OUT, "report.md"), rep);
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1) + "\n");
console.log(rep);
