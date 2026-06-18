// THROWAWAY POC — paragraph-aware packing for headless PDF (v2: realistic fixture).
//
// Ask: pack to ~800 chars, NEVER cut a paragraph — round a whole paragraph up or down so
// each segment holds complete paragraphs; chunk on paragraph boundaries.
//
// Blocker (proven): PDF text has no blank lines → paragraphs invisible. Signal = vertical
// GAP between lines (pdfjs transform[5]); inter-paragraph gap > intra-paragraph leading.
//
// v1 failed because the fixture made every source line its own <p> → no multi-line
// paragraphs → no leading baseline to contrast against. v2 reflows REAL PRD prose into
// genuine multi-sentence paragraphs (known boundaries) so detection is fairly testable.
//
// Prove-don't-assert (must be able to FAIL):
//   1. gap reconstruction recovers ~the known paragraph count (not 1, not per-line).
//   2. packing NEVER splits a real paragraph (only an over-budget atom may be line-packed).
//   3. recall returns a TIGHT unit with FULL query-term coverage (answer intact).

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { LiteCtx } from "../src/index.js";

const log = (...a) => console.log(...a);
let failures = 0;
const assert = (label, cond) => { log(`  [${cond ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}] ${label}`); if (!cond) failures++; };

// --- build a realistic fixture from REAL PRD prose ----------------------------------
const work = mkdtempSync(join(tmpdir(), "litectx-para-"));
const raw = readFileSync(new URL("../docs/01-product/litectx-memory-prd.md", import.meta.url), "utf8");
// strip markdown noise, keep real sentences
const clean = raw
  .replace(/```[\s\S]*?```/g, " ")
  .replace(/^[>#|*\-]+/gm, " ")
  .replace(/[*`_\[\]()]/g, "")
  .replace(/https?:\/\/\S+/g, "")
  .replace(/[ \t]+/g, " ");
const sentences = clean.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 40 && /[a-z]{4,}/.test(s));
// group ~4 sentences → one known paragraph; insert a heading every 3 paragraphs
const KNOWN_PARAS = [];
for (let i = 0; i + 4 <= sentences.length && KNOWN_PARAS.length < 12; i += 4) {
  KNOWN_PARAS.push(sentences.slice(i, i + 4).join(" "));
}
const htmlParts = ["<!doctype html><html><head><meta charset=utf-8></head><body>"];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
KNOWN_PARAS.forEach((p, i) => {
  if (i % 3 === 0) htmlParts.push(`<h2>Section ${i / 3 + 1}</h2>`);
  htmlParts.push(`<p>${esc(p)}</p>`);
});
htmlParts.push("</body></html>");
writeFileSync(join(work, "s.html"), htmlParts.join("\n"));
execFileSync("libreoffice", ["--headless", "--convert-to", "pdf", "--outdir", work, join(work, "s.html")], { stdio: "pipe" });
log(`fixture: ${KNOWN_PARAS.length} known paragraphs, sizes: ${KNOWN_PARAS.map((p) => p.length).join(", ")}`);

// --- extract lines WITH y-position --------------------------------------------------
const doc = await getDocument({ data: new Uint8Array(readFileSync(join(work, "s.pdf"))) }).promise;
/** @type {{text:string, y:number, page:number}[]} */
const lines = [];
for (let p = 1; p <= doc.numPages; p++) {
  const c = await (await doc.getPage(p)).getTextContent();
  let text = "", y = null;
  for (const it of c.items) {
    if (y === null) y = it.transform[5];
    text += it.str;
    if (it.hasEOL) { if (text.trim()) lines.push({ text: text.trim(), y, page: p }); text = ""; y = null; }
  }
  if (text.trim()) lines.push({ text: text.trim(), y, page: p });
}

// --- DIAGNOSTIC: look at the gap distribution before choosing a threshold ------------
const gaps = [];
for (let i = 1; i < lines.length; i++) if (lines[i].page === lines[i - 1].page) {
  const g = +(lines[i - 1].y - lines[i].y).toFixed(1);
  if (g > 0) gaps.push(g);
}
const sortedG = [...gaps].sort((a, b) => a - b);
const med = sortedG[sortedG.length >> 1];
const hist = {};
for (const g of gaps) hist[g] = (hist[g] ?? 0) + 1;
log(`\n${doc.numPages} pages, ${lines.length} lines, ${gaps.length} gaps; median leading=${med}`);
log("gap histogram (gap:count):", Object.entries(hist).sort((a, b) => +a[0] - +b[0]).map(([g, c]) => `${g}:${c}`).join("  "));

// --- paragraph reconstruction (threshold from the median leading) -------------------
function reconstructParagraphs(lines, { gapFactor = 1.5 } = {}) {
  const gapsByPage = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].page !== lines[i - 1].page) continue;
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0) { if (!gapsByPage.has(lines[i].page)) gapsByPage.set(lines[i].page, []); gapsByPage.get(lines[i].page).push(g); }
  }
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1] ?? 0; };
  const lead = new Map([...gapsByPage].map(([p, gs]) => [p, median(gs)]));
  const paras = [];
  let cur = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      const samePage = lines[i].page === lines[i - 1].page;
      const gap = lines[i - 1].y - lines[i].y;
      const isBreak = !samePage || gap > (lead.get(lines[i].page) ?? Infinity) * gapFactor;
      if (isBreak && cur.length) { paras.push(cur.join(" ")); cur = []; }
    }
    cur.push(lines[i].text);
  }
  if (cur.length) paras.push(cur.join(" "));
  return paras;
}

// --- packer: WHOLE paragraphs, kept under budget (round down only). A paragraph/word is NEVER
// split; the cap is soft only for a lone paragraph that alone exceeds it (it rides whole). ---
function packParagraphs(paras, { budget = 800 } = {}) {
  const segs = [];
  let cur = "";
  for (const p of paras) {
    if (!cur) { cur = p; continue; } // a lone over-budget paragraph rides whole (never split)
    if (cur.length + 1 + p.length <= budget) cur += "\n" + p;
    else { segs.push(cur); cur = p; } // would exceed cap → flush whole, start fresh
  }
  if (cur) segs.push(cur);
  return segs;
}

const paras = reconstructParagraphs(lines, { gapFactor: 1.5 });
log(`\nreconstructed ${paras.length} paragraphs, sizes: ${paras.map((p) => p.length).join(", ")}`);
const segs = packParagraphs(paras, { budget: 800 });
log(`pack-800: ${segs.length} segments, sizes: ${segs.map((s) => s.length).join(", ")}`);

// property 1: reconstruction is paragraph-grained — near (known paras + headings), and
// far from both degenerate ends (1 blob / per-line). Headings are legitimate extra atoms;
// a 3-page doc may also split ≤ a few paragraphs at page boundaries.
const nHeadings = KNOWN_PARAS.filter((_, i) => i % 3 === 0).length;
const expectedBlocks = KNOWN_PARAS.length + nHeadings;
assert(
  `reconstruction is paragraph-grained (got ${paras.length}; ~${expectedBlocks} expected = ${KNOWN_PARAS.length} paras + ${nHeadings} headings)`,
  paras.length >= KNOWN_PARAS.length - 1 && paras.length <= expectedBlocks + 3
);
// property 2: every reconstructed paragraph that fits the budget stays whole in one segment
const fit = paras.filter((p) => p.length <= 800);
assert("every budget-fitting paragraph lands COMPLETE in one segment (none cut)", fit.every((p) => segs.some((s) => s.includes(p))));
// property 3: a segment exceeds the cap ONLY when it is a single un-splittable paragraph
// (no internal "\n" join) — paragraphs/words are never split to fit the budget.
assert("over-cap segments are a single whole paragraph (never a split)", segs.every((s) => s.length <= 800 || !s.includes("\n")));

// property 4: recall tight + full coverage. Query targets ONE known paragraph's content.
const tok = (s) => [...new Set((s.toLowerCase().match(/[a-z0-9-]{4,}/g) ?? []))];
const target = KNOWN_PARAS[4]; // a middle paragraph
const qTerms = tok(target).filter((t) => !["that", "this", "with", "from", "into"].includes(t)).slice(0, 8);
const query = qTerms.join(" ");
const root = join(work, "root");
mkdirSync(root, { recursive: true });
segs.forEach((s, i) => writeFileSync(join(root, `seg-${String(i).padStart(3, "0")}.md`), s));
const ctx = new LiteCtx({ root, dbPath: ":memory:" });
await ctx.index();
const hits = await ctx.recall(query, { kind: "doc", body: true, log: false });
const body = (hits[0]?.body ?? "");
const cover = qTerms.filter((t) => body.toLowerCase().includes(t)).length / qTerms.length;
log(`\nrecall q="${query.slice(0, 50)}…" → top ${body.length}c, cover ${cover.toFixed(2)}`);
assert("recall returns a tight unit (< 1.4× budget) …", body.length > 0 && body.length <= 800 * 1.4);
assert("… with full coverage of the targeted paragraph's terms", cover === 1);

rmSync(work, { recursive: true, force: true });
log(`\n${failures === 0 ? "\x1b[32m✔ PASSED" : "\x1b[31m✘ FAILED"} — ${failures} failed assertion(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
