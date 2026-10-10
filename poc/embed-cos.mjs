// Usage: node poc/embed-cos.mjs ref.bin other.bin -> min/mean cosine and bit-identical count
import { readFileSync } from "node:fs";
const rd = (p) => { const b = readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const a = rd(process.argv[2]), b = rd(process.argv[3]); let min = 1, sum = 0, ident = 0; const n = a.length / 384;
for (let i = 0; i < n; i++) { let s = 0, same = true; for (let k = 0; k < 384; k++) { s += a[i*384+k] * b[i*384+k]; if (a[i*384+k] !== b[i*384+k]) same = false; } if (same) ident++; min = Math.min(min, s); sum += s; }
console.log(JSON.stringify({ n, minCos: +min.toFixed(7), meanCos: +(sum / n).toFixed(7), bitIdentical: ident }));
