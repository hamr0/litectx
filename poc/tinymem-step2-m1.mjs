// tinymem step-2 M1: offline (no model) all-related-chunk coverage of litectx recall on the frozen step-2 question set.
// For each question: is every gold source range (the question's `sources`) covered by a recall hit, and at what rank?
//   found     = a hit with the same path whose 1-based line range overlaps the source range
//   span view = per file with >=2 hits in the list, the span min..max of hit lines; a source also counts as covered when fully inside a span
//   rank r    = smallest list prefix length at which the source is covered (so rank in the span view is the position that completes the span)
// Query variants (all mechanical):
//   Q1  = question text verbatim
//   Q2  = sub-questions: split on "?" and ";" then on ", and " / " and " ONLY when followed by an interrogative/aux word
//         (what|which|how|why|who|where|when|does|did|is|are|was|were|do|can|will|would|should|has|have|may); pieces < 3 words are dropped;
//         if <2 pieces remain Q2 == Q1. Each piece is recalled with the same n; lists merged by best rank (ties: earlier piece first),
//         de-duplicated by path+lines, then truncated to n (same hit budget as Q1).
//   Q2u = same merge, NOT truncated (up to pieces x n hits; costs more reading budget).
// Recall call = the one the step-1 agent used: ctx.recall(q, {kind:"doc", n}) with embeddings ON (litectx CLI default), no log.
// usage: node poc/tinymem-step2-m1.mjs
import { LiteCtx } from "../src/index.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const O = join(homedir(), ".cache/tinymem-probe/out"), OUT = join(O, "step2/m1");
const NS = [5, 8, 10, 20], AGENT_N = 8;
const REPOS = ["bareloop", "bareagent"];
const INDEXES = { docs: (r) => join(O, "step2", `${r}-docs/lroot`), mixed: (r) => join(O, "answer", r, "lroot") };
// manual labelling of UNAMBIGUOUS superseded pairs (indices into q.sources); other superseded questions' sources each describe both states
const NEWEST = {
  "bareloop-m13": { newest: [1, 2], older: [0] }, "bareloop-m14": { newest: [1], older: [0] }, "bareloop-m15": { newest: [2], older: [1] },
  "bareagent-m12": { newest: [2], older: [0, 1] }, "bareagent-m15": { newest: [0, 2, 3], older: [1] },
};

const INTERROG = "what|which|how|why|who|where|when|does|did|is|are|was|were|do|can|will|would|should|has|have|may";
export function subQuestions(q) {
  const pieces = q.split(/[?;]/).flatMap((p) => p.split(new RegExp(`,?\\s+and\\s+(?=(?:${INTERROG})\\b)`, "i"))).map((s) => s.replace(/^[\s,]+|[\s,]+$/g, "")).filter((s) => s.split(/\s+/).length >= 3);
  return pieces.length >= 2 ? pieces : [q];
}
const parseSrc = (s) => { const m = /^(.+):(\d+)-(\d+)$/.exec(s); return { path: m[1], a: +m[2], b: +m[3] }; };
const ov = (a1, b1, a2, b2) => a1 <= b2 && a2 <= b1;
const toHits = (res) => res.map((h) => (h.chunk ? { path: h.path, a: h.chunk.startLine + 1, b: h.chunk.endLine + 1 } : { path: h.path, a: 1, b: Infinity, whole: true }));
const key = (h) => `${h.path}:${h.a}-${h.b}`;

