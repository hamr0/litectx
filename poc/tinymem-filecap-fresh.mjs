// tinymem fresh confirmation (24 fresh questions). Reuses filecap variants/scoring verbatim; only question source changes. Free, local.
import { LiteCtx } from "../src/index.js";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
const O = join(homedir(), ".cache/tinymem-probe/out"), OUT = join(O, "fresh/confirm");
const REPOS = ["bareloop", "bareagent"];
for (const l of readFileSync(join(O, "fresh/FROZEN.sha256"), "utf8").trim().split("\n")) { const [h, f] = l.trim().split(/\s+/); if (createHash("sha256").update(readFileSync(join(O, "fresh", f))).digest("hex") !== h) throw new Error("FROZEN mismatch " + f); }
const parseSrc = (s) => { const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(s); return { path: m[1], a: +m[2], b: +(m[3] ?? m[2]) }; };
const ov = (a1, b1, a2, b2) => a1 <= b2 && a2 <= b1;
const Q = [];
for (const repo of REPOS) for (const q of JSON.parse(readFileSync(join(O, "fresh/questions", repo + ".json"), "utf8"))) Q.push({ id: q.id, question: q.question, set: q.style, repo, srcs: q.sources.map(parseSrc), also: (q.also || []).map(parseSrc) });
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
const R = [];
const score = (shown, srcs, files, text) => { const goldFiles = [...new Set(srcs.map((s) => s.path))]; const gs = srcs.map((s) => shown.some((h) => h.path === s.path && ov(h.a, h.b, s.a, s.b))); const gfs = goldFiles.filter((f) => files.includes(f)); return { any: gs.some(Boolean), all: gs.every(Boolean), fcov: gfs.length / goldFiles.length }; };
for (const [size, rootOf] of Object.entries(SIZES)) for (const repo of REPOS) {
  const F = new LiteCtx({ root: rootOf(repo), embeddings: true });
  for (const q of Q.filter((x) => x.repo === repo)) {
    const L = (await F.recall(q.question, { kind: "doc", n: 400, log: false })).map(norm);
    const row = { size, id: q.id, set: q.set, repo, v: {}, fusedFirst: (() => { const i = L.findIndex((h) => q.srcs.some((s) => h.path === s.path && ov(h.a, h.b, s.a, s.b))); return i < 0 ? null : i + 1; })() };
    for (const [name, fn] of Object.entries(V)) {
      const { shown, text } = fn(L), files = [...new Set(shown.map((h) => h.path))];
      const g = score(shown, q.srcs, files), u = score(shown, [...q.srcs, ...q.also], files);
      const goldFiles = [...new Set(q.srcs.map((s) => s.path))];
      row.v[name] = { ...g, u, files: files.length, nonGoldFiles: files.filter((f) => !goldFiles.includes(f)).length, pad: files.filter((f) => f.startsWith("docs/ext/")).length, bytes: Buffer.byteLength(text), sects: shown.length, ptrs: name.startsWith("group") ? shown.length : null };
    }
    // sanity: base-N list equals plain fused recall cut at N (compare paths+lines)
    for (const N of [5, 10, 20]) { const a = V[`base-${N}`](L).shown.map((h) => h.path + h.a + h.b).join("|"), b = L.slice(0, N).map((h) => h.path + h.a + h.b).join("|"); if (a !== b) throw new Error("sanity base-" + N); }
    R.push(row);
  }
  F.close();
}
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const f2 = (x) => x.toFixed(2), f1 = (x) => x.toFixed(1);
const agg = (rows, n) => ({ n: rows.length, any: rows.filter((r) => r.v[n].any).length, all: rows.filter((r) => r.v[n].all).length, fcov: mean(rows.map((r) => r.v[n].fcov)), uany: rows.filter((r) => r.v[n].u.any).length, uall: rows.filter((r) => r.v[n].u.all).length, ufcov: mean(rows.map((r) => r.v[n].u.fcov)), files: mean(rows.map((r) => r.v[n].files)), pad: mean(rows.map((r) => r.v[n].pad)), tok: mean(rows.map((r) => r.v[n].bytes / 4)) });
const out = []; const P = (s = "") => out.push(s);
P("SANITY: base-5/10/20 lists equal plain fused recall cut at N for all 48 (question,size) runs: OK (script throws otherwise)"); P();
const SHOW = ["base-5", "base-10", "base-20", "group-8-w20", "group-8-w50", "groupcap-8-3-w50"];
for (const size of ["1x", "big"]) {
  for (const [lab, rows] of [["ALL 24", R.filter((r) => r.size === size)], ["plain 12", R.filter((r) => r.size === size && r.set === "plain")], ["reworded 12", R.filter((r) => r.size === size && r.set === "reworded")]]) {
    P(`## ${size} ${lab}  [gold=sources: any/all/fcov | gold=sources+also: any/all/fcov | files pad tok]`);
    for (const n of SHOW) { const a = agg(rows, n); P(`${n.padEnd(18)} ${a.any}/${a.all}/${f2(a.fcov)} | ${a.uany}/${a.uall}/${f2(a.ufcov)} | files ${f1(a.files)} pad ${f1(a.pad)} tok ${f1(a.tok)}`); }
    P();
  }
}
P("## VERDICT (pre-registered, gold=sources, all 24)");
let holds = true;
for (const size of ["1x", "big"]) { const rows = R.filter((r) => r.size === size), g = agg(rows, "group-8-w50"), b = agg(rows, "base-10"); const c = [g.fcov >= b.fcov - 1e-9, g.all >= b.all, g.tok < b.tok]; if (!c.every(Boolean)) holds = false; P(`${size}: fcov ${f2(g.fcov)} vs ${f2(b.fcov)} [${c[0]}]; all-gold ${g.all} vs ${b.all} [${c[1]}]; tok ${f1(g.tok)} vs ${f1(b.tok)} [${c[2]}]`); }
P(holds ? "HOLDS" : "DOES NOT HOLD"); P();
P("## per-question rows where group-8-w50 and base-10 differ (gold=sources): fcov any all, base-10 -> group-8-w50");
for (const size of ["1x", "big"]) { const d = []; for (const r of R.filter((x) => x.size === size)) { const a = r.v["base-10"], b = r.v["group-8-w50"]; if (a.fcov !== b.fcov || a.any !== b.any || a.all !== b.all) d.push(`${r.id}(${r.set[0]}) fcov ${f2(a.fcov)}->${f2(b.fcov)} any ${+a.any}->${+b.any} all ${+a.all}->${+b.all}`); } P(`@${size}: ${d.join("; ") || "no differences"}`); }
P();
P("## section pointers listed per question (mean / max)");
for (const size of ["1x", "big"]) for (const n of ["group-8-w20", "group-8-w50"]) { const p = R.filter((r) => r.size === size).map((r) => r.v[n].ptrs); P(`${size} ${n}: mean ${f1(mean(p))} max ${Math.max(...p)}`); }
writeFileSync(join(OUT, "report.txt"), out.join("\n")); writeFileSync(join(OUT, "results.json"), JSON.stringify(R));
console.log(out.join("\n"));
