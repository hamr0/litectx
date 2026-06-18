// Document ingest (PDF/DOCX → markdown → segments). The reserved `format` field under `kind=doc`
// (PRD §"PDF/DOCX deferred"), now built. A PDF/DOCX is a LOSSY SOURCE OF MARKDOWN — never a new
// kind, never a format-native chunker (litectx doctrine): convert to text, then segment.
//
// The two parsers are OPTIONAL peer deps, lazy-imported on first use (mirroring embedder.js), so
// `npm i litectx` stays lean and offline-capable — a consumer who never ingests a document pays
// neither install nor import. Each surfaces a helpful error if the dep is missing.
//
// Segmentation is POC-validated (poc/doc-chunk-split-poc.mjs, doc-para-chunk-poc.mjs):
//   - DOCX → mammoth markdown KEEPS headings → reuse the existing md chunker (one section/chunk).
//   - PDF  → pdfjs getTextContent is FLAT text with NO blank lines and NO heading semantics, so
//     the md chunker would emit ONE giant chunk. We reconstruct paragraphs from the VERTICAL GAP
//     between lines (inter-paragraph gap > intra-paragraph leading), then pack WHOLE paragraphs
//     into segments kept UNDER CHUNK_BUDGET chars — a paragraph (or word) is NEVER split or
//     truncated; the cap is soft only for a lone paragraph that alone exceeds it (it rides whole
//     rather than be cut). 800 chars ≈ one paragraph / a few per page; the sweet spot where recall
//     returns a tight unit that still holds the whole answer (per-line scatters it; the blob has no
//     targeting). 800 is an internal constant, not a config lever (deliberate).

import { chunkAndImports } from "./chunker.js";

const CHUNK_BUDGET = 800; // chars/segment for headless docs — POC sweet spot (500 fragments, 1200 drops coverage)
const GAP_FACTOR = 1.5; // a line-gap > GAP_FACTOR × the page's median leading marks a paragraph break
const DEFAULT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB — decompression-bomb / OOM bound (§4)
const DEFAULT_MAX_PAGES = 2000; // page bound (§4)
const DEFAULT_PARSE_TIMEOUT_MS = 30000; // wall-clock parse bound (§4)

const FORMAT_BY_EXT = { pdf: "pdf", docx: "docx" };

/**
 * Classify a document into its `format` from an explicit hint or the filename extension.
 * @param {string} [filename]
 * @param {string} [explicit]  caller override, e.g. "pdf" | "docx"
 * @returns {"pdf" | "docx" | null}
 */
function detectFormat(filename, explicit) {
  if (explicit) return /** @type {"pdf"|"docx"|null} */ (FORMAT_BY_EXT[explicit.toLowerCase()] ?? null);
  const ext = (filename ?? "").split(".").pop()?.toLowerCase() ?? "";
  return /** @type {"pdf"|"docx"|null} */ (FORMAT_BY_EXT[ext] ?? null);
}

/** Lazy-import pdfjs-dist (optional peer dep). @returns {Promise<any>} the module's `getDocument`. */
async function loadPdfjs() {
  try {
    // Non-literal specifier on purpose (see embedder.js): keeps the optional dep off the tsc/core path.
    const pkg = "pdfjs-dist/legacy/build/pdf.mjs";
    const mod = await import(pkg);
    return mod.getDocument;
  } catch {
    throw new Error(
      "litectx: document ingest needs the optional peer dependency 'pdfjs-dist'. " +
        "Install it (`npm i pdfjs-dist`) to ingest PDF documents."
    );
  }
}

/** Lazy-import mammoth (optional peer dep). @returns {Promise<any>} the mammoth module. */
async function loadMammoth() {
  try {
    const pkg = "mammoth";
    const mod = await import(pkg);
    return mod.default ?? mod;
  } catch {
    throw new Error(
      "litectx: document ingest needs the optional peer dependency 'mammoth'. " +
        "Install it (`npm i mammoth`) to ingest DOCX documents."
    );
  }
}

/**
 * Reconstruct paragraphs from positioned PDF lines. A paragraph break is a same-page line-gap
 * notably larger than the page's median leading (intra-paragraph spacing), or any page change.
 * Median-relative, so it is font-size independent.
 * @param {{ text: string, y: number, page: number }[]} lines
 * @param {number} gapFactor
 * @returns {string[]}
 */
