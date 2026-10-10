// POC: batching / threads / truncation for the transformers.js MiniLM pipeline. Usage: node poc/embed-speed-batch.mjs <sections.json> [N]
import { readFileSync } from "node:fs";
const texts0 = JSON.parse(readFileSync(process.argv[2], "utf8"));
const N = +(process.argv[3] ?? texts0.length);
const texts = texts0.filter((_, i) => i % Math.ceil(texts0.length / N) === 0).map((t) => (t || " ").slice(0, 6000));
const tf = await import("@huggingface/transformers");
console.log("onnx env:", JSON.stringify({ numThreads: tf.env.backends.onnx.wasm?.numThreads, backends: Object.keys(tf.env.backends) }));
const threads = process.env.THREADS ? +process.env.THREADS : undefined;
const mk = async (opts = {}) => tf.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8", ...opts });
const pipe = await mk(threads ? { session_options: { intra_op_num_threads: threads } } : {});
const vecs = async (arr, bs, extra = {}) => { const out = []; for (let i = 0; i < arr.length; i += bs) { const r = await pipe(arr.slice(i, i + bs), { pooling: "mean", normalize: true, ...extra }); const d = r.data, D = r.dims[1] === undefined ? 384 : r.dims[r.dims.length - 1]; for (let j = 0; j < r.dims[0]; j++) out.push(d.slice(j * D, (j + 1) * D)); } return out; };
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
await pipe("warmup", { pooling: "mean", normalize: true });
const time = async (f) => { const t = performance.now(); const r = await f(); return [performance.now() - t, r]; };
const seq = []; // sequential reference (single text per call, as shipped)
const [tSeq, ref] = await time(async () => { for (const t of texts) { const r = await pipe(t, { pooling: "mean", normalize: true }); seq.push(Float32Array.from(r.data)); } return seq; });
console.log(`N=${texts.length} threads=${threads ?? "default"} sequential: ${(tSeq / 1000).toFixed(1)}s ${(texts.length / (tSeq / 1000)).toFixed(1)} sec/s`);
const order = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
for (const sorted of [false, true]) for (const bs of (process.env.BS ?? "1,8,32,64").split(",").map(Number)) {
  const arr = sorted ? order.map((i) => texts[i]) : texts;
  const [t, v] = await time(() => vecs(arr, bs));
  let min = 1; for (let k = 0; k < arr.length; k++) { const orig = sorted ? order[k] : k; min = Math.min(min, cos(v[k], ref[orig])); }
  console.log(`bs=${bs} sorted=${sorted}: ${(t / 1000).toFixed(1)}s ${(texts.length / (t / 1000)).toFixed(1)} sec/s speedup=${(tSeq / t).toFixed(2)}x minCos=${min.toFixed(6)}`);
}
// truncation at tokenizer
for (const ml of (process.env.TRUNC === "0" ? [] : [128, 256, 512])) {
  const [t, v] = await time(() => vecs(texts, 1, { truncation: true, max_length: ml }));
  let min = 1; let sum = 0; for (let k = 0; k < texts.length; k++) { const c = cos(v[k], ref[k]); min = Math.min(min, c); sum += c; }
  console.log(`bs=1 tokenizer max_length=${ml}: ${(t / 1000).toFixed(1)}s speedup=${(tSeq / t).toFixed(2)}x minCos=${min.toFixed(6)} meanCos=${(sum / texts.length).toFixed(6)}`);
}
