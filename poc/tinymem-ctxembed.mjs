// tinymem context-embedding diagnostic: model FIXED (MiniLM q8, litectx pipeline), sections FIXED, only the EMBED INPUT changes. No API/LLM.
// variants: base (body), a (heading-path prefix + body), b (small-to-big: max paragraph cosine), ab (paragraphs each with prefix; extra row)
// usage: node poc/tinymem-ctxembed.mjs embed     (embeds all variants, caches to $O/ctxembed/cache)
//        node poc/tinymem-ctxembed.mjs report    (pure-meaning rank + simulated litectx recall -> results.json + report.txt)
import { LiteCtx } from "../src/index.js";
import Database from "better-sqlite3";
import { pipeline } from "@huggingface/transformers";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const O = join(homedir(), ".cache/tinymem-probe/out"), OUT = join(O, "ctxembed"), CACHE = join(OUT, "cache");
mkdirSync(CACHE, { recursive: true });
const HEAD_CHARS = 6000, REPOS = ["bareloop", "bareagent"], DIM = 384;
const FAIR5 = ["bareloop-p02", "bareagent-p01", "bareagent-p04", "bareagent-p05", "bareagent-p07"];
for (const l of readFileSync(join(O, "step3/FROZEN.sha256"), "utf8").trim().split("\n")) {
  const [h, f] = l.trim().split(/\s+/);
  if (createHash("sha256").update(readFileSync(join(O, "step3/questions", f))).digest("hex") !== h) throw new Error("FROZEN mismatch " + f);
}
const parseSrc = (s) => { const m = /^(.+):(\d+)-(\d+)$/.exec(s); return { path: m[1], a: +m[2], b: +m[3] }; };
const ov = (a1, b1, a2, b2) => a1 <= b2 && a2 <= b1;
const Q = [];
for (const [set, dir] of [["plain", "step2/questions"], ["reworded", "step3/questions"]]) for (const repo of REPOS)
  for (const q of JSON.parse(readFileSync(join(O, dir, repo + ".json"), "utf8"))) Q.push({ id: q.id, question: q.question, set, repo, srcs: q.sources.map(parseSrc) });
const lroot = (r) => join(O, "step2/root", r, "lroot");
const ms = (t0) => +(performance.now() - t0).toFixed(1);
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

let pipe;
async function embed(text) { // exactly src/embedder.js
  pipe ??= await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
  return Float32Array.from((await pipe((text || " ").slice(0, HEAD_CHARS), { pooling: "mean", normalize: true })).data);
}
function loadSecs(repo) {
  const db = new Database(join(lroot(repo), ".litectx/index.db"), { readonly: true });
  const secs = db.prepare("SELECT sec.doc_rowid rid, n.path path, n.start_line+1 a, n.end_line+1 b, n.body body FROM doc_sections sec JOIN nodes n ON n.id=sec.node_id ORDER BY n.id").all();
  db.close();
  return secs;
}
// ---- (a) heading chain: deterministic from the file's own #..###### lines (fenced code skipped)
const headCache = new Map();
function headings(path, repo) {
  const k = repo + path;
  if (!headCache.has(k)) {
    const lines = readFileSync(join(lroot(repo), path), "utf8").split("\n"), hs = []; let fence = null;
    lines.forEach((ln, i) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(ln);
      if (f) { if (!fence) fence = f[1][0]; else if (f[1][0] === fence) fence = null; return; }
      if (fence) return;
      const m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(ln);
      if (m) hs.push({ line: i + 1, level: m[1].length, text: m[2] });
    });
    headCache.set(k, hs);
  }
  return headCache.get(k);
}
function prefixOf(s, repo) {
  const stack = [];
  for (const h of headings(s.path, repo)) { if (h.line > s.a) break; while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop(); stack.push(h); }
  return [s.path, ...stack.map((h) => h.text)].join(" > ");
}
// ---- (b) paragraphs
function paragraphs(body) {
  let parts = body.split(/\n\s*\n/).map((p) => p.replace(/^\n+|\s+$/g, "")).filter((p) => p.trim());
  const out = [];
  for (const p of parts) {
    if (p.length <= 1500) { out.push(p); continue; }
    let cur = "";
    for (const ln of p.split("\n")) { if (cur && cur.length + ln.length + 1 > 1500) { out.push(cur); cur = ""; } cur += (cur ? "\n" : "") + ln; }
    if (cur) out.push(cur);
  }
  const m = []; // merge fragments <100 chars into the neighbour (next, or previous if last)
  for (let i = 0; i < out.length; i++) {
    if (out[i].length < 100 && i + 1 < out.length) out[i + 1] = out[i] + "\n\n" + out[i + 1];
    else if (out[i].length < 100 && m.length) m[m.length - 1] += "\n\n" + out[i];
    else m.push(out[i]);
  }
  return m.length ? m : [body];
}
// inputs per variant: array (per section) of arrays of texts
function inputs(v, secs, repo) {
  return secs.map((s) => {
    const pre = prefixOf(s, repo) + "\n";
    if (v === "base") return [s.body];
    if (v === "a") return [pre + s.body];
    if (v === "b") return paragraphs(s.body);
    if (v === "ab") return paragraphs(s.body).map((p) => pre + p);
  });
}
const VARS = ["base", "a", "b", "ab"];
const [mode] = process.argv.slice(2);

