// tinymem step-4 M4: offline coverage at scale (1x docs-only vs ~21x/"big" docs-only). Q1 verbatim, recall kind=doc, n in 5/8/10/20.
// Logic (toHits/ranks/overlap) copied from tinymem-step2-m1.mjs. Plus padding share in top-8 and grep-noise baseline.
import { LiteCtx } from "../src/index.js";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
const O = join(homedir(), ".cache/tinymem-probe/out"), OUT = join(O, "step4/m4");
const NS = [5, 8, 10, 20], REPOS = ["bareloop", "bareagent"];
const SIZES = { "1x": (r) => join(O, "step2/root", r, "lroot"), big: (r) => join(O, "step4", r + "-big/lroot") };
const SETS = { step2: "step2/questions", step3: "step3/questions" };
const parseSrc = (s) => { const m = /^(.+):(\d+)-(\d+)$/.exec(s); return { path: m[1], a: +m[2], b: +m[3] }; };
const ov = (a1, b1, a2, b2) => a1 <= b2 && a2 <= b1;
const toHits = (res) => res.map((h) => (h.chunk ? { path: h.path, a: h.chunk.startLine + 1, b: h.chunk.endLine + 1 } : { path: h.path, a: 1, b: Infinity }));
const directRanks = (hits, srcs) => srcs.map((s) => { const i = hits.findIndex((h) => h.path === s.path && ov(h.a, h.b, s.a, s.b)); return i < 0 ? Infinity : i + 1; });
const Q = [];
for (const [set, dir] of Object.entries(SETS)) for (const repo of REPOS)
  for (const q of JSON.parse(readFileSync(join(O, dir, repo + ".json"), "utf8"))) Q.push({ ...q, set, repo, srcs: q.sources.map(parseSrc) });
