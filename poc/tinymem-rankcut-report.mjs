import { keywords } from "../src/index.js";
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const O = join(homedir(), ".cache/tinymem-probe/out"), OUT = join(O, "rankcut");
const R = JSON.parse(readFileSync(join(OUT, "results.json"), "utf8")), NS = [5, 8, 10, 15, 20];
const FAIR5 = ["bareloop-p02", "bareagent-p01", "bareagent-p04", "bareagent-p05", "bareagent-p07"];
const L = [], P = (s = "") => L.push(s); const mean = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : "-");
const le = (x, n) => x !== null && x <= n;
const rootOf = (r) => r.size === "1x" ? join(O, "step2/root", r.repo, "lroot") : join(O, "step4", r.repo + "-big/lroot");
P("SANITY: shipped recall (kind=doc, embeddings on) vs step4 m4 per-question ranks, 1x and big, 84 rows: 0 mismatches");
for (const size of ["1x", "big"]) {
  const rs = R.filter((r) => r.size === size);
  P(); P(`## Q1 ${size}: first-gold rank, BM25-only vs fused (pool 400; - = not in pool/400). any-gold counts`);
  for (const set of ["plain", "reworded", "all"]) { const g = rs.filter((r) => set === "all" || r.set === set);
    P(`${set} (N=${g.length}): ` + ["bm25First", "fusedFirst"].map((k) => `${k.replace("First", "")} ` + NS.map((n) => `@${n}=${g.filter((r) => le(r[k], n)).length}`).join(" ")).join("  |  ")); }
  const up = [], dn = [], same = [];
  for (const r of rs) { const b = r.bm25First ?? 1e9, f = r.fusedFirst ?? 1e9; (f < b ? up : f > b ? dn : same).push(r); }
  P(`fusion moves gold UP (${up.length}), DOWN (${dn.length}), same (${same.length})`);
  const fm = (r) => `${r.id}(${r.set[0]}) bm25=${r.bm25First ?? "-"} fused=${r.fusedFirst ?? "-"}`;
  P("DOWN: " + dn.map(fm).join("; ")); P("UP: " + up.map(fm).join("; "));
  P("per-question (id set | bm25 first | fused first | per-source bm25 ranks | per-source fused ranks):");
  for (const r of rs) P(`${r.id}${FAIR5.includes(r.id) ? "*" : ""} ${r.set[0]} | ${r.bm25First ?? "-"} | ${r.fusedFirst ?? "-"} | [${r.bm25Ranks.map((x) => x ?? "-")}] | [${r.fusedRanks.map((x) => x ?? "-")}]`);
}
P(); P("## Q2: gold absent from fused top-20 -- BM25 pool membership (pool=400 sections, SEMANTIC_POOL; doc kind has NO KNN nomination)");
for (const r of R.filter((r) => !le(r.fusedFirst, 20))) {
  P(`- ${r.size} ${r.id}${FAIR5.includes(r.id) ? "*" : ""} [${r.set}] pool returned ${r.poolSize} sections; query: ${JSON.stringify(r.question)}; keywords ${JSON.stringify(r.kw)}`);
  const db = new Database(join(rootOf(r), ".litectx/index.db"), { readonly: true });
  for (const g of r.goldSecs) {
    const body = db.prepare("SELECT n.body body FROM doc_sections sec JOIN nodes n ON n.id=sec.node_id WHERE n.path=? AND n.start_line+1=? ").get(g.path, g.a)?.body ?? "";
    const toks = new Set([...keywords(body + " " + g.path)]), sh = r.kw.filter((k) => toks.has(k));
    P(`    gold section ${g.path}:${g.a}-${g.b} "${g.sym}" bm25Rank=${g.bm25Rank ?? "NOT IN POOL"} fusedRank=${g.fusedRank ?? "-"} shared-query-words=${JSON.stringify(sh)}`);
  }
  db.close();
}
P(); P("## Q3: sections per file in top-20 (fused)");
for (const size of ["1x", "big"]) { const rs = R.filter((r) => r.size === size);
  const dup = rs.map((r) => { const c = {}; r.top20.forEach((h) => (c[h.path] = (c[h.path] || 0) + 1)); return Object.values(c).filter((x) => x > 1).reduce((a, b) => a + b - 1, 0); });
  P(`${size}: questions with >=1 same-file repeat in top-20: ${dup.filter((x) => x > 0).length}/${rs.length}; mean repeated hits per question ${mean(dup)}; max sections from one file ${Math.max(...rs.map((r) => { const c = {}; r.top20.forEach((h) => (c[h.path] = (c[h.path] || 0) + 1)); return Math.max(...Object.values(c)); }))}`);
  P("  questions with 2+ distinct gold sections in one file (fused ranks of each distinct section):");
  for (const r of rs) { const byFile = {}; for (const g of r.goldSecs) (byFile[g.path] ??= []).push(g); for (const [f, gs] of Object.entries(byFile)) if (gs.length > 1) P(`    ${r.id}: ${f} ${gs.length} gold sections, fused ranks [${gs.map((g) => g.fusedRank ?? "-")}] (in top20: ${gs.filter((g) => le(g.fusedRank, 20)).length})`); }
}
P(); P("## Q4: top-N sweep. any/all gold covered (of N); noise = mean non-gold hits in top n; pad = mean docs/ext hits (big); CLI = mean stdout bytes (approx tokens=bytes/4)");
for (const size of ["1x", "big"]) for (const set of ["plain", "reworded", "all"]) {
  const rs = R.filter((r) => r.size === size && (set === "all" || r.set === set)); P(`${size} ${set} N=${rs.length}`);
  P("| n | any | all | mean non-gold | mean pad(docs/ext) | mean returned | CLI bytes | ~tokens |"); P("|---|---|---|---|---|---|---|---|");
  for (const n of NS) { const any = rs.filter((r) => r.fusedRanks.some((x) => le(x, n))).length, all = rs.filter((r) => r.fusedRanks.every((x) => le(x, n))).length;
    const ng = rs.map((r) => r.top20.slice(0, n).filter((h) => !h.gold).length), pad = rs.map((r) => r.top20.slice(0, n).filter((h) => h.path.startsWith("docs/ext/")).length), ret = rs.map((r) => Math.min(n, r.top20.length)), by = rs.map((r) => r.cli[n].bytes);
    P(`| ${n} | ${any} | ${all} | ${mean(ng)} | ${size === "big" ? mean(pad) : "-"} | ${mean(ret)} | ${mean(by)} | ${(mean(by) / 4).toFixed(0)} |`); }
}
P(); P("fair5 fused first rank: " + R.filter((r) => FAIR5.includes(r.id)).map((r) => `${r.size}:${r.id}=${r.fusedFirst ?? "-"}/bm25 ${r.bm25First ?? "-"}`).join("; "));
writeFileSync(join(OUT, "report.txt"), L.join("\n") + "\n"); console.log(L.join("\n"));
