// tinymem embedding-model diagnostic: change ONLY the model; same sections, questions, scoring. No API/LLM.
// usage: node poc/tinymem-models.mjs warm <variant>     (download/load, timing + size)
//        node poc/tinymem-models.mjs recall <variant>   (full litectx recall; variants a-type only, embedModel option)
//        node poc/tinymem-models.mjs rank <variant>     (pure-meaning cosine rank among ALL sections)
//        node poc/tinymem-models.mjs report             (aggregate -> results.json + report.txt)
// Embedder settings mirror src/embedder.js: pipeline("feature-extraction", id, {dtype:"q8"}), normalize:true, text.slice(0,6000).
import { LiteCtx } from "../src/index.js";
import Database from "better-sqlite3";
import { pipeline } from "@huggingface/transformers";
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const O = join(homedir(), ".cache/tinymem-probe/out"), OUT = join(O, "models");
mkdirSync(OUT, { recursive: true });
const HEAD_CHARS = 6000, REPOS = ["bareloop", "bareagent"];
const BGE_Q = "Represent this sentence for searching relevant passages: ";
const VARIANTS = {
  minilm: { model: "Xenova/all-MiniLM-L6-v2", pooling: "mean", qp: "", pp: "", note: "baseline as shipped" },
  "bge-a": { model: "Xenova/bge-small-en-v1.5", pooling: "mean", qp: "", pp: "", note: "litectx today: mean pooling, no prefixes" },
  "bge-b": { model: "Xenova/bge-small-en-v1.5", pooling: "cls", qp: BGE_Q, pp: "", note: "intended: CLS pooling, query instruction prefix, no passage prefix" },
  "e5-a": { model: "Xenova/e5-small-v2", pooling: "mean", qp: "", pp: "", note: "litectx today: mean pooling, no prefixes" },
  "e5-b": { model: "Xenova/e5-small-v2", pooling: "mean", qp: "query: ", pp: "passage: ", note: "intended: mean pooling, query:/passage: prefixes" },
};
const FAIR5 = ["bareloop-p02", "bareagent-p01", "bareagent-p04", "bareagent-p05", "bareagent-p07"];

// frozen-question hash check
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