function reconstructParagraphs(lines, gapFactor) {
  /** @type {Map<number, number[]>} */
  const gapsByPage = new Map();
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].page !== lines[i - 1].page) continue;
    const g = lines[i - 1].y - lines[i].y;
    if (g > 0) {
      const arr = gapsByPage.get(lines[i].page);
      if (arr) arr.push(g);
      else gapsByPage.set(lines[i].page, [g]);
    }
  }
  const median = (/** @type {number[]} */ arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  };
  /** @type {Map<number, number>} */
  const lead = new Map([...gapsByPage].map(([p, gs]) => [p, median(gs)]));

  /** @type {string[]} */
  const paras = [];
  /** @type {string[]} */
  let cur = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      const samePage = lines[i].page === lines[i - 1].page;
      const gap = lines[i - 1].y - lines[i].y;
      const isBreak = !samePage || gap > (lead.get(lines[i].page) ?? Infinity) * gapFactor;
      if (isBreak && cur.length) {
        paras.push(cur.join(" "));
        cur = [];
      }
    }
    cur.push(lines[i].text);
  }
  if (cur.length) paras.push(cur.join(" "));
  return paras;
}

/**
 * Pack WHOLE paragraphs into segments, keeping each segment UNDER `budget` chars. A paragraph — and
 * a fortiori a word — is NEVER split or truncated: when the next paragraph would push the segment
 * over budget, the segment is flushed and that paragraph starts a fresh one (round down only, no
 * overshoot). `budget` is therefore a soft cap with exactly ONE exception — a single paragraph that
 * alone exceeds it becomes its own whole, oversized segment, because the alternative is truncation.
 * @param {string[]} paras @param {number} budget @returns {string[]}
 */
function packSegments(paras, budget) {
  /** @type {string[]} */
  const segs = [];
  let cur = "";
  for (const p of paras) {
    if (!cur) {
      cur = p; // start a segment — a lone paragraph longer than budget rides whole (never split)
      continue;
    }
    if (cur.length + 1 + p.length <= budget) cur += "\n" + p; // still fits under the cap → keep packing
    else {
      segs.push(cur); // would exceed the cap → flush whole, start fresh with this paragraph
      cur = p;
    }
  }
  if (cur) segs.push(cur);
  return segs;
}

/**
 * Extract a PDF's text as reconstructed paragraphs (with positions), bounded by `maxPages` and a
 * per-page wall-clock budget (`parseTimeoutMs`). The timeout is checked BETWEEN pages — the yield
 * points we control — so a many-page bomb is aborted mid-extraction. NB: a single pathological page
 * is bounded by `maxSize`/`maxPages`, not the timer: JS can't preempt synchronous CPU work without a
 * worker thread (out of scope for v1), and a `setTimeout` race can't interrupt microtask-bound work.
 * @param {Uint8Array} bytes @param {number} maxPages @param {number} parseTimeoutMs @returns {Promise<string[]>}
 */
async function pdfToParagraphs(bytes, maxPages, parseTimeoutMs) {
  const getDocument = await loadPdfjs();
  // pdfjs rejects a Node Buffer ("provide binary data as Uint8Array") — hand it a plain Uint8Array.
  const data = bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes);
  // Text extraction never renders glyphs, so system fonts aren't needed — keep parsing hermetic (no
  // local font enumeration). isEvalSupported:false disables eval (pdf.js font-path RCE class, CVE-2024-4367);
  // PDF scripting/XFA stay at their safe defaults (off).
  const doc = await getDocument({ data, useSystemFonts: false, isEvalSupported: false }).promise;
  try {
    if (doc.numPages > maxPages) throw new Error(`document exceeds maxPages (${doc.numPages} > ${maxPages})`);
    const start = Date.now();
    /** @type {{ text: string, y: number, page: number }[]} */
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      if (Date.now() - start > parseTimeoutMs) throw new Error(`pdf parse exceeded parseTimeoutMs (${parseTimeoutMs}ms at page ${p}/${doc.numPages})`);
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let text = "";
      /** @type {number|null} */
      let y = null;
      for (const it of content.items) {
        if (typeof it.str !== "string") continue; // skip marked-content / non-text items
        if (y === null) y = it.transform[5];
        text += it.str;
        if (it.hasEOL) {
          if (text.trim()) lines.push({ text: text.trim(), y: y ?? 0, page: p });
          text = "";
          y = null;
        }
      }
      if (text.trim()) lines.push({ text: text.trim(), y: y ?? 0, page: p });
    }
    return reconstructParagraphs(lines, GAP_FACTOR);
  } finally {
    await doc.destroy?.();
  }
}

