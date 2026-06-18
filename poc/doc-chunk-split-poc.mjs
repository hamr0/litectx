// THROWAWAY POC — headless-PDF chunk-granularity fix (follow-up to doc-ingest-poc).
//
// FINDING that drives this (peek.mjs, real data): pdfjs getTextContent emits 63 lines,
// ZERO blank lines — paragraph boundaries are NOT marked. And chunkMarkdown splits ONLY
// on `#` headings (chunker.js:204), never on blank lines. So a headless PDF is ONE chunk
// of 4709 chars no matter how we space it. Recall then returns the whole blob for every
// query — no targeting.
//
// Question (prove-don't-assert, must be able to FAIL): does grouping the flat lines into
// size-budgeted segments give recall a TIGHTER, still-complete unit than (a) the 1-chunk
// blob and (b) the naive split-every-line? Measure the diff; don't assert it.
//
// Strategies compared:
//   WHOLE   — current behavior: 1 unit (the blob).
//   PERLINE — split every line: 63 tiny units (the "split by line" the user asked to try).
//   PACK-N  — adaptive: atoms = blank-line paragraphs if the text has them (>1 block),
//             else lines; greedily packed into <=budget-char segments. Swept over budgets.
//
// Recall is the REAL shipped lib: each segment is written as its own .md and indexed via
// LiteCtx, so BM25 scores per-unit exactly as it would per-chunk. Metric per query:
//   top-hit size (chars) + query-term coverage in the top hit (of K content terms).
//   Best = SMALL size AND HIGH coverage (the answer stays together in one tight unit).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { LiteCtx } from "../src/index.js";

const log = (...a) => console.log(...a);
let failures = 0;
const assert = (label, cond) => { log(`  [${cond ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}] ${label}`); if (!cond) failures++; };