function makeEmbed(v) {
  let pipe;
  return async (text, isQuery) => {
    pipe ??= await pipeline("feature-extraction", v.model, { dtype: "q8" });
    const t = (isQuery ? v.qp : v.pp) + (text || " ").slice(0, HEAD_CHARS);
    return Float32Array.from((await pipe(t, { pooling: v.pooling, normalize: true })).data);
  };
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const [mode, vname] = process.argv.slice(2);

if (mode === "warm") {
  const v = VARIANTS[vname], t0 = performance.now();
  const emb = makeEmbed(v); await emb("hello", true); const loadMs = ms(t0);
  const cache = join(process.cwd(), "poc/node_modules/@huggingface/transformers/.cache", v.model, "onnx/model_quantized.onnx");
  const size = existsSync(cache) ? statSync(cache).size : null;
  writeFileSync(join(OUT, `${vname}.warm.json`), JSON.stringify({ vname, ...v, firstLoadMs: loadMs, onnxQ8Bytes: size, cache }, null, 1));
  console.log(vname, "first load ms", loadMs, "q8 onnx bytes", size);
}

if (mode === "rank") {
  const v = VARIANTS[vname], emb = makeEmbed(v), out = { vname, ...v, perRepo: {}, rows: [] };
  await emb("warmup", false);
  for (const repo of REPOS) {
    const db = new Database(join(lroot(repo), ".litectx/index.db"), { readonly: true });
    const secs = db.prepare("SELECT n.path path, n.start_line+1 a, n.end_line+1 b, n.body body FROM doc_sections sec JOIN nodes n ON n.id=sec.node_id ORDER BY n.id").all();
    db.close();
    const t0 = performance.now(), vecs = [];
    for (const s of secs) vecs.push(await emb(s.body, false));
    out.perRepo[repo] = { sections: secs.length, embedAllMs: ms(t0) };
    const qms = [];
    for (const q of Q.filter((x) => x.repo === repo)) {
      const t1 = performance.now(), qv = await emb(q.question, true); qms.push(ms(t1));
      const sc = vecs.map((x) => dot(qv, x));
      const goldIdx = secs.map((s, i) => (q.srcs.some((g) => g.path === s.path && ov(s.a, s.b, g.a, g.b)) ? i : -1)).filter((i) => i >= 0);
      const best = Math.max(...goldIdx.map((i) => sc[i]));
      const rank = 1 + sc.filter((x) => x > best).length;
      out.rows.push({ id: q.id, set: q.set, repo, nGold: goldIdx.length, rank, bestGoldCos: +best.toFixed(4), topCos: +Math.max(...sc).toFixed(4) });
    }
    out.perRepo[repo].queryMsMean = +(qms.reduce((a, b) => a + b, 0) / qms.length).toFixed(1);
  }
  writeFileSync(join(OUT, `${vname}.rank.json`), JSON.stringify(out, null, 1));
  console.log(vname, "rank done", JSON.stringify(out.perRepo));
}

if (mode === "recall") {
  const v = VARIANTS[vname];
  if (vname.endsWith("-b")) throw new Error("variant (b) cannot go through litectx without src changes");
  const out = { vname, ...v, perRepo: {}, rows: [] };
  for (const repo of REPOS) {
    const root = join(OUT, vname, repo, "lroot");
    rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
    cpSync(join(lroot(repo), "docs"), join(root, "docs"), { recursive: true });
    const ctx = new LiteCtx({ root, embeddings: true, embedModel: v.model });
    await ctx._embedSafe("warmup"); // load the model before timing
    const t0 = performance.now(), r = await ctx.index();
    out.perRepo[repo] = { indexMs: ms(t0), index: r };
    const qms = [];
    for (const q of Q.filter((x) => x.repo === repo)) {
      const t1 = performance.now();
      const res = await ctx.recall(q.question, { kind: "doc", n: 20, log: false });
      qms.push(ms(t1));
      const hits = res.map((h) => (h.chunk ? { path: h.path, a: h.chunk.startLine + 1, b: h.chunk.endLine + 1 } : { path: h.path, a: 1, b: Infinity }));
      const direct = q.srcs.map((s) => { const i = hits.findIndex((h) => h.path === s.path && ov(h.a, h.b, s.a, s.b)); return i < 0 ? null : i + 1; });
      out.rows.push({ id: q.id, set: q.set, repo, direct });
    }
    out.perRepo[repo].recallMsMean = +(qms.reduce((a, b) => a + b, 0) / qms.length).toFixed(1);
    ctx.close();
    console.log(vname, repo, JSON.stringify(out.perRepo[repo]));
  }
  writeFileSync(join(OUT, `${vname}.recall.json`), JSON.stringify(out, null, 1));
}

if (mode === "report") {
  const load = (n) => (existsSync(join(OUT, n)) ? JSON.parse(readFileSync(join(OUT, n), "utf8")) : null);
  const groups = { fair5: (r) => FAIR5.includes(r.id), reworded15: (r) => r.set === "reworded", plain27: (r) => r.set === "plain" };
  const L = [], P = (s = "") => L.push(s), res = { rank: {}, recall: {}, warm: {} };
  const m4 = JSON.parse(readFileSync(join(O, "step4/m4/results.json"), "utf8")).rows.filter((r) => r.size === "1x");
  const fin = (x) => x !== null && x !== "inf" && Number.isFinite(x);
  const cnt = (rs, f) => rs.filter(f).length;
  P("EMBEDDING MODEL DIAGNOSTIC (only the model changes; q8 dtype; same sections/questions/scoring)");
  P("Variant (a) = litectx today via embedModel (mean pooling, no prefixes). Variant (b) = model's intended use (card pooling + prefixes); pure-meaning only.");
  P("Pooling/prefix sources: BAAI/bge-small-en-v1.5 1_Pooling/config.json cls=true, README: query instruction on queries only, none on passages; intfloat/e5-small-v2 1_Pooling mean, README: 'query: ' / 'passage: '. MiniLM: mean (as shipped).");
  P("Fair misses (5): " + FAIR5.join(", "));
  // ---- sanity
  const mr = load("minilm.recall.json");
  if (mr) {
    P(); P("## SANITY: MiniLM full recall vs step4 m4 1x");
    for (const set of ["reworded", "plain"]) {
      const mine = mr.rows.filter((r) => r.set === set), ref = m4.filter((r) => r.set === (set === "plain" ? "step2" : "step3"));
      const c = (rs, n, key) => cnt(rs, (r) => r[key].some((x) => fin(x) && x <= n));
      const mismatch = mine.filter((r) => { const o = ref.find((x) => x.id === r.id); return JSON.stringify(r.direct) !== JSON.stringify(o.direct.map((x) => (fin(x) ? x : null))); }).map((r) => r.id);
      P(`${set}: @8 any mine ${c(mine, 8, "direct")}/${mine.length} vs m4 ${c(ref, 8, "direct")}/${ref.length}; per-question rank mismatches: ${mismatch.length ? mismatch.join(",") : "none"}`);
    }
  }
  // ---- pure-meaning
  P(); P("## 1. Pure-meaning rank of best gold section among ALL sections (cosine; bareloop 2328 + bareagent 1134 sections, ranked within own repo)");
  P("cell = count of questions with best-gold-rank <= K, of N");
  P("| variant | group | N | @1 | @5 | @8 | @20 | median rank |"); P("|---|---|---|---|---|---|---|---|");
  for (const vn of Object.keys(VARIANTS)) { const d = load(`${vn}.rank.json`); if (!d) continue; res.rank[vn] = d.rows;
    for (const [g, f] of Object.entries(groups)) { const rs = d.rows.filter(f), s = rs.map((r) => r.rank).sort((a, b) => a - b);
      P(`| ${vn} | ${g} | ${rs.length} | ${[1, 5, 8, 20].map((k) => cnt(rs, (r) => r.rank <= k)).join(" | ")} | ${s[Math.floor(s.length / 2)]} |`); } }
  P(); P("Per-question pure-meaning rank (best gold section). * = fair miss. 'p' = plain (m*), reworded = p*.");
  const vns = Object.keys(res.rank);
  P("| question | " + vns.join(" | ") + " |"); P("|---|" + vns.map(() => "---").join("|") + "|");
  const ids = res.rank[vns[0]]?.map((r) => r.id) ?? [];
  const order = [...ids.filter((i) => /-p\d/.test(i)), ...ids.filter((i) => /-m\d/.test(i))];
  for (const id of order) P(`| ${id}${FAIR5.includes(id) ? "*" : ""} | ${vns.map((vn) => res.rank[vn].find((r) => r.id === id).rank).join(" | ")} |`);
  // ---- full recall
  P(); P("## 2. Full litectx recall, kind=doc n=20 (embedModel swapped; any/all gold-source covered)");
  P("| variant | group | N | @5 any/all | @8 any/all | @20 any/all |"); P("|---|---|---|---|---|---|");
  for (const vn of Object.keys(VARIANTS)) { const d = load(`${vn}.recall.json`); if (!d) continue; res.recall[vn] = d.rows;
    for (const [g, f] of Object.entries(groups)) { const rs = d.rows.filter(f);
      P(`| ${vn} | ${g} | ${rs.length} | ${[5, 8, 20].map((k) => `${cnt(rs, (r) => r.direct.some((x) => x !== null && x <= k))}/${cnt(rs, (r) => r.direct.every((x) => x !== null && x <= k))}`).join(" | ")} |`); } }
  const rvns = Object.keys(res.recall);
  if (rvns.length) {
    P(); P("Per-question first-gold rank in recall (- = not in top 20):");
    P("| question | " + rvns.join(" | ") + " |"); P("|---|" + rvns.map(() => "---").join("|") + "|");
    for (const id of order) P(`| ${id}${FAIR5.includes(id) ? "*" : ""} | ${rvns.map((vn) => { const f = res.recall[vn].find((r) => r.id === id).direct.filter((x) => x !== null); return f.length ? Math.min(...f) : "-"; }).join(" | ")} |`);
  }
  // ---- timing
  P(); P("## 3. Timing / size");
  P("| variant | q8 onnx MB | first load ms (incl download if cold) | index ms bareloop (2328 sec) | index ms bareagent (1134 sec) | per-query embed ms (pure-meaning run, warm) | recall ms/query (bareloop/bareagent) |"); P("|---|---|---|---|---|---|---|");
  for (const vn of Object.keys(VARIANTS)) { const w = load(`${vn}.warm.json`), r = load(`${vn}.recall.json`), k = load(`${vn}.rank.json`); res.warm[vn] = { w, r: r?.perRepo, k: k?.perRepo };
    P(`| ${vn} | ${w?.onnxQ8Bytes ? (w.onnxQ8Bytes / 1e6).toFixed(1) : "?"} | ${w?.firstLoadMs ?? "?"} | ${r?.perRepo.bareloop.indexMs ?? "-"} | ${r?.perRepo.bareagent.indexMs ?? "-"} | ${k ? `${k.perRepo.bareloop.queryMsMean}/${k.perRepo.bareagent.queryMsMean}` : "-"} | ${r ? `${r.perRepo.bareloop.recallMsMean}/${r.perRepo.bareagent.recallMsMean}` : "-"} |`); }
  writeFileSync(join(OUT, "results.json"), JSON.stringify(res, null, 1));
  writeFileSync(join(OUT, "report.txt"), L.join("\n") + "\n"); console.log(L.join("\n"));
}
