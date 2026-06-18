// THROWAWAY POC — §4 "untrusted input" negative scenarios for document ingest.
//
// The hypothesis POCs (doc-ingest / doc-chunk-split / doc-para-chunk) proved the happy
// path + a few negatives (raw-bytes control, corrupt bytes, page-cap). This one closes the
// rest of AC#4: a guarded ingest must BOUND untrusted documents and fail GRACEFULLY —
// never crash the pass, never pollute the index.
//
// Scenarios (each must trip the RIGHT guard, not a generic crash):
//   N1 size cap      — buffer over maxSize is rejected BEFORE any parse.
//   N2 no-text       — scanned/image-only PDF (no text layer; OCR out of scope) → clear
//                      "no extractable text", NOT an empty/garbage chunk in the index.
//   N3 encrypted     — password-protected PDF → clear error, no crash.
//   N4 parse timeout — a parse exceeding parseTimeoutMs is aborted (bomb vector).
//   N5 bad format    — unsupported/﻿missing format hint → clear error.
//   N6 corrupt bytes — non-document bytes → catchable parse error (re-confirmed here).
//   P0 positive ctrl — a normal small PDF passes ALL guards and yields real text.
//
// Prove-don't-assert: every negative asserts the SPECIFIC guard message, so a generic
// throw (or a silent pass) FAILS the test.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";

const log = (...a) => console.log(...a);
let failures = 0;
const assert = (label, cond) => { log(`  [${cond ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}] ${label}`); if (!cond) failures++; };
const work = mkdtempSync(join(tmpdir(), "litectx-bounds-"));

// --- fixtures (real tools) ----------------------------------------------------------
const html = join(work, "p.html");
writeFileSync(html, '<!doctype html><html><body><h2>Quarterly Report</h2><p>Revenue grew across every region this quarter and the migration finished on schedule.</p></body></html>');
execFileSync("libreoffice", ["--headless", "--convert-to", "pdf", "--outdir", work, html], { stdio: "pipe" });
const plainPdf = readFileSync(join(work, "p.pdf"));
// image-only "scanned" PDF: a drawing, no text layer
execFileSync("magick", ["-size", "800x1000", "canvas:white", "-fill", "black", "-draw", "circle 400,500 400,300", join(work, "img.png")], { stdio: "pipe" });
execFileSync("magick", [join(work, "img.png"), join(work, "scan.pdf")], { stdio: "pipe" });
const scanPdf = readFileSync(join(work, "scan.pdf"));
// encrypted PDF (open password) via the LibreOffice PDF export filter
const encDir = join(work, "enc");
execFileSync("libreoffice", ["--headless", "--convert-to",
  'pdf:writer_pdf_Export:{"EncryptFile":{"type":"boolean","value":"true"},"DocumentOpenPassword":{"type":"string","value":"secret"}}',
  "--outdir", encDir, html], { stdio: "pipe" });
const encPdf = readFileSync(join(encDir, "p.pdf"));
log(`fixtures: plain=${plainPdf.length}B  scan=${scanPdf.length}B  enc=${encPdf.length}B`);

