// THROWAWAY POC — tinymem round 7a: topic words by CONCENTRATION (density lift) per doc file. No model, deterministic.
// UPDATE (owner): PRIMARY words(d) = CONTENT raw tokens only (stopwords removed; raw tokens, not split parts); words incl. stopwords kept as SECONDARY (wordsAll).
// Unit = whole doc file (units of out/stage1/pieces-docs.jsonl grouped by path; buckets archive+other dropped, as round 5b; the 5b
// near-duplicate collapse is unit-level and NOT applied here). words(d) = ALL raw word tokens ([a-z0-9_]+(?:[.-]..)*) incl. stopwords.
// term counts use round 5's tokenizer (stopwords/short/numbers/hashes out; intact hyphen/dot tokens AND their parts counted).
// primary = mean of top-k doc densities (zero-padded to k) / corpus density p(t), for terms with total count >= N.
// alt = KL (bits) of the term's count-share across docs vs the docs' word-share: sum_d q_d*log2(q_d/w_d).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const ROOT = process.env.TINYMEM_PROBE_DIR || join(homedir(), ".cache", "tinymem-probe");
const OUT = join(ROOT, "out", "stage7a"); mkdirSync(OUT, { recursive: true });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const rd = (x, n = 4) => Math.round(x * 10 ** n) / 10 ** n;
const units = readFileSync(join(ROOT, "out/stage1/pieces-docs.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  .filter((u) => u.bucket !== "archive" && u.bucket !== "other").sort((a, b) => cmp(a.path, b.path) || a.startLine - b.startLine || cmp(a.id, b.id));
const STOP = new Set(`a about above after again against all also am an and any are aren as at be because been before being below between both but by can cannot could did do does doing don down during each few for from further had has have having he her here hers him his how i if in into is isn it its itself just let me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours yet via per etc ie eg vs also may might must shall one two three first second new use used using like get got set see via within without across whether since still both either neither`.split(/\s+/));
const HEX = /^[0-9a-f]{7,}$/;
const RAW = /[a-z0-9_]+(?:[.\-][a-z0-9_]+)*/g;
function tokenize(text) {
  const out = [], raws = text.toLowerCase().match(RAW) || [];
  const add = (t) => { if (t.length < 3 || t.length > 40) return; if (!/[a-z]/.test(t)) return; if (HEX.test(t) && /\d/.test(t)) return; if (STOP.has(t)) return; out.push(t); };
  for (const raw of raws) { add(raw); if (/[.\-_]/.test(raw)) for (const p of raw.split(/[.\-_]+/)) add(p); }
  return out;
}
const byPath = new Map(); for (const u of units) { if (!byPath.has(u.path)) byPath.set(u.path, []); byPath.get(u.path).push(u.text); }
const docs = [...byPath.keys()].sort().map((p) => { const t = byPath.get(p).join("\n"); return { path: p, words: (t.toLowerCase().match(RAW) || []).filter((w) => !STOP.has(w)).length, wordsAll: (t.toLowerCase().match(RAW) || []).length, tf: (() => { const m = new Map(); for (const w of tokenize(t)) m.set(w, (m.get(w) || 0) + 1); return m; })() }; });
const W = docs.reduce((s, d) => s + d.words, 0), WA = docs.reduce((s, d) => s + d.wordsAll, 0);
const total = new Map(), per = new Map();
docs.forEach((d, i) => { for (const [w, c] of d.tf) { total.set(w, (total.get(w) || 0) + c); if (!per.has(w)) per.set(w, []); per.get(w).push([i, c]); } });
const CHECK = ["softgreen", "soft-green", "clipipe", "bundle", "spawner", "hitl"];
const GLUE = ["run", "read", "close", "never", "every", "job", "green", "nothing", "bought", "come", "genuine", "criteria"];
function score(N, k, all = false) {
  const wd = (i) => (all ? docs[i].wordsAll : docs[i].words), WW = all ? WA : W;
  const rows = [];
  for (const [t, tot] of [...total].sort((a, b) => cmp(a[0], b[0]))) {
    if (tot < N) continue;
    const p = tot / WW, ds = per.get(t).map(([i, c]) => ({ i, c, d: c / wd(i) })).sort((a, b) => b.d - a.d || cmp(docs[a.i].path, docs[b.i].path));
    let s = 0; for (let j = 0; j < k; j++) s += ds[j] ? ds[j].d : 0;
    let kl = 0; for (const x of ds) { const q = x.c / tot, w = wd(x.i) / WW; kl += q * Math.log2(q / w); }
    rows.push({ term: t, score: s / k / p, kl, count: tot, docs: ds.length, top: ds.slice(0, 5).map((x) => ({ doc: docs[x.i].path.replace(/^docs\//, ""), densityPct: rd(x.d * 100, 3), count: x.c })) });
  }
  rows.sort((a, b) => b.score - a.score || cmp(a.term, b.term)); rows.forEach((r, i) => { r.rank = i + 1; });
  const byKl = [...rows].sort((a, b) => b.kl - a.kl || cmp(a.term, b.term)); byKl.forEach((r, i) => { r.klRank = i + 1; });
  return rows;
}
const look = (rows, terms) => terms.map((t) => { const r = rows.find((x) => x.term === t); return r ? { term: t, rank: r.rank, of: rows.length, pct: rd(r.rank / rows.length * 100, 2), score: rd(r.score, 1), klRank: r.klRank, count: r.count, docs: r.docs } : { term: t, rank: null, of: rows.length, note: total.has(t) ? `count ${total.get(t)} < N` : "absent" }; });
const sep = (rows) => { const c = look(rows, CHECK).filter((x) => x.rank), g = look(rows, GLUE).filter((x) => x.rank);
  return { worstCheck: Math.max(...c.map((x) => x.rank)), bestGlue: Math.min(...g.map((x) => x.rank)), missingCheck: look(rows, CHECK).filter((x) => !x.rank).map((x) => x.term), separated: Math.max(...c.map((x) => x.rank)) < Math.min(...g.map((x) => x.rank)), checkMedianPct: rd(c.map((x) => x.rank).sort((a, b) => a - b)[Math.floor(c.length / 2)] / rows.length * 100, 2), glueMedianPct: rd(g.map((x) => x.rank).sort((a, b) => a - b)[Math.floor(g.length / 2)] / rows.length * 100, 2) }; };
const main = score(5, 3), mainAll = score(5, 3, true);
const sens = [], sensAll = []; for (const N of [3, 5, 10]) for (const k of [1, 3, 5]) { const r = score(N, k); sens.push({ N, k, eligible: r.length, ...sep(r) }); const a = score(N, k, true); sensAll.push({ N, k, eligible: a.length, ...sep(a) }); }
const results = { meta: { docs: docs.length, totalContentWords: W, totalWordsInclStop: WA, uniqueTerms: total.size, primary: { N: 5, k: 3 } }, top50: main.slice(0, 50).map(({ term, score, count, docs, top, klRank }) => ({ term, score: rd(score, 1), count, docs, klRank, top: top.slice(0, 3) })),
  check: look(main, CHECK), glue: look(main, GLUE), secondaryInclStop: { check: look(mainAll, CHECK), glue: look(mainAll, GLUE), separation: sep(mainAll), sensitivity: sensAll }, separation: sep(main),
  checkTopDocs: Object.fromEntries(CHECK.map((t) => [t, (main.find((x) => x.term === t) || { top: [] }).top])), sensitivity: sens,
  klTop20: [...main].sort((a, b) => a.klRank - b.klRank).slice(0, 20).map((r) => r.term) };
writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1) + "\n");
const T = (rows, hdr, f) => `| ${hdr.join(" | ")} |\n|${hdr.map(() => "---").join("|")}|\n${rows.map((r) => "| " + f(r).join(" | ") + " |").join("\n")}\n`;
let md = `# tinymem round 7a — concentration (density lift)\n\nDocs ${docs.length} (archive+other buckets dropped; no dedupe), content words ${W} (PRIMARY denominator: raw tokens minus stopwords; incl.-stopwords total ${WA} is the secondary column). Primary: mean of top-3 doc densities / corpus density, count >= 5 (${main.length} eligible terms). Check terms were chosen by the orchestrator from earlier rounds: sanity check, NOT an unbiased test.\n\n## Top 50\n` +
  T(results.top50, ["#", "term", "score", "count", "docs", "KL rank", "top doc (density%)"], (r) => [results.top50.indexOf(r) + 1, r.term, r.score, r.count, r.docs, r.klRank, `${r.top[0].doc} (${r.top[0].densityPct}%)`]) +
  `\n## Check vs glue terms\n` + T([...results.check.map((x) => ({ ...x, g: "CHECK" })), ...results.glue.map((x) => ({ ...x, g: "glue" }))], ["grp", "term", "rank", "of", "pct", "score", "KL rank", "count", "docs", "rank incl-stop denom"], (x) => [x.g, x.term, x.rank ?? "-", x.of, x.pct ?? x.note, x.score ?? "-", x.klRank ?? "-", x.count ?? "-", x.docs ?? "-", (results.secondaryInclStop.check.concat(results.secondaryInclStop.glue).find((y) => y.term === x.term) || {}).rank ?? "-"]) +
  `\nSeparation: ${JSON.stringify(results.separation)}\n\n## Top 5 docs by density per check term\n` + CHECK.map((t) => `- **${t}**: ` + results.checkTopDocs[t].map((d) => `${d.doc} (${d.densityPct}%)`).join("; ")).join("\n") +
  `\n\n## Sensitivity\n` + T(sens, ["N", "k", "eligible", "worst check rank", "best glue rank", "separated", "check median pct", "glue median pct", "missing check"], (s) => [s.N, s.k, s.eligible, s.worstCheck, s.bestGlue, s.separated, s.checkMedianPct, s.glueMedianPct, s.missingCheck.join(",") || "-"]) + "\n### Secondary (incl-stopword denominator) sensitivity\n" + T(sensAll, ["N", "k", "worst check rank", "best glue rank", "separated", "check median pct", "glue median pct"], (s) => [s.N, s.k, s.worstCheck, s.bestGlue, s.separated, s.checkMedianPct, s.glueMedianPct]) + `\nKL top 20: ${results.klTop20.join(", ")}\n`;
writeFileSync(join(OUT, "report.md"), md);
console.log("ok", docs.length, main.length);
