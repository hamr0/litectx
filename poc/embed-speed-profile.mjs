// POC: where does embeddings-ON index() time go? Usage: node poc/embed-speed-profile.mjs <corpusDir> <outDir> [off]
import { LiteCtx } from "../src/index.js";
import { Embedder } from "../src/embedder.js";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [corpus, out, mode] = process.argv.slice(2);
const on = mode !== "off";
mkdirSync(out, { recursive: true });
const real = new Embedder();
const calls = [];
let tLoad = 0;
if (on) { const t = performance.now(); await real._pipeline(); tLoad = performance.now() - t; await real.embed('warm-up call'); await real.embed('another warm-up call'); }
const embedder = { async embed(text) { const t = performance.now(); const v = await real.embed(text); calls.push({ len: text.length, ms: performance.now() - t, text }); return v; } };
const db = join(out, "index.db"); rmSync(db, { force: true });
const ctx = new LiteCtx({ root: corpus, dbPath: db, embeddings: on, embedder: on ? embedder : undefined });
const t0 = performance.now();
const r = await ctx.index();
const total = performance.now() - t0;
const embMs = calls.reduce((a, c) => a + c.ms, 0);
const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))];
const ms = calls.map((c) => c.ms);
console.log(JSON.stringify({ on, modelLoadMs: Math.round(tLoad), totalIndexMs: Math.round(total), embedMs: Math.round(embMs), nonEmbedMs: Math.round(total - embMs), nCalls: calls.length, meanMs: +(embMs / (calls.length || 1)).toFixed(1), p50: +(q(ms, .5) || 0).toFixed(1), p95: +(q(ms, .95) || 0).toFixed(1), result: r }));
if (on) {
  writeFileSync(join(out, "sections.json"), JSON.stringify(calls.map((c) => c.text)));
  // scaling by length bucket
  const b = [[0, 200], [200, 500], [500, 1000], [1000, 2000], [2000, 4000], [4000, 6000], [6000, 1e9]];
  for (const [lo, hi] of b) { const s = calls.filter((c) => c.len >= lo && c.len < hi); if (s.length) console.log(`len ${lo}-${hi}: n=${s.length} meanMs=${(s.reduce((a, c) => a + c.ms, 0) / s.length).toFixed(1)}`); }
  const lens = calls.map((c) => c.len); const tot = lens.reduce((a, b) => a + b, 0);
  console.log("sections", lens.length, "chars mean", Math.round(tot / lens.length), "p50", q(lens, .5), "p95", q(lens, .95), "max", Math.max(...lens), ">6000:", lens.filter((l) => l > 6000).length, ">~2000(≈512tok):", lens.filter((l) => l > 2000).length);
}
