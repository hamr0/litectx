// THROWAWAY POC — tinymem probe, STAGE 3: the filing bake-off.
//
// Runs several filing methods over the frozen pieces (out/stage2/batch-*.jsonl) against the hand-labelled
// answer key (out/stage2/labels-*.jsonl) and scores them. Reads out/stage1/ + out/stage2/, writes out/stage3/:
//   results.json (every number, deterministic), timing.json (timings only), picks.jsonl (top 5 per piece per
//   method), report.md (tables, numbers only; also printed).
//
// ADD A METHOD: write one function `make(ctx) -> rank(text, kind, id) -> [[pageId, score], ...]` (sorted by
// score desc, ties by page id asc; score 0 / empty = no candidate; it may be async or return
// {notRun: "reason"}) and register it with ONE line in METHODS below. `id` is only for the scorer guards.
//
// Data root: env TINYMEM_PROBE_DIR (default ~/.cache/tinymem-probe). Flag: --no-embeddings.
// Session text is sensitive: this script never prints piece text or label notes, and never writes them out.
// Outputs hold ids, page ids, scores and counts only.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ROOT = process.env.TINYMEM_PROBE_DIR || join(homedir(), ".cache", "tinymem-probe");
const S1 = join(ROOT, "out", "stage1");
const S2 = join(ROOT, "out", "stage2");
const OUT = join(ROOT, "out", "stage3");
const SEED = "tinymem-stage3-v1";
const EXAMS = ["messy", "structured"];
const NO_EMBED = process.argv.includes("--no-embeddings");
const WORDS = "/usr/share/dict/words";
const WINDOW_CHARS = 1000; // round 3: window size for the `windows` representation

function fail(msg) {
  console.error(`tinymem-bakeoff-poc: ${msg}`);
  process.exit(1);
}

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const readJsonl = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const r6 = (x) => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------- data
function loadPages() {
  const pages = JSON.parse(readFileSync(join(S1, "pages.json"), "utf8"));
  pages.sort((a, b) => cmp(a.path, b.path)); // exactly as loadPages() in tinymem-sample-poc.mjs
  return pages.map((p, i) => ({ ...p, pid: "P" + String(i + 1).padStart(2, "0") }));
}

// Pack WHOLE lines into consecutive windows of at most WINDOW_CHARS characters (lines joined by "\n");
// a single longer line is its own window; empty / whitespace-only windows are dropped.
function splitWindows(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split("\n")) {
    if (cur === null) cur = line;
    else if (cur.length + 1 + line.length > WINDOW_CHARS) { out.push(cur); cur = line; }
    else cur += "\n" + line;
  }
  if (cur !== null) out.push(cur);
  return out.filter((w) => w.trim() !== "");
}

function loadAll() {
  const pages = loadPages();
  const manifest = JSON.parse(readFileSync(join(S2, "sample-manifest.json"), "utf8"));
  if (manifest.pageIds.length !== pages.length) fail("manifest page count differs from pages.json");
  for (let i = 0; i < pages.length; i++) {
    const m = manifest.pageIds[i];
    if (m.id !== pages[i].pid || m.path !== pages[i].path) fail(`page-id mapping disagrees with manifest at index ${i}`);
  }
  const docs = readJsonl(join(S1, "pieces-docs.jsonl"));
  const product = docs.filter((r) => r.bucket === "product");
  const byPath = new Map();
  for (const r of product) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path).push(r);
  }
  for (const p of pages) {
    const secs = (byPath.get(p.path) || []).slice().sort((a, b) => a.startLine - b.startLine);
    if (!secs.length) fail(`page ${p.pid} has no product sections`);
    p.sections = secs.map((s) => String(s.text ?? ""));
    p.fullText = p.sections.join("\n");
    p.windows = splitWindows(p.fullText);
    p.headingText = [p.name, ...p.headings.map((h) => h.title)].join("\n");
  }
  const pageIds = new Set(pages.map((p) => p.pid));

  const pieces = [];
  const labels = new Map();
  for (const exam of EXAMS) {
    for (const half of ["tune", "held"]) {
      const batch = readJsonl(join(S2, `batch-${exam}-${half}.jsonl`));
      const labs = readJsonl(join(S2, `labels-${exam}-${half}.jsonl`));
      const ids = new Set(batch.map((b) => b.id));
      if (ids.size !== batch.length) fail(`duplicate piece ids in batch-${exam}-${half}`);
      const lids = new Set();
      for (const l of labs) {
        if (lids.has(l.id)) fail(`duplicate label id in labels-${exam}-${half}`);
        lids.add(l.id);
        if (!ids.has(l.id)) fail(`label without a batch piece in ${exam}-${half}`);
        if (labels.has(l.id)) fail("label id appears in two files");
        if (l.page !== "none" && !pageIds.has(l.page)) fail("label page id not a known page");
        if (l.second != null && !pageIds.has(l.second)) fail("label second id not a known page");
        if (l.worth !== "keep" && l.worth !== "noise") fail("label worth not keep/noise");
        labels.set(l.id, { page: l.page, second: l.second ?? null, sure: l.sure === true, worth: l.worth });
      }
      for (const b of batch) {
        if (!lids.has(b.id)) fail(`batch piece without a label in ${exam}-${half}`);
        if (b.exam !== exam || b.half !== half) fail(`batch piece exam/half mismatch in ${exam}-${half}`);
        pieces.push({ id: b.id, exam, half, kind: b.kind, bytes: Buffer.byteLength(b.text, "utf8"), text: String(b.text ?? "") });
      }
    }
  }
  return { pages, pieces, labels };
}

