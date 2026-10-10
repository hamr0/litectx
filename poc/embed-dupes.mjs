// POC: exact-duplicate section texts (after the embedder's 6000-char head cap). Usage: node poc/embed-dupes.mjs <corpusDir> <sections.json>
import { chunkAndImports } from "../src/chunker.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
const [root, sj] = process.argv.slice(2);
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const secs = []; // from re-chunking the corpus (file attribution)
for (const f of walk(root).filter((p) => p.endsWith(".md")).sort()) {
  const r = await chunkAndImports(relative(root, f), readFileSync(f, "utf8"));
  for (const c of r.chunks) secs.push({ f, t: (c.text || " ").slice(0, 6000) });
}
const rec = JSON.parse(readFileSync(sj, "utf8")).map((t) => (t || " ").slice(0, 6000));
const rs = new Set(rec); let multiset = new Map(); for (const t of rec) multiset.set(t, (multiset.get(t) || 0) + 1);
const sm = new Map(); for (const s of secs) sm.set(s.t, (sm.get(s.t) || 0) + 1);
let same = secs.length === rec.length; for (const [k, v] of multiset) if (sm.get(k) !== v) same = false;
console.log("recorded", rec.length, "rechunked", secs.length, "same multiset:", same);
const uniq = rs.size; console.log("unique", uniq, "skippable", rec.length - uniq, ((rec.length - uniq) / rec.length * 100).toFixed(1) + "%");
const by = new Map(); for (const s of secs) { if (!by.has(s.t)) by.set(s.t, []); by.get(s.t).push(s.f); }
let within = 0, across = 0, extraWithin = 0, extraAcross = 0;
for (const [t, fs] of by) { if (fs.length < 2) continue; const first = new Set(); let seen = new Set();
  // a dup occurrence is "within-file" if its file already produced this text earlier; else "across-file" (first-seen in another file)
  fs.forEach((f, i) => { if (i === 0) { seen.add(f); return; } if (seen.has(f)) extraWithin++; else { extraAcross++; seen.add(f); } }); }
console.log("skippable duplicates: within-file", extraWithin, "across-file", extraAcross);
const top = [...by].filter(([, f]) => f.length > 1).sort((a, b) => b[1].length - a[1].length).slice(0, 5);
for (const [t, f] of top) console.log(f.length, "files", new Set(f).size, JSON.stringify(t.slice(0, 80)));
const chars = rec.reduce((a, t) => a + t.length, 0), uc = [...rs].reduce((a, t) => a + t.length, 0);
console.log("chars total", chars, "unique", uc, "skippable-char%", ((chars - uc) / chars * 100).toFixed(1));
