// POC: does splitting sections across P independent worker_threads (each with its own q8 pipeline, default threads,
// sequential per section) beat one pipeline? Usage: node poc/embed-speed-parallel.mjs <sections.json> <stride> <P> <refVecs.bin|-> [pin cpulist note]
// Same sample + 6000-char head cap as embed-speed-threads.mjs. Round-robin split (i % P) for balance. Wall timed from a
// start barrier (after every worker has loaded + warmed) to last result. Verifies vs refVecs.bin (f32 x384 per text, same order).
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";

if (!isMainThread) {
  const tf = await import("@huggingface/transformers");
  const pipe = await tf.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
  const O = { pooling: "mean", normalize: true };
  for (const w of ["warm up one", "warm up two two", workerData.texts[0], workerData.texts[1] ?? "x"]) await pipe(w, O);
  parentPort.postMessage({ ready: true });
  await new Promise((res) => parentPort.once("message", res)); // go
  const c0 = process.cpuUsage();
  const out = new Float32Array(workerData.texts.length * 384);
  for (let i = 0; i < workerData.texts.length; i++) out.set((await pipe(workerData.texts[i], O)).data, i * 384);
  const cu = process.cpuUsage(c0);
  parentPort.postMessage({ done: true, out, cpuMs: (cu.user + cu.system) / 1000 }, [out.buffer]);
} else {
  const [sj, stride, Ps, ref] = process.argv.slice(2);
  const P = +Ps;
  const all = JSON.parse(readFileSync(sj, "utf8"));
  const texts = all.filter((_, i) => i % +stride === 0).map((t) => (t || " ").slice(0, 6000));
  const slices = Array.from({ length: P }, () => ({ idx: [], texts: [] }));
  texts.forEach((t, i) => { slices[i % P].idx.push(i); slices[i % P].texts.push(t); });
  const workers = slices.map((s) => new Worker(new URL(import.meta.url), { workerData: { texts: s.texts } }));
  await Promise.all(workers.map((w) => new Promise((res, rej) => { w.once("message", res); w.once("error", rej); })));
  const rssReady = process.memoryUsage().rss;
  const c0 = process.cpuUsage(); const t0 = performance.now();
  const results = await Promise.all(workers.map((w) => new Promise((res, rej) => { w.once("message", res); w.once("error", rej); w.postMessage("go"); })));
  const ms = performance.now() - t0; const cu = process.cpuUsage(c0);
  const vecs = new Float32Array(texts.length * 384);
  results.forEach((r, p) => slices[p].idx.forEach((k, j) => vecs.set(r.out.subarray(j * 384, (j + 1) * 384), k * 384)));
  let minCos = 1, ident = 0, cmp = 0;
  if (ref && ref !== "-") {
    const rb = readFileSync(ref); const rv = new Float32Array(rb.buffer, rb.byteOffset, rb.byteLength / 4);
    for (let k = 0; k < texts.length; k++) {
      let s = 0, same = true;
      for (let d = 0; d < 384; d++) { const a = vecs[k * 384 + d], b = rv[k * 384 + d]; s += a * b; if (a !== b) same = false; }
      if (same) ident++; if (s < minCos) minCos = s; cmp++;
    }
  }
  const rssPeak = process.memoryUsage().rss;
  console.log(JSON.stringify({ P, n: texts.length, ms: Math.round(ms), secPerS: +(texts.length / (ms / 1000)).toFixed(2), cpuX: +((cu.user + cu.system) / 1000 / ms).toFixed(2), rssReadyMB: Math.round(rssReady / 1048576), rssEndMB: Math.round(rssPeak / 1048576), minCos: +minCos.toFixed(7), bitIdentical: `${ident}/${cmp}` }));
  await Promise.all(workers.map((w) => w.terminate()));
}
