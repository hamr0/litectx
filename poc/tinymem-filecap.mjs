// tinymem file-cap/group diagnostic. Free, local: no API/LLM, no src/ change. Output $O/filecap/{results.json,report.txt}
import { LiteCtx } from "../src/index.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
const O = join(homedir(), ".cache/tinymem-probe/out"), OUT = join(O, "filecap"); mkdirSync(OUT, { recursive: true });
const REPOS = ["bareloop", "bareagent"], FAIR5 = ["bareloop-p02", "bareagent-p01", "bareagent-p04", "bareagent-p05", "bareagent-p07"];
for (const l of readFileSync(join(O, "step3/FROZEN.sha256"), "utf8").trim().split("\n")) { const [h, f] = l.trim().split(/\s+/); if (createHash("sha256").update(readFileSync(join(O, "step3/questions", f))).digest("hex") !== h) throw new Error("FROZEN mismatch " + f); }
const parseSrc = (s) => { const m = /^(.+):(\d+)-(\d+)$/.exec(s); return { path: m[1], a: +m[2], b: +m[3] }; };
const ov = (a1, b1, a2, b2) => a1 <= b2 && a2 <= b1;
const Q = [];
for (const [set, dir] of [["plain", "step2/questions"], ["reworded", "step3/questions"]]) for (const repo of REPOS)
  for (const q of JSON.parse(readFileSync(join(O, dir, repo + ".json"), "utf8"))) Q.push({ id: q.id, question: q.question, set, repo, srcs: q.sources.map(parseSrc) });