// ---------------------------------------------------------------- shared helpers
const tokens = (text) => String(text).toLowerCase().match(/[a-z0-9_]{2,}/g) || [];

function sortPicks(list) {
  return list.filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
}

// ---------------------------------------------------------------- method 1: keys
const EXT = "js|mjs|cjs|ts|json|md|py|sh|yml|yaml";
function extractKeys(text) {
  const t = String(text);
  const keys = new Set();
  const add = (m) => { for (const x of m) keys.add(x.toLowerCase()); };
  // file paths: contains "/" and ends in a file extension
  add(t.match(/(?:[\w.@~-]+\/)+[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,5}(?![\w])/g) || []);
  // bare filenames with one of the listed extensions
  add(t.match(new RegExp(`(?<![\\w/.@-])[\\w-]+(?:\\.[\\w-]+)*\\.(?:${EXT})(?![\\w])`, "g")) || []);
  // backticked spans of 3..60 chars
  for (const m of t.matchAll(/`([^`\n]{3,60})`/g)) keys.add(m[1].toLowerCase());
  // ids: 1-3 capitals, optional "-", digits (digits required; see report note)
  add(t.match(/(?<![A-Za-z0-9])[A-Z]{1,3}-?\d+(?![A-Za-z0-9])/g) || []);
  // hyphenated lowercase names, two or more parts
  add(t.match(/(?<![A-Za-z0-9_-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![A-Za-z0-9_-])/g) || []);
  return keys;
}

function makeKeys(ctx, rep) {
  if (rep === "sections" || rep === "windows") return makeKeysSections(ctx, rep);
  const pageKeys = ctx.pages.map((p) => extractKeys(rep === "full" ? p.fullText : p.headingText));
  const df = new Map();
  for (const ks of pageKeys) for (const k of ks) df.set(k, (df.get(k) || 0) + 1);
  const limit = ctx.pages.length / 2;
  const weight = new Map();
  for (const [k, n] of df) if (n <= limit) weight.set(k, 1 / n); // keys on more than half the pages are ignored
  return (text) => {
    const pk = extractKeys(text);
    return sortPicks(ctx.pages.map((p, i) => {
      let s = 0;
      for (const k of pk) if (pageKeys[i].has(k) && weight.has(k)) s += weight.get(k);
      return [p.pid, s];
    }));
  };
}

// keys/sections: weight = 1 / (number of PAGES containing the key), same more-than-half-the-pages cut-off;
// a section scores the summed weight of distinct keys shared with the piece; a page scores its best section.
function makeKeysSections(ctx, field = "sections") {
  const secKeys = ctx.pages.map((p) => p[field].map((s) => extractKeys(s)));
  const df = new Map();
  for (const secs of secKeys) {
    const pageSet = new Set();
    for (const ks of secs) for (const k of ks) pageSet.add(k);
    for (const k of pageSet) df.set(k, (df.get(k) || 0) + 1);
  }
  const limit = ctx.pages.length / 2;
  const weight = new Map();
  for (const [k, n] of df) if (n <= limit) weight.set(k, 1 / n);
  return (text) => {
    const pk = extractKeys(text);
    return sortPicks(ctx.pages.map((p, i) => {
      let best = 0;
      for (const ks of secKeys[i]) {
        let s = 0;
        for (const k of pk) if (ks.has(k) && weight.has(k)) s += weight.get(k);
        if (s > best) best = s;
      }
      return [p.pid, best];
    }));
  };
}

// ---------------------------------------------------------------- methods 2/3: shingle, minhash
// Mirrors shingles() in liteagents remember/friction.cjs: unigrams of 3+ letters minus stopwords, plus adjacent bigrams.
const STOP = new Set([
  "the", "and", "you", "for", "not", "but", "was", "are", "get", "use", "one", "out",
  "can", "all", "any", "has", "had", "have", "this", "that", "with", "from", "what",
  "when", "where", "which", "there", "their", "would", "could", "should", "about",
  "been", "were", "they", "them", "then", "than", "these", "those", "some", "into",
  "only", "other", "also", "just", "more", "very", "here", "after", "before", "being",
  "doing", "make", "made", "like", "want", "need", "your", "dont", "did", "does",
  "done", "now", "yet", "too", "will", "wont", "cant", "got", "let",
]);
function shingleSet(text) {
  const u = (String(text).toLowerCase().match(/\b[a-z']{3,}\b/g) || []).filter((w) => !STOP.has(w));
  const s = new Set(u);
  for (let i = 0; i < u.length - 1; i++) s.add(u[i] + " " + u[i + 1]);
  return s;
}
const pageText = (p, rep) => (rep === "full" ? p.fullText : p.headingText);

function makeShingle(ctx, rep) {
  if (rep === "sections" || rep === "windows") return makeShingleSections(ctx, rep);
  const sets = ctx.pages.map((p) => shingleSet(pageText(p, rep)));
  return (text) => {
    const q = shingleSet(text);
    if (!q.size) return [];
    return sortPicks(ctx.pages.map((p, i) => {
      let n = 0;
      for (const x of q) if (sets[i].has(x)) n++;
      return [p.pid, n / q.size];
    }));
  };
}

function makeShingleSections(ctx, field = "sections") {
  const sets = ctx.pages.map((p) => p[field].map((s) => shingleSet(s)));
  return (text) => {
    const q = shingleSet(text);
    if (!q.size) return [];
    return sortPicks(ctx.pages.map((p, i) => {
      let best = 0;
      for (const set of sets[i]) {
        let n = 0;
        for (const x of q) if (set.has(x)) n++;
        const c = n / q.size;
        if (c > best) best = c;
      }
      return [p.pid, best];
    }));
  };
}

const NHASH = 128;
const fnv1a = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
};
const fmix = (h) => {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
};
const MH_SEEDS = Array.from({ length: NHASH }, (_, i) => parseInt(sha(`${SEED}:minhash:${i}`).slice(0, 8), 16) >>> 0);
function minhashSig(set) {
  const sig = new Uint32Array(NHASH).fill(0xffffffff);
  for (const x of set) {
    const h = fnv1a(x);
    for (let i = 0; i < NHASH; i++) {
      const v = fmix((h ^ MH_SEEDS[i]) >>> 0);
      if (v < sig[i]) sig[i] = v;
    }
  }
  return sig;
}
function makeMinhash(ctx, rep) {
  if (rep === "sections" || rep === "windows") return makeMinhashSections(ctx, rep);
  const pages = ctx.pages.map((p) => { const set = shingleSet(pageText(p, rep)); return { n: set.size, sig: minhashSig(set) }; });
  return (text) => {
    const q = shingleSet(text);
    if (!q.size) return [];
    const qs = minhashSig(q);
    return sortPicks(ctx.pages.map((p, i) => {
      let m = 0;
      for (let k = 0; k < NHASH; k++) if (qs[k] === pages[i].sig[k]) m++;
      const j = m / NHASH; // Jaccard estimate; containment of piece in page = inter/|piece|, inter = j/(1+j) * (|A|+|B|)
      const c = Math.min(1, (j / (1 + j)) * (q.size + pages[i].n) / q.size);
      return [p.pid, c];
    }));
  };
}

function makeMinhashSections(ctx, field = "sections") {
  const pages = ctx.pages.map((p) => p[field].map((s) => { const set = shingleSet(s); return { n: set.size, sig: minhashSig(set) }; }));
  return (text) => {
    const q = shingleSet(text);
    if (!q.size) return [];
    const qs = minhashSig(q);
    return sortPicks(ctx.pages.map((p, i) => {
      let best = 0;
      for (const sec of pages[i]) {
        let m = 0;
        for (let k = 0; k < NHASH; k++) if (qs[k] === sec.sig[k]) m++;
        const j = m / NHASH;
        const c = Math.min(1, (j / (1 + j)) * (q.size + sec.n) / q.size);
        if (c > best) best = c;
      }
      return [p.pid, best];
    }));
  };
}

// ---------------------------------------------------------------- method 4: bm25
function makeBm25(ctx, rep) {
  if (rep === "sections" || rep === "windows") return makeBm25Sections(ctx, rep);
  const K1 = 1.2, B = 0.75;
  const docs = ctx.pages.map((p) => {
    const tf = new Map();
    const toks = tokens(pageText(p, rep));
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { tf, len: toks.length };
  });
  const N = docs.length;
  const avg = docs.reduce((a, d) => a + d.len, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  return (text) => {
    const q = [...new Set(tokens(text))];
    return sortPicks(ctx.pages.map((p, i) => {
      let s = 0;
      for (const t of q) {
        const f = docs[i].tf.get(t);
        if (!f) continue;
        const n = df.get(t);
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * docs[i].len / avg));
      }
      return [p.pid, s];
    }));
  };
}

// bm25/sections: the documents are the sections (idf, length, average length over all sections); a page scores its best section.
function makeBm25Sections(ctx, field = "sections") {
  const K1 = 1.2, B = 0.75;
  const docs = ctx.pages.map((p) => p[field].map((s) => {
    const tf = new Map();
    const toks = tokens(s);
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { tf, len: toks.length };
  }));
  const all = docs.flat();
  const N = all.length;
  const avg = all.reduce((a, d) => a + d.len, 0) / N || 1;
  const df = new Map();
  for (const d of all) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  return (text) => {
    const q = [...new Set(tokens(text))];
    return sortPicks(ctx.pages.map((p, i) => {
      let best = 0;
      for (const d of docs[i]) {
        let s = 0;
        for (const t of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          const n = df.get(t);
          const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
          s += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / avg));
        }
        if (s > best) best = s;
      }
      return [p.pid, best];
    }));
  };
}

// ---------------------------------------------------------------- method 5: embed (variant embed/sections)
async function makeEmbed(ctx, field = "sections") {
  if (NO_EMBED) return { notRun: "skipped by --no-embeddings" };
  let pipe;
  try {
    const pkg = "@huggingface/transformers";
    const transformers = await import(pkg);
    pipe = await transformers.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
  } catch (e) {
    return { notRun: `could not load @huggingface/transformers or model: ${String(e && e.message).split("\n")[0].slice(0, 160)}` };
  }
  const embed = async (t) => {
    const out = await pipe((t || " ").slice(0, 1000), { pooling: "mean", normalize: true });
    return Float32Array.from(out.data);
  };
  const secs = [];
  for (const p of ctx.pages) for (const s of p[field]) secs.push({ pid: p.pid, v: await embed(s) });
  return async (text) => {
    const q = await embed(text);
    const best = new Map();
    for (const s of secs) {
      let d = 0;
      for (let i = 0; i < q.length; i++) d += q[i] * s.v[i];
      if (!best.has(s.pid) || d > best.get(s.pid)) best.set(s.pid, d);
    }
    return sortPicks([...best].map(([pid, d]) => [pid, d]));
  };
}

// ---------------------------------------------------------------- method 6: scorer guards
function makeOracle(ctx) {
  return (text, kind, id) => {
    const l = ctx.labels.get(id);
    return l && l.page !== "none" ? [[l.page, 1]] : [];
  };
}
function makeRandom(ctx) {
  const u = (id, pid) => (parseInt(sha(`${SEED}:${id}:${pid}`).slice(0, 8), 16) + 1) / (0xffffffff + 2);
  return (text, kind, id) => sortPicks(ctx.pages.map((p) => [p.pid, u(id, p.pid)]));
}

// ---------------------------------------------------------------- registry: one line per variant
const METHODS = [
  { name: "keys/full", make: (c) => makeKeys(c, "full") },
  { name: "keys/headings", make: (c) => makeKeys(c, "headings") },
  { name: "shingle/full", make: (c) => makeShingle(c, "full") },
  { name: "shingle/headings", make: (c) => makeShingle(c, "headings") },
  { name: "minhash/full", make: (c) => makeMinhash(c, "full") },
  { name: "minhash/headings", make: (c) => makeMinhash(c, "headings") },
  { name: "bm25/full", make: (c) => makeBm25(c, "full") },
  { name: "bm25/headings", make: (c) => makeBm25(c, "headings") },
  { name: "keys/sections", make: (c) => makeKeys(c, "sections") },
  { name: "shingle/sections", make: (c) => makeShingle(c, "sections") },
  { name: "minhash/sections", make: (c) => makeMinhash(c, "sections") },
  { name: "bm25/sections", make: (c) => makeBm25(c, "sections") },
  { name: "embed/sections", make: (c) => makeEmbed(c, "sections") },
  { name: "keys/windows", make: (c) => makeKeys(c, "windows") },
  { name: "shingle/windows", make: (c) => makeShingle(c, "windows") },
  { name: "minhash/windows", make: (c) => makeMinhash(c, "windows") },
  { name: "bm25/windows", make: (c) => makeBm25(c, "windows") },
  { name: "embed/windows", make: (c) => makeEmbed(c, "windows") },
  { name: "oracle", make: makeOracle },
  { name: "random", make: makeRandom },
];
const NOT_RUN_ROUND1 = ["static embeddings", "reranker", "model picks from top 5"];
const PAIR_BASE = ["keys/full", "shingle/full", "bm25/full", "embed/sections"];
const PAIR_BASE_SEC = ["keys/sections", "shingle/sections", "bm25/sections", "embed/sections"];
const PAIR_BASE_WIN = ["keys/windows", "shingle/windows", "bm25/windows", "embed/windows"];

// ---------------------------------------------------------------- scoring
const isRight = (pick, l) => pick != null && l.page !== "none" && (pick === l.page || pick === l.second);
const isStrict = (pick, l) => pick != null && l.page !== "none" && pick === l.page;
const hasPage = (l) => l.page !== "none";

function scoreA(rows, labels) {
  // rows: held pieces [{id, picks}]
  const out = { pieces: 0, withPage: 0, sure: 0 };
  const z = () => ({ first: 0, top5: 0, firstStrict: 0, top5Strict: 0 });
  out.all = z(); out.sureOnly = z();
  for (const r of rows) {
    const l = labels.get(r.id);
    if (!hasPage(l)) continue;
    out.withPage++;
    const top = r.picks.slice(0, 5).map((x) => x[0]);
    const f = isRight(top[0], l), t = top.some((p) => isRight(p, l));
    const fs = isStrict(top[0], l), ts = top.some((p) => isStrict(p, l));
    const add = (o) => { if (f) o.first++; if (t) o.top5++; if (fs) o.firstStrict++; if (ts) o.top5Strict++; };
    add(out.all);
    if (l.sure) { out.sure++; add(out.sureOnly); }
  }
  out.pieces = rows.length;
  return out;
}

function signalRows(rows, labels, signal) {
  return rows.map((r) => {
    const l = labels.get(r.id);
    const t1 = r.picks.length ? r.picks[0][1] : 0;
    const t2 = r.picks.length > 1 ? r.picks[1][1] : null;
    const att = r.picks.length > 0 && t1 > 0; // top1 of 0 / no candidate can never be attached
    let sig = 0;
    if (att) sig = signal === "score" ? t1 : t2 == null ? 1 : (t1 - t2) / t1;
    const top = r.picks.length ? r.picks[0][0] : null;
    return { att, sig, right: isRight(top, l), strict: isStrict(top, l), page: hasPage(l), keep: l.worth === "keep" };
  });
}

function pickThresholds(tune) {
  const cands = [...new Set(tune.filter((r) => r.att).map((r) => r.sig))].sort((a, b) => a - b);
  let t90 = null;
  for (const c of cands) {
    const s = tune.filter((r) => r.att && r.sig >= c);
    if (s.length >= 5 && s.filter((r) => r.right).length / s.length >= 0.9) { t90 = c; break; }
  }
  let t75 = null;
  const hi = t90 == null ? Infinity : t90;
  for (const c of cands) {
    if (!(c < hi)) break;
    const s = tune.filter((r) => r.att && r.sig >= c && r.sig < hi);
    if (s.length >= 5 && s.filter((r) => r.right).length / s.length >= 0.75) { t75 = c; break; }
  }
  return { t90, t75 };
}

function band(rows, lo, hi) {
  if (lo == null) return { attached: 0, right: 0, rightStrict: 0 };
  const s = rows.filter((r) => r.att && r.sig >= lo && r.sig < hi);
  return { attached: s.length, right: s.filter((r) => r.right).length, rightStrict: s.filter((r) => r.strict).length };
}

// attachedFn(row) -> bool. Returns the coverage block.
function coverage(rows, attachedFn) {
  const a = rows.filter(attachedFn);
  const keep = rows.filter((r) => r.keep), page = rows.filter((r) => r.page), none = rows.filter((r) => !r.page);
  return {
    heldPieces: rows.length,
    attached: a.length,
    attachedKeep: a.filter((r) => r.keep).length, keepTotal: keep.length,
    attachedWithPage: a.filter((r) => r.page).length, withPageTotal: page.length,
    noneNotAttached: none.filter((r) => !attachedFn(r)).length, noneTotal: none.length,
  };
}

function scoreB(tuneRows, heldRows) {
  const { t90, t75 } = pickThresholds(tuneRows);
  const hi = t90 == null ? Infinity : t90;
  const evalHalf = (rows) => {
    const conf = band(rows, t90, Infinity);
    const uns = band(rows, t75, hi);
    const inAny = (r) => r.att && ((t90 != null && r.sig >= t90) || (t75 != null && r.sig >= t75 && r.sig < hi));
    return { confident: conf, unsure: uns, coverage: coverage(rows, inAny) };
  };
  return { t90, t75, tune: evalHalf(tuneRows), held: evalHalf(heldRows) };
}

function scoreC(pa, pb, heldPieces, labels) {
  const rows = heldPieces.map((p) => {
    const l = labels.get(p.id);
    const a = pa[p.id][0], b = pb[p.id][0];
    const att = !!(a && b && a[1] > 0 && b[1] > 0 && a[0] === b[0]);
    return { att, right: att && isRight(a[0], l), strict: att && isStrict(a[0], l), page: hasPage(l), keep: l.worth === "keep" };
  });
  const att = rows.filter((r) => r.att);
  return { attached: att.length, right: att.filter((r) => r.right).length, rightStrict: att.filter((r) => r.strict).length, coverage: coverage(rows, (r) => r.att) };
}

// ---------------------------------------------------------------- D: keep or noise
const FUNCWORDS = new Set(("the of and to in is it that for on with as this be are was by at or from not have has an but they we you he " +
  "she his her their which will would can could should there what when where who how if then so do does did been").split(" "));

function loadDict() {
  if (!existsSync(WORDS)) return null;
  return new Set(readFileSync(WORDS, "utf8").split("\n").map((w) => w.trim().toLowerCase()).filter(Boolean));
}
const wordToks = (text) => String(text).toLowerCase().match(/[a-z]{2,}/g) || [];
const share = (toks, pred) => (toks.length ? toks.filter(pred).length / toks.length : 0);

function confusion(rows, pred) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  rows.forEach((r, i) => {
    if (pred[i]) { if (r.keep) tp++; else fp++; } else { if (r.keep) fn++; else tn++; }
  });
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const nrej = tn + fp ? tn / (tn + fp) : 0;
  return { tp, fp, fn, tn, keepRecall: recall, keepPrecision: tp + fp ? tp / (tp + fp) : 0, noiseRejected: nrej, balancedAccuracy: (recall + nrej) / 2 };
}

function chooseThreshold(vals, tuneRows, predAt) {
  const cands = [...new Set(vals)].sort((a, b) => a - b);
  let best = null, bestBA = -1;
  for (const c of cands) {
    const ba = confusion(tuneRows, predAt(c)).balancedAccuracy;
    if (ba > bestBA) { bestBA = ba; best = c; } // ties: lowest threshold
  }
  return best;
}

function scoreD(tune, held, dict) {
  const kindStats = {};
  for (const r of tune) { const k = (kindStats[r.kind] ||= { keep: 0, n: 0 }); k.n++; if (r.keep) k.keep++; }
  const overallKeep = tune.filter((r) => r.keep).length * 2 > tune.length;
  const kindPred = (r) => (kindStats[r.kind] ? kindStats[r.kind].keep * 2 > kindStats[r.kind].n : overallKeep); // tie -> noise
  const kindKeepPossible = (r) => !!kindStats[r.kind] && kindStats[r.kind].keep > 0;
  const out = {};
  const finish = (name, thr, predTune, predHeld) => {
    out[name] = { threshold: thr, tune: confusion(tune, tune.map(predTune)), held: confusion(held, held.map(predHeld)) };
  };
  finish("kind", null, kindPred, kindPred);
  if (dict) {
    for (const r of [...tune, ...held]) r.dw = share(r.toks, (w) => dict.has(w));
    const t = chooseThreshold(tune.map((r) => r.dw), tune, (c) => tune.map((r) => r.dw >= c));
    finish("dictwords", t, (r) => r.dw >= t, (r) => r.dw >= t);
  } else out.dictwords = "not run";
  for (const r of [...tune, ...held]) r.fw = share(r.toks, (w) => FUNCWORDS.has(w));
  const tf = chooseThreshold(tune.map((r) => r.fw), tune, (c) => tune.map((r) => r.fw >= c));
  finish("funcwords", tf, (r) => r.fw >= tf, (r) => r.fw >= tf);
  const tk = chooseThreshold(tune.map((r) => r.fw), tune, (c) => tune.map((r) => kindKeepPossible(r) && r.fw >= c));
  finish("kind+funcwords", tk, (r) => kindKeepPossible(r) && r.fw >= tk, (r) => kindKeepPossible(r) && r.fw >= tk);
  return out;
}

// ---------------------------------------------------------------- formatting
const pct = (n, d) => (d ? `${n}/${d} ${(100 * n / d).toFixed(1)}%` : `${n}/${d} n/a`);
const fx = (x) => (x == null ? "-" : String(r6(x)));
const bandCell = (b) => (b.attached ? pct(b.right, b.attached) : "empty");
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

function buildReport(R, timing) {
  let md = "# tinymem bake-off, stage 3\n\nNumbers only. Shares are count/total and percent.\n\n## Held-out sample sizes\n\n";
  md += table(["exam", "pieces", "have a page", "of those sure", "labelled keep"],
    EXAMS.map((e) => { const s = R.exams[e].heldSample; return [e, s.pieces, s.withPage, s.sure, s.keep]; })) + "\n";
  for (const e of EXAMS) {
    const X = R.exams[e];
    md += `\n## Exam: ${e}\n\n### A. Ranking quality (held, pieces that have a page: ${X.heldSample.withPage}; sure: ${X.heldSample.sure})\n\n`;
    const aRows = Object.entries(X.A).sort((a, b) => b[1].all.first - a[1].all.first || cmp(a[0], b[0]));
    md += table(["method", "first pick right", "right in top 5", "sure: first pick", "sure: top 5"],
      aRows.map(([n, a]) => [n, pct(a.all.first, a.withPage), pct(a.all.top5, a.withPage), pct(a.sureOnly.first, a.sure), pct(a.sureOnly.top5, a.sure)])) + "\n";

    md += `\n### B. Deciding when to attach (thresholds from tune only; held scored; ${X.heldSample.pieces} held pieces)\n\n`;
    const bAll = Object.entries(X.B);
    const nonEmpty = bAll.filter(([, b]) => b.t90 != null).sort((a, b) => b[1].held.coverage.attachedKeep - a[1].held.coverage.attachedKeep || cmp(a[0], b[0]));
    const empty = bAll.filter(([, b]) => b.t90 == null).sort((a, b) => b[1].held.coverage.attachedKeep - a[1].held.coverage.attachedKeep || cmp(a[0], b[0]));
    md += table(["row", "t90", "confident right", "t75", "unsure right", "cov all", "cov keep", "cov has-page", "correct none"],
      [...nonEmpty, ...empty].map(([n, b]) => {
        const c = b.held.coverage;
        return [n, fx(b.t90), bandCell(b.held.confident), fx(b.t75), bandCell(b.held.unsure), pct(c.attached, c.heldPieces),
          pct(c.attachedKeep, c.keepTotal), pct(c.attachedWithPage, c.withPageTotal), pct(c.noneNotAttached, c.noneTotal)];
      })) + "\n";

    md += "\n### C. Two signals agree (held)\n\n";
    md += table(["pair", "attached", "right", "cov all", "cov keep", "cov has-page", "correct none"],
      Object.entries(X.C).map(([n, c]) => c === "not run" ? [n, "not run", "", "", "", "", ""] :
        [n, `${c.attached}/${c.coverage.heldPieces}`, c.attached ? pct(c.right, c.attached) : "0/0 n/a", pct(c.coverage.attached, c.coverage.heldPieces),
          pct(c.coverage.attachedKeep, c.coverage.keepTotal), pct(c.coverage.attachedWithPage, c.coverage.withPageTotal), pct(c.coverage.noneNotAttached, c.coverage.noneTotal)])) + "\n";

    md += "\n### D. Keep or noise (thresholds from tune, held scored)\n\n";
    md += table(["rule", "threshold", "keep recall", "keep precision", "noise rejected", "balanced acc", "tp/fp/fn/tn"],
      Object.entries(X.D).map(([n, d]) => {
        if (d === "not run") return [n, "not run", "", "", "", "", ""];
        const h = d.held;
        return [n, fx(d.threshold), pct(h.tp, h.tp + h.fn), pct(h.tp, h.tp + h.fp), pct(h.tn, h.tn + h.fp), (100 * h.balancedAccuracy).toFixed(1) + "%", `${h.tp}/${h.fp}/${h.fn}/${h.tn}`];
      })) + "\n";

    md += "\n### F. Where first picks go (held)\n\n";
    const fc = (t, i) => (t[i] ? `${t[i][0]} ${t[i][1]}` : "-");
    md += table(["method", "1st", "2nd", "3rd", "no candidate"],
      Object.entries(X.F).map(([n, f]) => [n, fc(f.top, 0), fc(f.top, 1), fc(f.top, 2), f.noCandidate])) + "\n";
    md += `\nHeld pieces labelled with each of the three most-labelled pages: ${X.heldLabelled.map(([p, c]) => `${p} ${c}`).join(", ")}\n`;
  }
  md += "\n## E. Time (all 404 pieces)\n\n";
  md += table(["method", "index ms", "rank all ms", "MB/s of piece text"],
    Object.entries(timing.methods).map(([n, t]) => t === "not run" ? [n, "not run", "", ""] : [n, t.indexMs.toFixed(1), t.rankMs.toFixed(1), t.mbPerSec.toFixed(2)])) + "\n";
  md += "\n## NOT RUN\n\n";
  const nr = [...NOT_RUN_ROUND1.map((n) => `- ${n}: not implemented in round 1`),
    ...Object.entries(R.methodStatus).filter(([, s]) => s !== "ran").map(([n, s]) => `- ${n}: not run, ${s.reason}`)];
  const dictMissing = EXAMS.some((e) => R.exams[e].D.dictwords === "not run");
  if (dictMissing) nr.push(`- dictwords: not run, ${WORDS} missing`);
  return md + nr.join("\n") + "\n";
}