/** Convert a DOCX to markdown (mammoth keeps headings/lists/emphasis). @param {Uint8Array} bytes @returns {Promise<string>} */
async function docxToMarkdown(bytes) {
  const mammoth = await loadMammoth();
  const { value } = await mammoth.convertToMarkdown({ buffer: Buffer.from(bytes) });
  return value;
}

/**
 * Segment already-converted markdown. Headings present (structured DOCX) → reuse the existing md
 * chunker, one segment per section. Headless → pack blank-line paragraphs (or lines) to budget.
 * @param {string} md @param {number} budget @returns {Promise<string[]>}
 */
async function segmentsFromMarkdown(md, budget) {
  if (/^#{1,6}\s/m.test(md)) {
    const { chunks } = await chunkAndImports("document.md", md);
    return chunks.map((c) => c.text).filter((t) => t.trim());
  }
  const paras = md.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const atoms = paras.length > 1 ? paras : md.split("\n").map((s) => s.trim()).filter(Boolean);
  return packSegments(atoms, budget);
}

/** @param {unknown} e @param {string} fmt @returns {Error} */
function mapParseError(e, fmt) {
  const name = (e && /** @type {any} */ (e).name) || "";
  const msg = (e && /** @type {any} */ (e).message) || String(e);
  if (/password|encrypt/i.test(name) || /password|encrypt/i.test(msg)) {
    return new Error(`ingestDocument: the ${fmt} is encrypted/password-protected — cannot extract text`);
  }
  if (/exceeds max|parseTimeoutMs/i.test(msg)) return new Error(`ingestDocument: ${msg}`);
  return new Error(`ingestDocument: failed to parse ${fmt} — ${msg}`);
}

/**
 * @typedef {object} DocSegmentOptions
 * @property {string} [filename]  drives format detection (e.g. "manual.pdf")
 * @property {string} [format]    explicit format override ("pdf" | "docx")
 * @property {number} [maxSize]   byte cap; over → reject before parse (default 10 MB)
 * @property {number} [maxPages]  page cap for PDF (default 2000)
 * @property {number} [parseTimeoutMs]  wall-clock parse cap (default 30 s)
 */

/**
 * Convert an untrusted document buffer to recall-ready markdown segments, BOUNDED and failing with
 * a CLEAR, specific error (never a crash; never an empty/garbage unit). The conversion + segmentation
 * half of {@link LiteCtx#ingestDocument}; storage is the caller's.
 * @param {Uint8Array} buffer  the document bytes
 * @param {DocSegmentOptions} [opts]
 * @returns {Promise<{ format: "pdf" | "docx", segments: string[] }>}
 */
export async function documentToSegments(buffer, opts = {}) {
  const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const parseTimeoutMs = opts.parseTimeoutMs ?? DEFAULT_PARSE_TIMEOUT_MS;

  if (!(buffer instanceof Uint8Array)) throw new Error("ingestDocument: expected a Buffer/Uint8Array of document bytes");
  if (buffer.length > maxSize) throw new Error(`ingestDocument: document exceeds maxSize (${buffer.length} > ${maxSize} bytes)`);
  const fmt = detectFormat(opts.filename, opts.format);
  if (!fmt) {
    throw new Error(
      `ingestDocument: unsupported or undetected format (filename=${JSON.stringify(opts.filename)}, ` +
        `format=${JSON.stringify(opts.format)}); supported: pdf, docx`
    );
  }

  /** @type {string[]} */
  let segments;
  try {
    if (fmt === "pdf") {
      const paras = await pdfToParagraphs(buffer, maxPages, parseTimeoutMs);
      segments = packSegments(paras, CHUNK_BUDGET);
    } else {
      // DOCX is read in one pass by mammoth (a zip); `maxSize` is its bound, not parseTimeoutMs.
      const md = await docxToMarkdown(buffer);
      segments = await segmentsFromMarkdown(md, CHUNK_BUDGET);
    }
  } catch (e) {
    throw mapParseError(e, fmt);
  }

  if (!segments.length || !segments.some((s) => s.trim())) {
    throw new Error(`ingestDocument: no extractable text from the ${fmt} (scanned/image-only? OCR is out of scope)`);
  }
  return { format: fmt, segments };
}