const SIZES = { "1x": (r) => join(O, "step2/root", r, "lroot"), big: (r) => join(O, "step4", r + "-big/lroot") };
// --- CLI line format (copied from bin/litectx.js) ---
const relAge = (sec) => { const s = Math.max(0, Math.floor(Date.now() / 1000 - sec)); return s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`; };
const fmtChunk = (c) => (c ? `\t→ ${c.symbol ?? c.nodeType}:${c.startLine + 1}-${c.endLine + 1}` : "");
const fmtGit = (g) => (g ? `\tgit:${g.commits}c${g.lastCommit ? `/${relAge(g.lastCommit)}` : ""}` : "");
const line = (h) => `${h.score.toFixed(2)}\t${h.kind}/${h.format}\t${h.path}${fmtChunk(h.chunk)}${fmtGit(h.git)}\n`;
const norm = (h) => ({ raw: h, path: h.path, a: h.chunk ? h.chunk.startLine + 1 : 1, b: h.chunk ? h.chunk.endLine + 1 : Infinity });
// --- variants: list -> {shown:[hit], text} ---
const plainOut = (hs) => ({ shown: hs, text: hs.map((h) => line(h.raw)).join("") });
const capped = (L, K, N) => { const c = new Map(), out = []; for (const h of L) { if (out.length >= N) break; const k = c.get(h.path) ?? 0; if (k >= K) continue; c.set(h.path, k + 1); out.push(h); } return out; };
const grouped = (L, F, win, K) => {
  const w = L.slice(0, win), files = new Map();
  for (const h of w) { if (!files.has(h.path)) files.set(h.path, []); files.get(h.path).push(h); }
  const shown = [], text = [];
  for (const [p, hs] of [...files].slice(0, F)) { const use = K ? hs.slice(0, K) : hs; shown.push(...use); text.push(`FILE ${p}: lines ${use.map((h) => `${h.a}-${h.b === Infinity ? "end" : h.b}`).join(", ")}\n`); }
  return { shown, text: text.join("") };
};
const V = {};
for (const N of [5, 8, 10, 15, 20]) V[`base-${N}`] = (L) => plainOut(L.slice(0, N));
for (const K of [1, 2, 3]) for (const N of [5, 8, 10, 15]) V[`cap${K}-${N}`] = (L) => plainOut(capped(L, K, N));
for (const F of [3, 5, 8, 10]) for (const w of [20, 50]) V[`group-${F}-w${w}`] = (L) => grouped(L, F, w, 0);
for (const F of [3, 5, 8, 10]) for (const K of [2, 3]) for (const w of [20, 50]) V[`groupcap-${F}-${K}-w${w}`] = (L) => grouped(L, F, w, K);
// --- run ---
const R = [];
for (const [size, rootOf] of Object.entries(SIZES)) for (const repo of REPOS) {
  const F = new LiteCtx({ root: rootOf(repo), embeddings: true });
  for (const q of Q.filter((x) => x.repo === repo)) {
    const L = (await F.recall(q.question, { kind: "doc", n: 400, log: false })).map(norm);
    const goldFiles = [...new Set(q.srcs.map((s) => s.path))];
    const multi = goldFiles.some((f) => q.srcs.filter((s) => s.path === f).length >= 2);
    const row = { size, id: q.id, set: q.set, repo, multi, fair: FAIR5.includes(q.id), nGold: q.srcs.length, nGoldFiles: goldFiles.length, v: {} };
    for (const [name, fn] of Object.entries(V)) {
      const { shown, text } = fn(L), files = [...new Set(shown.map((h) => h.path))];
      const gs = q.srcs.map((s) => shown.some((h) => h.path === s.path && ov(h.a, h.b, s.a, s.b)));
      const gfs = goldFiles.filter((f) => files.includes(f));
      row.v[name] = { any: gs.some(Boolean), all: gs.every(Boolean), fcov: gfs.length / goldFiles.length, fileFound: gfs.length > 0, files: files.length, nonGoldFiles: files.filter((f) => !goldFiles.includes(f)).length, pad: files.filter((f) => f.startsWith("docs/ext/")).length, bytes: Buffer.byteLength(text), sects: shown.length };
    }
    R.push(row);
  }
  F.close();
}
// sanity vs rankcut report: base-N any-gold counts
const EXP = { "1x": { plain: [24, 25, 25, 27, 27], reworded: [7, 8, 8, 9, 11] }, big: { plain: [24, 25, 26, 27, 27], reworded: [7, 8, 8, 8, 8] } };
let bad = 0, sanity = [];
for (const size of ["1x", "big"]) for (const set of ["plain", "reworded"]) {
  const got = [5, 8, 10, 15, 20].map((N) => R.filter((r) => r.size === size && r.set === set && r.v[`base-${N}`].any).length);
  const ok = JSON.stringify(got) === JSON.stringify(EXP[size][set]); if (!ok) bad++;
  sanity.push(`${size} ${set}: got ${got} expected ${EXP[size][set]} ${ok ? "OK" : "MISMATCH"}`);
}
const rc = JSON.parse(readFileSync(join(O, "rankcut/results.json"), "utf8"));
let rcBad = 0; for (const r of R) { const x = rc.find((y) => y.size === r.size && y.id === r.id); for (const N of [5, 8, 10, 15, 20]) if ((x.fusedFirst !== null && x.fusedFirst <= N) !== r.v[`base-${N}`].any) rcBad++; }
sanity.push(`per-question any-gold vs rankcut results.json fusedFirst: ${rcBad} mismatches`);
// --- report ---
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const agg = (rows, name) => ({ n: rows.length, any: rows.filter((r) => r.v[name].any).length, all: rows.filter((r) => r.v[name].all).length, fcov: mean(rows.map((r) => r.v[name].fcov)), files: mean(rows.map((r) => r.v[name].files)), ng: mean(rows.map((r) => r.v[name].nonGoldFiles)), pad: mean(rows.map((r) => r.v[name].pad)), tok: mean(rows.map((r) => r.v[name].bytes / 4)) });
const out = []; const P = (s = "") => out.push(s);
P("SANITY"); sanity.forEach(P); P();
const names = Object.keys(V), f2 = (x) => x.toFixed(2), f1 = (x) => x.toFixed(1);
const A = {}; // A[size][set][name]
for (const size of ["1x", "big"]) { A[size] = {}; for (const set of ["plain", "reworded", "all"]) { const rows = R.filter((r) => r.size === size && (set === "all" || r.set === set)); A[size][set] = Object.fromEntries(names.map((n) => [n, agg(rows, n)])); } }
for (const size of ["1x", "big"]) {
  P(`## TABLE ${size}  (cols per set: any-gold / all-gold / gold-FILE coverage; then all-42: files, nonGold files, padding files, ~tokens)`);
  P("variant\t\tplain(27) any/all/fcov\treworded(15) any/all/fcov\tALL(42) any/all/fcov\tfiles\tnonG\tpad\ttok\tall/ktok");
  for (const n of names) { const p = A[size].plain[n], w = A[size].reworded[n], a = A[size].all[n]; P(`${n.padEnd(20)}\t${p.any}/${p.all}/${f2(p.fcov)}\t${w.any}/${w.all}/${f2(w.fcov)}\t${a.any}/${a.all}/${f2(a.fcov)}\t${f1(a.files)}\t${f1(a.ng)}\t${f1(a.pad)}\t${f1(a.tok)}\t${f1(a.all / (a.tok * a.n / 1000) )}`); }
  P();
}
// beats base-10: coverage (all 42, fcov) strictly greater and tokens <= base-10
const beats = {};
for (const size of ["1x", "big"]) { const b = A[size].all["base-10"]; beats[size] = names.filter((n) => A[size].all[n].fcov > b.fcov + 1e-9 && A[size].all[n].tok <= b.tok); P(`## ${size}: variants beating base-10 (fcov ${f2(b.fcov)}, ${f1(b.tok)} tok) on gold-file coverage at <= tokens (all 42):`); P(beats[size].map((n) => `${n}[fcov ${f2(A[size].all[n].fcov)}, any ${A[size].all[n].any}, all ${A[size].all[n].all}, ${f1(A[size].all[n].tok)}tok]`).join("\n") || "(none)"); P(); }
const both = beats["1x"].filter((n) => beats.big.includes(n)); P("## beat base-10 at BOTH sizes: " + (both.join(", ") || "(none)")); P();
// also: matching base-10 coverage at fewer tokens
for (const size of ["1x", "big"]) { const b = A[size].all["base-10"]; P(`## ${size}: variants with fcov >= base-10 and tokens < 0.8*base-10 tokens:`); P(names.filter((n) => A[size].all[n].fcov >= b.fcov - 1e-9 && A[size].all[n].tok < 0.8 * b.tok).map((n) => `${n}[fcov ${f2(A[size].all[n].fcov)}, all ${A[size].all[n].all}, ${f1(A[size].all[n].tok)}tok]`).join("\n") || "(none)"); P(); }
// multi-gold-in-one-file
const multiRows = (size) => R.filter((r) => r.size === size && r.multi);
P(`## multi-gold-in-one-file questions: 1x n=${multiRows("1x").length}, big n=${multiRows("big").length}. all-gold count per variant (1x / big)`);
for (const n of names) P(`${n.padEnd(20)}\t${multiRows("1x").filter((r) => r.v[n].all).length}/${multiRows("1x").length}\t${multiRows("big").filter((r) => r.v[n].all).length}/${multiRows("big").length}`);
P();
P("## fair misses: gold FILE surfaced? (count of 5 per size 1x/big; per-question listed for variants that surface any)");
for (const n of names) { const c = (size) => R.filter((r) => r.size === size && r.fair && r.v[n].fileFound).map((r) => r.id); const a = c("1x"), b = c("big"); if (a.length || b.length) P(`${n.padEnd(20)}\t1x ${a.length}/5 [${a.join(" ")}]\tbig ${b.length}/5 [${b.join(" ")}]`); }
P();
// ranking: by fcov then all per ktok, top by size among tokens <= base-15
for (const size of ["1x", "big"]) { const s = [...names].sort((x, y) => A[size].all[y].fcov - A[size].all[x].fcov || A[size].all[x].tok - A[size].all[y].tok); P(`## ${size}: top 12 by fcov (tie: fewer tokens)`); s.slice(0, 12).forEach((n) => P(`${n}\tfcov ${f2(A[size].all[n].fcov)} all ${A[size].all[n].all} any ${A[size].all[n].any} ${f1(A[size].all[n].tok)}tok`)); P(); }
// per-question wins/loses vs base-10 for candidates (beats-both, else top beats at big)
const cand = (both.length ? both : [...new Set([...beats["1x"], ...beats.big])]).slice(0, 6);
P("## per-question differences vs base-10 for candidate variants (fcov/any/all change)");
for (const n of cand) for (const size of ["1x", "big"]) { const d = []; for (const r of R.filter((x) => x.size === size)) { const a = r.v["base-10"], b = r.v[n]; if (a.fcov !== b.fcov || a.any !== b.any || a.all !== b.all) d.push(`${r.id}(${r.set[0]}) fcov ${f2(a.fcov)}->${f2(b.fcov)} any ${+a.any}->${+b.any} all ${+a.all}->${+b.all}`); } P(`${n} @${size}: ${d.join("; ") || "no differences"}`); }
writeFileSync(join(OUT, "report.txt"), out.join("\n")); writeFileSync(join(OUT, "results.json"), JSON.stringify(R));
console.log(out.join("\n"));