if (mode === "embed") {
  await embed("warmup");
  for (const repo of REPOS) {
    const secs = loadSecs(repo);
    for (const v of VARS) {
      const f = join(CACHE, `${v}-${repo}`);
      if (existsSync(f + ".json")) { console.log("cached", v, repo); continue; }
      const ins = inputs(v, secs, repo), flat = ins.flat(), t0 = performance.now(), buf = new Float32Array(flat.length * DIM);
      let k = 0; for (const t of flat) buf.set(await embed(t), DIM * k++);
      const meta = { v, repo, sections: secs.length, vectors: flat.length, counts: ins.map((x) => x.length), embedAllMs: ms(t0) };
      writeFileSync(f + ".bin", Buffer.from(buf.buffer)); writeFileSync(f + ".json", JSON.stringify(meta));
      console.log(v, repo, JSON.stringify({ ...meta, counts: undefined }));
    }
  }
}

if (mode === "report") {
  const loadV = (v, repo) => {
    const meta = JSON.parse(readFileSync(join(CACHE, `${v}-${repo}.json`), "utf8")), b = readFileSync(join(CACHE, `${v}-${repo}.bin`));
    const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)), per = []; let o = 0;
    for (const c of meta.counts) { const arr = []; for (let i = 0; i < c; i++, o++) arr.push(all.subarray(o * DIM, (o + 1) * DIM)); per.push(arr); }
    return { meta, per };
  };
  // score of section = max cosine over its vectors (single vector => plain cosine)
  const secScore = (qv, vecs) => { let m = -2; for (const x of vecs) { const d = dot(qv, x); if (d > m) m = d; } return m; };
  const secsBy = Object.fromEntries(REPOS.map((r) => [r, loadSecs(r)]));
  const V = {}; for (const v of VARS) for (const r of REPOS) V[v + r] = loadV(v, r);
  await embed("warmup");
  const qvec = new Map(); for (const q of Q) qvec.set(q.id, await embed(q.question));
  const goldOf = (q, secs) => secs.map((s, i) => (q.srcs.some((g) => g.path === s.path && ov(s.a, s.b, g.a, g.b)) ? i : -1)).filter((i) => i >= 0);
  // ---- 1. pure-meaning
  const rank = {}; // rank[v][id]
  for (const v of VARS) { rank[v] = {}; for (const q of Q) {
    const per = V[v + q.repo].per, sc = per.map((vs) => secScore(qvec.get(q.id), vs)), g = goldOf(q, secsBy[q.repo]);
    const best = Math.max(...g.map((i) => sc[i])); rank[v][q.id] = 1 + sc.filter((x) => x > best).length;
  } }
  const ref = JSON.parse(readFileSync(join(O, "models/minilm.rank.json"), "utf8")).rows;
  const rankMis = ref.filter((r) => rank.base[r.id] !== r.rank).map((r) => `${r.id}: mine ${rank.base[r.id]} vs ref ${r.rank}`);
  // ---- 2. simulated litectx recall (real LiteCtx recall; only docCandidateVectors swapped, via qvec-scaled stand-in so cosine(qvec,v)=section score)
  const m4 = JSON.parse(readFileSync(join(O, "step4/m4/results.json"), "utf8")).rows.filter((r) => r.size === "1x");
  const fin = (x) => x !== null && x !== "inf" && Number.isFinite(x);
  const recall = {}; // recall[v][id] = direct[]
  for (const v of ["shipped", ...VARS]) recall[v] = {};
  for (const repo of REPOS) {
    const ctx = new LiteCtx({ root: lroot(repo), embeddings: true }), store = ctx.store;
    const rows = store.db.prepare("SELECT sec.doc_rowid rid FROM doc_sections sec JOIN nodes n ON n.id=sec.node_id ORDER BY n.id").all();
    const idxOfRid = new Map(rows.map((r, i) => [Number(r.rid), i]));
    let cur = null, lastQ = null; // cur = variant vectors; null => shipped stored vectors
    const origEq = ctx._embedQuery.bind(ctx), origDCV = store.docCandidateVectors.bind(store);
    ctx._embedQuery = async (q) => (lastQ = await origEq(q));
    store.docCandidateVectors = (cands) => {
      if (!cur) return origDCV(cands);
      return cands.map((c) => { const i = c.rid != null ? idxOfRid.get(Number(c.rid)) : undefined; if (i === undefined) return origDCV([c])[0];
        const s = secScore(lastQ, cur[i]); return Float32Array.from(lastQ, (x) => x * s); });
    };
    for (const v of ["shipped", ...VARS]) {
      cur = v === "shipped" ? null : V[v + repo].per;
      for (const q of Q.filter((x) => x.repo === repo)) {
        const res = await ctx.recall(q.question, { kind: "doc", n: 20, log: false });
        const hits = res.map((h) => (h.chunk ? { path: h.path, a: h.chunk.startLine + 1, b: h.chunk.endLine + 1 } : { path: h.path, a: 1, b: Infinity }));
        recall[v][q.id] = q.srcs.map((s) => { const i = hits.findIndex((h) => h.path === s.path && ov(h.a, h.b, s.a, s.b)); return i < 0 ? null : i + 1; });
      }
    }
    ctx.close();
  }
  const m4ref = (id) => m4.find((r) => r.id === id).direct.map((x) => (fin(x) ? x : null));
  const mism = (v) => Q.filter((q) => JSON.stringify(recall[v][q.id]) !== JSON.stringify(m4ref(q.id))).map((q) => q.id);
  const mis = { shipped: mism("shipped"), base: mism("base") };
  // ---- report
  const groups = { fair5: (q) => FAIR5.includes(q.id), reworded15: (q) => q.set === "reworded", plain27: (q) => q.set === "plain" };
  const cnt = (rs, f) => rs.filter(f).length, L = [], P = (s = "") => L.push(s);
  const first = (v, id) => { const f = recall[v][id].filter((x) => x !== null); return f.length ? Math.min(...f) : null; };
  P("CONTEXT-EMBEDDING DIAGNOSTIC: model fixed (MiniLM q8, litectx pipeline); sections fixed (existing doc_sections rows); only embed input changes.");
  P("Variants: base=section body; a=heading-path prefix+body; b=small-to-big (section score = max paragraph cosine); ab=paragraphs each with prefix (extra row). Queries as-is.");
  P("Fair misses (5): " + FAIR5.join(", "));
  P(); P("## SANITY GATES");
  P(`pure-meaning base vs models/minilm.rank.json: ${rankMis.length ? "MISMATCH " + rankMis.join("; ") : "all 42 ranks identical"}`);
  P(`simulated recall: shipped stored vectors vs m4 1x per-question ranks: ${mis.shipped.length ? "MISMATCH " + mis.shipped.join(",") : "0 mismatches"}`);
  P(`simulated recall: base re-embedded via my harness (stand-in vectors) vs m4 1x: ${mis.base.length ? "MISMATCH " + mis.base.join(",") : "0 mismatches"}`);
  for (const [set, sn] of [["reworded", "step3"], ["plain", "step2"]]) { const rs = Q.filter((q) => q.set === set);
    P(`  ${set} @8 any: shipped ${cnt(rs, (q) => recall.shipped[q.id].some((x) => x !== null && x <= 8))}/${rs.length}, m4 ${cnt(rs, (q) => m4ref(q.id).some((x) => x !== null && x <= 8))}`); }
  P(); P("## 1. Pure-meaning rank of best gold section among ALL sections (cells = count with rank<=K)");
  P("| variant | group | N | @1 | @5 | @8 | @20 | median |"); P("|---|---|---|---|---|---|---|---|");
  for (const v of VARS) for (const [g, f] of Object.entries(groups)) { const rs = Q.filter(f), s = rs.map((q) => rank[v][q.id]).sort((a, b) => a - b);
    P(`| ${v} | ${g} | ${rs.length} | ${[1, 5, 8, 20].map((k) => cnt(rs, (q) => rank[v][q.id] <= k)).join(" | ")} | ${s[Math.floor(s.length / 2)]} |`); }
  P(); P("## 2. Simulated litectx recall (real recall(); BM25 pool 400 + minmax fusion, embedWeight 1.0; only section vectors swapped). Cell = any-gold / all-gold covered");
  P("| variant | group | N | @5 | @8 | @20 |"); P("|---|---|---|---|---|---|");
  for (const v of VARS) for (const [g, f] of Object.entries(groups)) { const rs = Q.filter(f);
    P(`| ${v} | ${g} | ${rs.length} | ${[5, 8, 20].map((k) => `${cnt(rs, (q) => recall[v][q.id].some((x) => x !== null && x <= k))}/${cnt(rs, (q) => recall[v][q.id].every((x) => x !== null && x <= k))}`).join(" | ")} |`); }
  const order = [...Q.filter((q) => q.set === "reworded"), ...Q.filter((q) => q.set === "plain")];
  P(); P("## Per-question (42). pure = pure-meaning rank; rec = first-gold rank in simulated recall top 20 (- = absent). * = fair miss");
  P("| question | pure base | a | b | ab | rec base | a | b | ab |"); P("|---|---|---|---|---|---|---|---|---|");
  for (const q of order) P(`| ${q.id}${FAIR5.includes(q.id) ? "*" : ""} | ${VARS.map((v) => rank[v][q.id]).join(" | ")} | ${VARS.map((v) => first(v, q.id) ?? "-").join(" | ")} |`);
  P(); P("## Rank changes vs base (pure-meaning rank): questions where variant moved best-gold across the @8 line");
  for (const v of ["a", "b", "ab"]) { const up = Q.filter((q) => rank.base[q.id] > 8 && rank[v][q.id] <= 8).map((q) => q.id), dn = Q.filter((q) => rank.base[q.id] <= 8 && rank[v][q.id] > 8).map((q) => q.id);
    P(`- ${v} pure@8: gained [${up.join(", ")}]; lost [${dn.join(", ")}]`);
    const up2 = Q.filter((q) => !(first("base", q.id) <= 8) && first(v, q.id) <= 8).map((q) => q.id), dn2 = Q.filter((q) => first("base", q.id) <= 8 && !(first(v, q.id) <= 8)).map((q) => q.id);
    P(`- ${v} recall@8 any: gained [${up2.join(", ")}]; lost [${dn2.join(", ")}]`); }
  P(); P("## 3. Cost (embed-all, same machine, sequential; MiniLM q8 CPU)");
  P("| variant | bareloop sections | bareloop vectors | ms | bareagent sections | bareagent vectors | ms | total vectors | est index MB (vec x384x4B) |"); P("|---|---|---|---|---|---|---|---|---|");
  const cost = {};
  for (const v of VARS) { const a = V[v + "bareloop"].meta, b = V[v + "bareagent"].meta, tv = a.vectors + b.vectors; cost[v] = { a, b };
    P(`| ${v} | ${a.sections} | ${a.vectors} | ${a.embedAllMs} | ${b.sections} | ${b.vectors} | ${b.embedAllMs} | ${tv} | ${(tv * DIM * 4 / 1e6).toFixed(2)} |`); }
  P(); P("## Example heading-path prefixes (variant a)");
  const ex = []; for (const [repo, i] of [["bareagent", 2], ["bareloop", 900], ["bareagent", 700]]) ex.push(prefixOf(secsBy[repo][i], repo));
  ex.forEach((e) => P("- " + JSON.stringify(e)));
  P(); P("## Gold-section content for the 5 fair misses: gold section text snippets (first 160 chars) + prefix");
  for (const id of FAIR5) { const q = Q.find((x) => x.id === id), secs = secsBy[q.repo]; for (const i of goldOf(q, secs).slice(0, 2)) P(`- ${id}: ${JSON.stringify(prefixOf(secs[i], q.repo))} :: ${JSON.stringify(secs[i].body.slice(0, 160))} (${V.b + ""}paras=${V["b" + q.repo].meta.counts[i]})`); }
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ rank, recall, mis, rankMis, cost }, null, 1));
  writeFileSync(join(OUT, "report.txt"), L.join("\n") + "\n"); console.log(L.join("\n"));
}
