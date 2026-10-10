// POC: sequential per-text embedding speed for one config (one process = one pipeline).
// Usage: node poc/embed-speed-threads.mjs <sections.json> <stride> <threads|0=default> <cap|512> <batch|1> <vecOut.bin>
// Prints one JSON line. Run under taskset by the driver. Head cap 6000 chars as the shipped embedder does.
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
const [sj, stride, threads, cap, batch, vout] = process.argv.slice(2);
const all = JSON.parse(readFileSync(sj, "utf8"));
const texts = all.filter((_, i) => i % +stride === 0).map((t) => (t || " ").slice(0, 6000));
const tf = await import("@huggingface/transformers");
const tl0 = performance.now();
const pipe = await tf.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8", ...(+threads ? { session_options: { intra_op_num_threads: +threads } } : {}) });
const loadMs = performance.now() - tl0;
const O = { pooling: "mean", normalize: true };
if (+cap !== 512) pipe.tokenizer._tokenizerConfig.model_max_length = +cap;
for (const w of ["warm up one", "warm up two two", texts[0], texts[1]]) await pipe(w, O);
const bs = +batch;
let order = texts.map((_, i) => i);
if (bs > 1) order.sort((a, b) => texts[a].length - texts[b].length);
const vecs = new Float32Array(texts.length * 384);
const l0 = os.loadavg()[0];
const c0 = process.cpuUsage();
const t0 = performance.now();
for (let i = 0; i < order.length; i += bs) {
  const idx = order.slice(i, i + bs);
  const r = await pipe(idx.map((k) => texts[k]), O);
  for (let j = 0; j < idx.length; j++) vecs.set(r.data.subarray(j * 384, (j + 1) * 384), idx[j] * 384);
}
const ms = performance.now() - t0;
const cu = process.cpuUsage(c0); const cpuX = +((cu.user + cu.system) / 1000 / ms).toFixed(2); // CPU-seconds per wall-second (~threads actually busy)
if (vout) writeFileSync(vout, Buffer.from(vecs.buffer));
console.log(JSON.stringify({ n: texts.length, threads: +threads, cap: +cap, batch: bs, loadMs: Math.round(loadMs), ms: Math.round(ms), cpuX, secPerS: +(texts.length / (ms / 1000)).toFixed(2) }));