const rows = [];
for (const [size, rootOf] of Object.entries(SIZES)) for (const repo of REPOS) {
  const ctx = new LiteCtx({ root: rootOf(repo), embeddings: true });
  for (const q of Q.filter((x) => x.repo === repo)) {
    const hits = toHits(await ctx.recall(q.question, { kind: "doc", n: 20, log: false }));
    // recall(n) top-n == prefix of n=20 only if ranking is n-independent; verify at n=8 once per question
    const h8 = toHits(await ctx.recall(q.question, { kind: "doc", n: 8, log: false }));
    const prefixOk = JSON.stringify(h8) === JSON.stringify(hits.slice(0, 8));
    const d = directRanks(hits, q.srcs);
    rows.push({ size, repo, set: q.set, id: q.id, direct: d, prefixOk, pad8: hits.slice(0, 8).filter((h) => h.path.startsWith("docs/ext/")).length, n8: Math.min(8, hits.length), top8: hits.slice(0, 8).map((h) => h.path) });
  }
  ctx.close();
}
const fin = Number.isFinite, mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
const cell = (rs, n) => ({ any: rs.filter((r) => r.direct.some((x) => x <= n)).length, all: rs.filter((r) => r.direct.every((x) => x <= n)).length, N: rs.length });
const summary = {};
for (const set of Object.keys(SETS)) for (const size of Object.keys(SIZES)) {
  const rs = rows.filter((r) => r.set === set && r.size === size);
  const firsts = rs.map((r) => Math.min(...r.direct));
  summary[`${set}/${size}`] = { N: rs.length, byN: Object.fromEntries(NS.map((n) => [n, cell(rs, n)])), meanFirstRank_found20: mean(firsts.filter(fin)), firstNotIn20: firsts.filter((x) => !fin(x)).length, padPerTop8: mean(rs.map((r) => r.pad8)), padShare8: mean(rs.map((r) => r.pad8 / r.n8)), prefixOkAll: rs.every((r) => r.prefixOk) };
}
const drops = {};
for (const set of Object.keys(SETS)) {
  const a = rows.filter((r) => r.set === set && r.size === "1x"), b = rows.filter((r) => r.set === set && r.size === "big");
  drops[set] = { firstGoldOutOfTop8: [], gained: [], firstRankShift: [] };
  for (const r of a) { const r2 = b.find((x) => x.id === r.id), f1 = Math.min(...r.direct), f2 = Math.min(...r2.direct);
    if (f1 <= 8 && !(f2 <= 8)) drops[set].firstGoldOutOfTop8.push({ id: r.id, f1, f2: fin(f2) ? f2 : "miss@20" });
    if (!(f1 <= 8) && f2 <= 8) drops[set].gained.push({ id: r.id, f1: fin(f1) ? f1 : "miss@20", f2 });
    drops[set].firstRankShift.push({ id: r.id, f1: fin(f1) ? f1 : null, f2: fin(f2) ? f2 : null }); }
}
// grep baseline: the 2 rarest content words from the step3 audit notes; count files containing each (case-insens, whole word) and union
const grepCount = (root, words, mode) => {
  const files = new Set();
  for (const w of words) { let out = ""; try { out = execFileSync("grep", ["-rliw", "--", w, root], { encoding: "utf8", maxBuffer: 1 << 28 }); } catch (e) { out = e.stdout || ""; } out.split("\n").filter(Boolean).forEach((f) => files.add(f)); }
  return files.size;
};
const grep = [];
for (const q of Q.filter((x) => x.set === "step3")) {
  const m = /2 rarest words (\[.*?\]);/.exec(q.notes); if (!m) continue;
  const words = [...m[1].matchAll(/\('([^']+)'/g)].map((x) => x[1]);
  const per = (size) => { const root = join(SIZES[size](q.repo), "docs"); return { each: words.map((w) => grepCount(root, [w])), union: grepCount(root, words) }; };
  grep.push({ id: q.id, words, "1x": per("1x"), big: per("big") });
}
writeFileSync(join(OUT, "results.json"), JSON.stringify({ summary, drops, grep, rows }, (k, v) => (v === Infinity ? "inf" : v), 1));
const L = [], P = (s = "") => L.push(s);
P("# tinymem step-4 M4: coverage at scale (docs-only; Q1 verbatim; direct-overlap view)");
P("Cell = any-source / all-sources found out of N. first = mean rank of first gold hit (found within 20 only).");
for (const set of Object.keys(SETS)) { P(); P(`## ${set}`); P("| size | N | @5 any/all | @8 any/all | @10 any/all | @20 any/all | first (miss@20) | pad hits/top8 | pad share |"); P("|---|---|---|---|---|---|---|---|---|");
  for (const size of Object.keys(SIZES)) { const s = summary[`${set}/${size}`]; P(`| ${size} | ${s.N} | ${NS.map((n) => `${s.byN[n].any}/${s.byN[n].all}`).join(" | ")} | ${s.meanFirstRank_found20} (${s.firstNotIn20}) | ${size === "big" ? s.padPerTop8 : "-"} | ${size === "big" ? (100 * s.padShare8).toFixed(0) + "%" : "-"} |`); }
  P(`First gold hit dropped out of top 8 at scale: ${drops[set].firstGoldOutOfTop8.length} ${JSON.stringify(drops[set].firstGoldOutOfTop8)}; gained into top 8: ${drops[set].gained.length}`); }
P(); P("## grep noise (step3, 2 rarest words per audit notes; files containing word, -w -i)"); P("| id | words | 1x each | 1x union | big each | big union |"); P("|---|---|---|---|---|---|");
for (const g of grep) P(`| ${g.id} | ${g.words.join(", ")} | ${g["1x"].each.join("/")} | ${g["1x"].union} | ${g.big.each.join("/")} | ${g.big.union} |`);
P(`Mean union 1x ${mean(grep.map((g) => g["1x"].union))} -> big ${mean(grep.map((g) => g.big.union))}`);
writeFileSync(join(OUT, "report.md"), L.join("\n") + "\n"); console.log(L.join("\n"));