function merge(lists, cap) {
  const best = new Map();
  lists.forEach((l, pi) => l.forEach((h, r) => { const k = key(h), c = best.get(k); if (!c || r < c.r || (r === c.r && pi < c.pi)) best.set(k, { h, r, pi }); }));
  const m = [...best.values()].sort((x, y) => x.r - y.r || x.pi - y.pi).map((x) => x.h);
  return cap ? m.slice(0, cap) : m;
}
// rank (1-based) at which each source is first covered, direct and with spans; Infinity = never
function ranks(hits, srcs) {
  const direct = srcs.map(() => Infinity), span = srcs.map(() => Infinity);
  for (let m = 1; m <= hits.length; m++) {
    const pre = hits.slice(0, m), last = pre[m - 1], byFile = {};
    for (const h of pre) (byFile[h.path] ??= []).push(h);
    srcs.forEach((s, i) => {
      if (direct[i] === Infinity && ov(last.a, last.b, s.a, s.b) && last.path === s.path) direct[i] = m;
      if (span[i] === Infinity) {
        if (last.path === s.path && ov(last.a, last.b, s.a, s.b)) span[i] = m;
        else { const f = byFile[s.path]; if (f && f.length >= 2) { const lo = Math.min(...f.map((x) => x.a)), hi = Math.max(...f.map((x) => x.b)); if (lo <= s.a && s.b <= hi) span[i] = m; } }
      }
    });
  }
  return { direct, span };
}

const Q = REPOS.flatMap((repo) => JSON.parse(readFileSync(join(O, "step2/questions", repo + ".json"), "utf8")).map((q) => ({ ...q, repo, slice: /^slice:(\w+)/.exec(q.notes)[1], srcs: q.sources.map(parseSrc) })));
const rows = [], indexInfo = {};
for (const [iname, rootOf] of Object.entries(INDEXES)) for (const repo of REPOS) {
  const ctx = new LiteCtx({ root: rootOf(repo), embeddings: true });
  indexInfo[`${iname}/${repo}`] = { root: rootOf(repo), size: ctx.size() };
  const cache = new Map();
  const run = async (text, n) => { const k = n + "|" + text; if (!cache.has(k)) cache.set(k, toHits(await ctx.recall(text, { kind: "doc", n, log: false }))); return cache.get(k); };
  for (const q of Q.filter((x) => x.repo === repo)) {
    const subs = subQuestions(q.question);
    for (const n of NS) {
      const q1 = await run(q.question, n);
      const lists = await Promise.all(subs.map((s) => run(s, n)));
      const variants = { Q1: q1, Q2: merge(lists, n), Q2u: merge(lists) };
      for (const [vname, hits] of Object.entries(variants)) {
        const { direct, span } = ranks(hits, q.srcs);
        rows.push({ index: iname, repo, id: q.id, slice: q.slice, variant: vname, n, nsub: subs.length, nhits: hits.length, wholeFileHits: hits.filter((h) => h.whole).length, direct, span });
      }
    }
  }
  ctx.close();
}