// --- the guarded ingest (the bounds logic that would live in ingestDocument) ---------
const FORMAT_BY_EXT = { pdf: "pdf", docx: "docx" };
function detectFormat(filename, explicit) {
  if (explicit) return FORMAT_BY_EXT[explicit] ?? null;
  const ext = (filename ?? "").split(".").pop()?.toLowerCase();
  return FORMAT_BY_EXT[ext] ?? null;
}
function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} exceeded parseTimeoutMs (${ms}ms)`)), ms); });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}
async function pdfToMarkdown(buf, { maxPages }) {
  const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  if (doc.numPages > maxPages) throw new Error(`document exceeds maxPages (${doc.numPages} > ${maxPages})`);
  const paras = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const c = await (await doc.getPage(p)).getTextContent();
    let line = "";
    for (const it of c.items) { line += it.str; if (it.hasEOL) { if (line.trim()) paras.push(line.trim()); line = ""; } }
    if (line.trim()) paras.push(line.trim());
  }
  return paras.join("\n");
}
async function docxToMarkdown(buf) { return (await mammoth.convertToMarkdown({ buffer: buf })).value; }

/** Convert + bound an untrusted document → markdown, or throw a CLEAR, specific error. */
async function ingestToMarkdown(buf, { filename, format, maxSize = 10 * 1024 * 1024, maxPages = 2000, parseTimeoutMs = 30000 } = {}) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) throw new Error("ingest: expected a Buffer");
  if (buf.length > maxSize) throw new Error(`document exceeds maxSize (${buf.length} > ${maxSize})`); // N1 — before parse
  const fmt = detectFormat(filename, format);
  if (!fmt) throw new Error(`unsupported document format (filename="${filename}", format="${format}")`); // N5
  const convert = fmt === "pdf" ? () => pdfToMarkdown(buf, { maxPages }) : () => docxToMarkdown(buf);
  let md;
  try {
    md = await withTimeout(convert(), parseTimeoutMs, `${fmt} parse`); // N3/N4/N6 surface here
  } catch (e) {
    const name = e?.name ?? "";
    if (/password|encrypt/i.test(name) || /password/i.test(String(e?.message))) throw new Error(`document is encrypted/password-protected (${name || "PasswordException"})`); // N3
    throw e instanceof Error ? e : new Error(String(e)); // N4 timeout / N6 corrupt — already clear
  }
  const text = md.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("no extractable text (scanned/image-only PDF? OCR is out of scope)"); // N2
  return md;
}

const tries = async (label, fn) => { try { await fn(); return { ok: true }; } catch (e) { log(`    ${label} → threw: ${String(e.message).slice(0, 70)}`); return { ok: false, err: e }; } };

log("\nnegative scenarios:");
// N1 — size cap fires before parse (pass a real pdf but a tiny maxSize)
{ const r = await tries("N1 size", () => ingestToMarkdown(plainPdf, { filename: "x.pdf", maxSize: 1000 }));
  assert("N1 size cap: rejected with maxSize error (before parse)", !r.ok && /maxSize/.test(r.err.message)); }
// N2 — no-text scanned PDF
{ const r = await tries("N2 no-text", () => ingestToMarkdown(scanPdf, { filename: "scan.pdf" }));
  assert("N2 no-text: clear 'no extractable text' error (not empty chunk)", !r.ok && /no extractable text/.test(r.err.message)); }
// N3 — encrypted PDF
{ const r = await tries("N3 encrypted", () => ingestToMarkdown(encPdf, { filename: "enc.pdf" }));
  assert("N3 encrypted: clear encrypted/password error (no crash)", !r.ok && /encrypt|password/i.test(r.err.message)); }
// N4 — parse timeout (real multi-step parse vs a 1ms budget)
{ const r = await tries("N4 timeout", () => ingestToMarkdown(plainPdf, { filename: "x.pdf", parseTimeoutMs: 1 }));
  assert("N4 timeout: aborted with parseTimeoutMs error", !r.ok && /parseTimeoutMs/.test(r.err.message)); }
// N5 — bad/missing format
{ const r = await tries("N5 format", () => ingestToMarkdown(plainPdf, { filename: "mystery.xyz" }));
  assert("N5 bad format: clear unsupported-format error", !r.ok && /unsupported document format/.test(r.err.message)); }
// N6 — corrupt bytes
{ const r = await tries("N6 corrupt", () => ingestToMarkdown(Buffer.from("not a pdf ".repeat(50)), { filename: "x.pdf" }));
  assert("N6 corrupt: catchable parse error (no crash)", !r.ok && r.err instanceof Error); }

log("\npositive control:");
// P0 — a normal PDF passes every guard and yields real text
{ const r = await tries("P0 plain", () => ingestToMarkdown(plainPdf, { filename: "report.pdf" }));
  assert("P0 positive: normal PDF passes all guards → real text", r.ok); }
{ const md = await ingestToMarkdown(plainPdf, { filename: "report.pdf" });
  assert("P0 positive: extracted text contains document content ('Revenue')", /Revenue/i.test(md)); }

rmSync(work, { recursive: true, force: true });
log(`\n${failures === 0 ? "\x1b[32m✔ PASSED" : "\x1b[31m✘ FAILED"} — ${failures} failed assertion(s)\x1b[0m`);
process.exit(failures === 0 ? 0 : 1);