// --- fixture: real PDF from genuine repo prose (same source as doc-ingest-poc) ----------
const work = mkdtempSync(join(tmpdir(), "litectx-chunk-split-"));
const prd = readFileSync(new URL("../docs/01-product/benches-prd.md", import.meta.url), "utf8");
const srcLines = prd.split("\n").slice(0, 70).map((l) => l.replace(/^>\s?/, ""));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = ["<!doctype html><html><head><meta charset=utf-8></head><body>"];
for (const raw of srcLines) {
  const l = raw.trimEnd();
  const h = /^(#{1,6})\s+(.*)/.exec(l);
  if (h) html.push(`<h${h[1].length}>${esc(h[2])}</h${h[1].length}>`);
  else if (l.trim()) html.push(`<p>${esc(l)}</p>`);
}
html.push("</body></html>");
const hp = join(work, "s.html");
writeFileSync(hp, html.join("\n"));
execFileSync("libreoffice", ["--headless", "--convert-to", "pdf", "--outdir", work, hp], { stdio: "pipe" });

const doc = await getDocument({ data: new Uint8Array(readFileSync(join(work, "s.pdf"))) }).promise;
const lines = [];
for (let p = 1; p <= doc.numPages; p++) {
  const c = await (await doc.getPage(p)).getTextContent();
  let line = "";
  for (const it of c.items) { line += it.str; if (it.hasEOL) { lines.push(line); line = ""; } }
  if (line) lines.push(line);
}
const flatMd = lines.join("\n");
log(`fixture: ${doc.numPages} pages, ${lines.length} lines, ${flatMd.length} chars, blank-lines=${lines.filter((l) => !l.trim()).length}`);

// --- the candidate fix --------------------------------------------------------------
/**
 * Split heading-less markdown into size-budgeted segments.
 * Atoms = blank-line paragraphs when the text actually has them (>1 block); otherwise
 * the text is flat (PDF case) → atoms = lines. Atoms are greedily packed up to `budget`
 * chars, breaking only at atom boundaries (never mid-line).
 */
function splitHeadless(md, { budget = 800 } = {}) {
  const blocks = md.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const atoms = blocks.length > 1 ? blocks : md.split("\n").map((s) => s.trim()).filter(Boolean);
  const segs = [];
  let cur = "";
  for (const a of atoms) {
    if (cur && cur.length + 1 + a.length > budget) { segs.push(cur); cur = a; }
    else cur = cur ? cur + "\n" + a : a;
  }
  if (cur) segs.push(cur);
  return segs;
}

// --- recall harness: index segments as per-unit .md, score one query ----------------
const tok = (s) => [...new Set((s.toLowerCase().match(/[a-z0-9-]{4,}/g) ?? []))];
async function measure(tag, segments, queries) {
  const root = join(work, "root-" + tag.replace(/[^a-z0-9]/gi, ""));
  mkdirSync(root, { recursive: true });
  segments.forEach((s, i) => writeFileSync(join(root, `seg-${String(i).padStart(3, "0")}.md`), s));
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const sizes = segments.map((s) => s.length).sort((a, b) => a - b);
  const out = { tag, units: segments.length, median: sizes[sizes.length >> 1] ?? 0, max: sizes.at(-1) ?? 0, q: [] };
  for (const q of queries) {
    const hits = await ctx.recall(q, { kind: "doc", body: true, log: false });
    const body = (hits[0]?.body ?? "").toLowerCase();
    const qt = tok(q);
    const cover = qt.filter((t) => body.includes(t)).length / qt.length;
    out.q.push({ chars: hits[0]?.body?.length ?? 0, cover });
  }
  return out;
}

// Queries whose answer terms are SPREAD across adjacent lines (so per-line scatters them).
const QUERIES = [
  "harvest the real-work traces fabro shell rebuilding", // spans lines 12-13
  "redundant realwork-bench deliberately unbuilt validation suite ships", // spans lines 15-17
];

const strategies = [
  ["WHOLE", [flatMd]],
  ["PERLINE", lines.map((l) => l.trim()).filter(Boolean)],
  ["PACK-500", splitHeadless(flatMd, { budget: 500 })],
  ["PACK-800", splitHeadless(flatMd, { budget: 800 })],
  ["PACK-1200", splitHeadless(flatMd, { budget: 1200 })],
];

log("\nstrategy     units  median  max    | q1 chars/cover   q2 chars/cover");
const rows = [];
for (const [tag, segs] of strategies) {
  const r = await measure(tag, segs, QUERIES);
  rows.push(r);
  const q = r.q.map((x) => `${String(x.chars).padStart(4)}/${x.cover.toFixed(2)}`).join("   ");
  log(`${tag.padEnd(12)} ${String(r.units).padStart(4)}  ${String(r.median).padStart(5)}  ${String(r.max).padStart(5)}   | ${q}`);
}

// --- verdict: PACK beats both WHOLE (targeting) and PERLINE (keeps answer together) ----
log("");
const whole = rows.find((r) => r.tag === "WHOLE");
const perline = rows.find((r) => r.tag === "PERLINE");
const pack = rows.find((r) => r.tag === "PACK-800");

// 1. PACK targets tighter than the blob: smaller top-hit, on every query.
assert("PACK top-hit is smaller than WHOLE blob (better targeting)", pack.q.every((x, i) => x.chars < whole.q[i].chars));
// 2. PACK keeps the answer whole: full term coverage in the single top hit.
assert("PACK top-hit still covers all query terms (answer not lost)", pack.q.every((x) => x.cover === 1));
// 3. PERLINE scatters: at least one query loses coverage vs PACK (terms split across line-units).
assert("PERLINE scatters the answer (coverage drops below PACK on >=1 query)", perline.q.some((x, i) => x.cover < pack.q[i].cover));
// 4. PACK produces a sane unit count (not 1, not 63) for this 3-page doc.
assert("PACK yields a sane unit count (1 < units < line-count)", pack.units > 1 && pack.units < lines.length);

rmSync(work, { recursive: true, force: true });
log(`\n${failures === 0 ? "\x1b[32m✔ PASSED" : "\x1b[31m✘ FAILED"} — ${failures} failed assertion(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