// ---------- aggregate ----------
const fin = (x) => Number.isFinite(x);
const pct = (a) => (a.length ? (100 * a.filter(Boolean).length / a.length).toFixed(0) : "-");
const mean = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "-");
const metrics = (rs, view, n) => {
  const cov = (r) => r[view].map((x) => x <= n);
  const all = rs.map((r) => cov(r).every(Boolean)), any = rs.map((r) => cov(r).some(Boolean));
  const firsts = rs.map((r) => Math.min(...r[view])).filter(fin), lasts = rs.map((r) => Math.max(...r[view])).filter(fin);
  return { all: pct(all), any: pct(any), first: mean(firsts), last: mean(lasts), nLast: `${lasts.length}/${rs.length}` };
};
const lines = [];
const P = (s = "") => lines.push(s);
P("# tinymem step-2 M1: offline all-related-chunk coverage");
P(`Questions: ${Q.length} (bareloop ${Q.filter((q) => q.repo === "bareloop").length}, bareagent ${Q.filter((q) => q.repo === "bareagent").length}). Step-1 D used \`recall --kind doc -n 8\` (a few -n 10). Variants Q1 verbatim / Q2 sub-questions merged to n / Q2u merged untruncated. See script header for exact rules.`);
P("Index: " + Object.entries(indexInfo).map(([k, v]) => `${k}=${v.size} units`).join(", "));
P(readFileSync(join(OUT, "index-times.md"), "utf8").trim());
P();
P("Cell = all-sources-found % / any-source-found %. `last` = mean rank of the last gold source (only questions where all were found at n=20; count in brackets). `first` = mean rank of the earliest-found source.");
const groups = (rs) => ({ all: rs, ...Object.fromEntries(["single", "neighbour", "superseded"].map((s) => [s, rs.filter((r) => r.slice === s)])) });
for (const view of ["direct", "span"]) for (const iname of Object.keys(INDEXES)) {
  P(); P(`## ${iname} index, ${view} view`);
  P("| repo | slice | variant | " + NS.map((n) => `n=${n}${n === AGENT_N ? "*" : ""}`).join(" | ") + " | first@20 | last@20 |");
  P("|---|---|---|" + NS.map(() => "---").join("|") + "|---|---|");
  for (const repo of [...REPOS, "both"]) {
    const base = rows.filter((r) => r.index === iname && (repo === "both" || r.repo === repo));
    for (const [slice, _] of Object.entries(groups(base))) for (const v of ["Q1", "Q2", "Q2u"]) {
      const cells = NS.map((n) => { const rs = base.filter((r) => r.n === n && r.variant === v && (slice === "all" || r.slice === slice)); const m = metrics(rs, view, n); return `${m.all}/${m.any}`; });
      const rs20 = base.filter((r) => r.n === 20 && r.variant === v && (slice === "all" || r.slice === slice)), m20 = metrics(rs20, view, 20);
      P(`| ${repo} | ${slice} | ${v} | ${cells.join(" | ")} | ${m20.first} | ${m20.last} (${m20.nLast}) |`);
    }
  }
}
// superseded newest-vs-older
P(); P("## Superseded pairs (docs index, direct view, Q1, n=20; manual newest/older labels for unambiguous pairs only)");
P("| id | newest found | older found | newest rank | older rank | newest above older |"); P("|---|---|---|---|---|---|");
const sup = [];
for (const [id, lab] of Object.entries(NEWEST)) for (const iname of Object.keys(INDEXES)) {
  const r = rows.find((x) => x.index === iname && x.id === id && x.variant === "Q1" && x.n === 20);
  const nr = Math.min(...lab.newest.map((i) => r.direct[i])), or = Math.min(...lab.older.map((i) => r.direct[i]));
  sup.push({ id, index: iname, newestRank: nr, olderRank: or, newestFound: fin(nr), olderFound: fin(or), above: nr < or });
  if (iname === "docs") P(`| ${id} | ${fin(nr)} | ${fin(or)} | ${fin(nr) ? nr : "miss"} | ${fin(or) ? or : "miss"} | ${nr < or} |`);
}
const nf = sup.filter((s) => s.index === "docs"); P(`Newest found: ${nf.filter((s) => s.newestFound).length}/${nf.length}; newest strictly above older: ${nf.filter((s) => s.above).length}/${nf.length} (miss counts as below).`);
// worst questions: docs index, Q1, direct, n=8, by missing sources then by last rank
P(); P("## Worst questions (docs index, Q1, n=8 direct view; rank = position in recall list, miss = not in top 20 either)");
const r20 = (id, iname, v) => rows.find((x) => x.index === iname && x.id === id && x.variant === v && x.n === 20);
const worst = rows.filter((r) => r.index === "docs" && r.variant === "Q1" && r.n === 8).map((r) => ({ r, miss8: r.direct.filter((x) => x > 8).length, last: Math.max(...r20(r.id, "docs", "Q1").direct.map((x) => (fin(x) ? x : 99))) })).sort((a, b) => b.miss8 - a.miss8 || b.last - a.last).slice(0, 8);
for (const { r } of worst) {
  const q = Q.find((x) => x.id === r.id), r2 = r20(r.id, "docs", "Q1");
  P(`- ${r.id} [${q.slice}] nsub=${r.nsub}: ` + q.sources.map((s, i) => `${s} rank ${fin(r2.direct[i]) ? r2.direct[i] : "miss@20"}${fin(r2.span[i]) && !fin(r2.direct[i]) ? ` (span ${r2.span[i]})` : ""}`).join("; "));
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.md"), lines.join("\n") + "\n");
writeFileSync(join(OUT, "results.json"), JSON.stringify({ indexInfo, subQuestions: Object.fromEntries(Q.map((q) => [q.id, subQuestions(q.question)])), rows, superseded: sup }, (k, v) => (v === Infinity ? "inf" : v), 1));
console.log(lines.join("\n"));