// ---------------------------------------------------------------- main
async function main() {
  for (const f of ["pages.json", "pieces-docs.jsonl"]) if (!existsSync(join(S1, f))) fail(`missing ${join(S1, f)}`);
  const ctx = loadAll();
  const { pieces, labels } = ctx;
  console.error(`loaded ${ctx.pages.length} pages, ${pieces.length} pieces`);

  const picks = {}; // variant -> id -> [[pid, score]]
  const timing = { methods: {}, pieces: pieces.length, pieceMB: pieces.reduce((a, p) => a + p.bytes, 0) / 1e6 };
  const methodStatus = {};
  for (const m of METHODS) {
    const t0 = performance.now();
    const rank = await m.make(ctx);
    const indexMs = performance.now() - t0;
    if (rank && rank.notRun) {
      methodStatus[m.name] = { status: "not run", reason: rank.notRun };
      timing.methods[m.name] = "not run";
      continue;
    }
    const t1 = performance.now();
    const res = {};
    for (const p of pieces) {
      const list = await rank(p.text, p.kind, p.id);
      res[p.id] = list.slice().sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
    }
    const rankMs = performance.now() - t1;
    picks[m.name] = res;
    methodStatus[m.name] = "ran";
    timing.methods[m.name] = { indexMs, rankMs, mbPerSec: timing.pieceMB / (rankMs / 1000) };
  }

  // guards
  for (const p of pieces) {
    const l = labels.get(p.id);
    if (hasPage(l) && !(picks.oracle[p.id][0] && picks.oracle[p.id][0][0] === l.page && picks.oracle[p.id][0][1] === 1)) fail("oracle does not score 100% first-pick: scorer is broken");
  }

  const R = { seed: SEED, methodStatus, notRunRound1: NOT_RUN_ROUND1.map((n) => ({ method: n, reason: "not implemented in round 1" })), exams: {} };
  const variants = Object.keys(picks);
  const dict = loadDict();
  for (const exam of EXAMS) {
    const tune = pieces.filter((p) => p.exam === exam && p.half === "tune");
    const held = pieces.filter((p) => p.exam === exam && p.half === "held");
    const hl = held.map((p) => labels.get(p.id));
    const X = { heldSample: { pieces: held.length, withPage: hl.filter(hasPage).length, sure: hl.filter((l) => hasPage(l) && l.sure).length, keep: hl.filter((l) => l.worth === "keep").length }, A: {}, B: {}, C: {}, D: {}, F: {}, heldLabelled: [] };
    for (const v of variants) {
      const rowsOf = (set) => set.map((p) => ({ id: p.id, picks: picks[v][p.id] }));
      X.A[v] = scoreA(rowsOf(held), labels);
      for (const sig of ["score", "margin"]) X.B[`${v}:${sig}`] = scoreB(signalRows(rowsOf(tune), labels, sig), signalRows(rowsOf(held), labels, sig));
    }
    for (const base of [PAIR_BASE, PAIR_BASE_SEC, PAIR_BASE_WIN]) for (let i = 0; i < base.length; i++) for (let j = i + 1; j < base.length; j++) {
      const [a, b] = [base[i], base[j]];
      X.C[`${a} + ${b}`] = picks[a] && picks[b] ? scoreC(picks[a], picks[b], held, labels) : "not run";
    }
    const top3 = (m) => [...m].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0])).slice(0, 3);
    for (const v of variants) {
      const cnt = new Map();
      let none = 0;
      for (const p of held) {
        const pk = picks[v][p.id];
        if (!pk.length) { none++; continue; }
        cnt.set(pk[0][0], (cnt.get(pk[0][0]) || 0) + 1);
      }
      X.F[v] = { top: top3(cnt), noCandidate: none };
    }
    const lc = new Map();
    for (const l of hl) if (hasPage(l)) lc.set(l.page, (lc.get(l.page) || 0) + 1);
    X.heldLabelled = top3(lc);
    const dRows = (set) => set.map((p) => ({ kind: p.kind, keep: labels.get(p.id).worth === "keep", toks: wordToks(p.text) }));
    X.D = scoreD(dRows(tune), dRows(held), dict);
    R.exams[exam] = X;

    // self-checks
    if (exam && labels.size !== pieces.length) fail("label count differs from piece count");
    for (const [n, b] of Object.entries(X.B)) for (const half of ["tune", "held"]) {
      const h = b[half];
      for (const k of ["confident", "unsure"]) if (h[k].right > h[k].attached) fail(`right > attached in ${n} ${half} ${k}`);
      if (h.coverage.attached > h.coverage.heldPieces) fail(`attached exceeds pieces in ${n} ${half}`);
      if (h.confident.attached + h.unsure.attached !== h.coverage.attached) fail(`band sum differs from attached in ${n} ${half}`);
    }
    for (const [n, c] of Object.entries(X.C)) if (c !== "not run" && (c.right > c.attached || c.attached > held.length)) fail(`bad counts in C ${n}`);
    const rnd = X.A.random;
    if (rnd.all.first / rnd.withPage > 0.25) fail(`random first-pick rate above 0.25 on ${exam} held (${rnd.all.first}/${rnd.withPage})`);
  }

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "results.json"), JSON.stringify(R, null, 2) + "\n");
  writeFileSync(join(OUT, "timing.json"), JSON.stringify(timing, null, 2) + "\n");
  const lines = [];
  for (const p of pieces) for (const v of variants) {
    lines.push(JSON.stringify({ id: p.id, exam: p.exam, half: p.half, method: v, top: picks[v][p.id].slice(0, 5).map(([pid, s]) => [pid, r6(s)]) }));
  }
  writeFileSync(join(OUT, "picks.jsonl"), lines.join("\n") + "\n");
  const report = buildReport(R, timing);
  writeFileSync(join(OUT, "report.md"), report);
  console.log(report);
}

main().catch((e) => fail(`unexpected error: ${e && e.message}`));
