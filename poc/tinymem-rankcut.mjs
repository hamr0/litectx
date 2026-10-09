// tinymem rank-vs-cutoff-vs-pool diagnostic. Free, local: no API/LLM, no src/ change. Output $O/rankcut/{results.json,report.txt}
import { LiteCtx, keywords } from "../src/index.js";
import Database from "better-sqlite3";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
const O = join(homedir(), ".cache/tinymem-probe/out"), OUT = join(O, "rankcut"); mkdirSync(OUT, { recursive: true });
const REPOS = ["bareloop", "bareagent"], NS = [5, 8, 10, 15, 20], FAIR5 = ["bareloop-p02", "bareagent-p01", "bareagent-p04", "bareagent-p05", "bareagent-p07"];
for (const l of readFileSync(join(O, "step3/FROZEN.sha256"), "utf8").trim().split("\n")) { const [h, f] = l.trim().split(/\s+/); if (createHash("sha256").update(readFileSync(join(O, "step3/questions", f))).digest("hex") !== h) throw new Error("FROZEN mismatch " + f); }
const parseSrc = (s) => { const m = /^(.+):(\d+)-(\d+)$/.exec(s); return { path: m[1], a: +m[2], b: +m[3] }; };
const ov = (a1, b1, a2, b2) => a1 <= b2 && a2 <= b1;
const Q = [];
for (const [set, dir] of [["plain", "step2/questions"], ["reworded", "step3/questions"]]) for (const repo of REPOS)
  for (const q of JSON.parse(readFileSync(join(O, dir, repo + ".json"), "utf8"))) Q.push({ id: q.id, question: q.question, set, repo, srcs: q.sources.map(parseSrc) });
const SIZES = { "1x": (r) => join(O, "step2/root", r, "lroot"), big: (r) => join(O, "step4", r + "-big/lroot") };
const toHits = (res) => res.map((h) => (h.chunk ? { path: h.path, a: h.chunk.startLine + 1, b: h.chunk.endLine + 1 } : { path: h.path, a: 1, b: Infinity }));
const isGold = (h, q) => q.srcs.some((s) => s.path === h.path && ov(h.a, h.b, s.a, s.b));
const ranksOf = (hits, q) => q.srcs.map((s) => { const i = hits.findIndex((h) => h.path === s.path && ov(h.a, h.b, s.a, s.b)); return i < 0 ? null : i + 1; });
const m4 = JSON.parse(readFileSync(join(O, "step4/m4/results.json"), "utf8")).rows;
const R = []; // one row per (size,question)
for (const [size, rootOf] of Object.entries(SIZES)) for (const repo of REPOS) {
  const root = rootOf(repo), F = new LiteCtx({ root, embeddings: true }), B = new LiteCtx({ root, embeddings: false });
  const db = new Database(join(root, ".litectx/index.db"), { readonly: true });
  for (const q of Q.filter((x) => x.repo === repo)) {
    const fres = await F.recall(q.question, { kind: "doc", n: 400, log: false }), bres = await B.recall(q.question, { kind: "doc", n: 400, log: false });
    const f20 = toHits(await F.recall(q.question, { kind: "doc", n: 20, log: false }));
    const fh = toHits(fres), bh = toHits(bres);
    const ref = m4.find((r) => r.size === size && r.id === q.id).direct.map((x) => (x === "inf" ? null : x));
    const mine = ranksOf(f20, q);
    const sanity = JSON.stringify(mine) === JSON.stringify(ref) && JSON.stringify(ranksOf(fh, q).map((x) => (x && x <= 20 ? x : null))) === JSON.stringify(ref);
    const first = (a) => { const f = a.filter((x) => x !== null); return f.length ? Math.min(...f) : null; };
    const fr = ranksOf(fh, q), br = ranksOf(bh, q);
    // gold sections in the index (all doc_sections rows overlapping a source range), with their BM25 rank (pool = 400)
    const secs = db.prepare("SELECT n.path path, n.start_line+1 a, n.end_line+1 b, n.symbol sym FROM doc_sections sec JOIN nodes n ON n.id=sec.node_id").all();
    const goldSecs = secs.filter((s) => q.srcs.some((g) => g.path === s.path && ov(s.a, s.b, g.a, g.b))).map((s) => {
      const bi = bh.findIndex((h) => h.path === s.path && h.a === s.a && h.b === s.b), fi = fh.findIndex((h) => h.path === s.path && h.a === s.a && h.b === s.b);
      return { ...s, bm25Rank: bi < 0 ? null : bi + 1, fusedRank: fi < 0 ? null : fi + 1 };
    });
    R.push({ size, id: q.id, set: q.set, repo, question: q.question, kw: keywords(q.question), srcs: q.srcs, sanity, fusedRanks: fr, bm25Ranks: br, fusedFirst: first(fr), bm25First: first(br), poolSize: bh.length,
      top20: fh.slice(0, 20).map((h) => ({ path: h.path, a: h.a, gold: isGold(h, q) })), goldSecs });
  }
  db.close(); F.close(); B.close();
}
const bad = R.filter((r) => !r.sanity); console.log("SANITY mismatches:", bad.length, bad.map((r) => r.size + ":" + r.id));
if (bad.length) { writeFileSync(join(OUT, "results.json"), JSON.stringify({ sanityFail: bad }, null, 1)); process.exit(2); }
// CLI pointer output sizes (real stdout)
const bin = join(process.cwd(), "bin/litectx.js");
for (const r of R) { r.cli = {}; for (const n of NS) { const out = execFileSync("node", [bin, "recall", "--root", SIZES[r.size](r.repo), "--kind", "doc", "-n", String(n), "--no-log", r.question], { encoding: "utf8" }); r.cli[n] = { bytes: Buffer.byteLength(out), lines: out.split("\n").filter(Boolean).length }; } }
writeFileSync(join(OUT, "results.json"), JSON.stringify(R, null, 1));
console.log("done");
