// POC: interleaved, repeated timing of batching/truncation knobs + cosine-drift diagnosis. Usage: node poc/embed-speed-knobs.mjs <sections.json> [N] ; env THREADS, DTYPE
import { readFileSync } from "node:fs";
const all = JSON.parse(readFileSync(process.argv[2], "utf8"));
const N = +(process.argv[3] ?? 100);
const texts = all.filter((_, i) => i % Math.ceil(all.length / N) === 0).map((t) => (t || " ").slice(0, 6000));
const tf = await import("@huggingface/transformers");
const threads = process.env.THREADS ? +process.env.THREADS : undefined;
const dtype = process.env.DTYPE ?? "q8";
const pipe = await tf.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype, ...(threads ? { session_options: { intra_op_num_threads: threads } } : {}) });
const O = { pooling: "mean", normalize: true };
const run = async (arr, bs) => { const out = []; for (let i = 0; i < arr.length; i += bs) { const r = await pipe(arr.slice(i, i + bs), O); for (let j = 0; j < r.dims[0]; j++) out.push(r.data.slice(j * 384, (j + 1) * 384)); } return out; };
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
const sortedT = order.map((i) => texts[i]);
console.log("tokenizer model_max_length", pipe.tokenizer.model_max_length);
await pipe("warm", O);
const ref = await run(texts, 1);
const refSorted = order.map((i) => ref[i]);
const cfgs = [
  ["seq (shipped)", () => run(texts, 1), ref],
  ["batch8 unsorted", () => run(texts, 8), ref],
  ["batch32 unsorted", () => run(texts, 32), ref],
  ["batch8 sorted", () => run(sortedT, 8), refSorted],
  ["batch32 sorted", () => run(sortedT, 32), refSorted],
  ["seq maxlen256", async () => { pipe.tokenizer._tokenizerConfig.model_max_length = 256; const r = await run(texts, 1); pipe.tokenizer._tokenizerConfig.model_max_length = 512; return r; }, ref],
  ["seq maxlen128", async () => { pipe.tokenizer._tokenizerConfig.model_max_length = 128; const r = await run(texts, 1); pipe.tokenizer._tokenizerConfig.model_max_length = 512; return r; }, ref],
];
console.log(`N=${texts.length} dtype=${dtype} threads=${threads ?? "default"} load1=${(await import("node:os")).loadavg()[0].toFixed(1)}`);
for (let round = 1; round <= 2; round++) for (const [name, f, refv] of cfgs) {
  const t = performance.now(); const v = await f(); const ms = performance.now() - t;
  let min = 1, sum = 0; for (let k = 0; k < v.length; k++) { const c = cos(v[k], refv[k]); min = Math.min(min, c); sum += c; }
  console.log(`r${round} ${name.padEnd(18)} ${(ms / 1000).toFixed(1).padStart(5)}s ${(texts.length / (ms / 1000)).toFixed(1).padStart(5)} sec/s minCos=${min.toFixed(5)} meanCos=${(sum / v.length).toFixed(5)}`);
}
// drift diagnosis: batch of 8 equal-text copies (no padding) vs single
const t0 = texts[5]; const one = (await pipe(t0, O)).data; const eight = await pipe(Array(8).fill(t0), O);
console.log("8 identical texts (no padding) vs single: cos", cos(one, eight.data.slice(0, 384)).toFixed(6));
const pair = [texts[5], texts[order[0]]]; const pr = await pipe(pair, O); const s2 = (await pipe(pair[1], O)).data;
console.log("short text padded next to long vs alone: cos", cos(pr.data.slice(384, 768), s2).toFixed(6));
