// Document-ingest integration tests — the CHUNKABLE branch of ingest(buffer) for PDF/DOCX (md/blob
// branches + scope/expiry live in docstore.test.js). Behavior, not implementation: real LibreOffice/
// ImageMagick fixtures (committed under fixtures/doc-ingest — hand-crafted PDFs are rejected by
// parsers, §4), a temp repo + in-memory DB, embeddings OFF (the default; no ML dep touched).
// Load-bearing invariants: converted text is recallable (not %PDF bytes), segments are source='direct'
// so they survive index(), and every untrusted-input failure is bounded + writes nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiteCtx } from "../src/index.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "doc-ingest");
const bytes = (name) => readFileSync(join(FIX, name));

/** Throwaway repo with a code + md file, so index() has real work alongside ingested docs. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-docingest-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.js"), "export function boot(){ return 'ok'; }\n");
  writeFileSync(join(root, "README.md"), "# App\nA small demo application.\n");
  return root;
}

test("PDF buffer → ingest → recall returns readable text, not %PDF bytes", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  const res = await ctx.ingest(bytes("report.pdf"), { filename: "report.pdf" });
  assert.equal(res.kind, "doc");
  assert.equal(res.format, "pdf");
  assert.equal(res.id, "doc:report");
  assert.ok(res.chunks >= 1, `expected >=1 chunk, got ${res.chunks}`);

  const hits = await ctx.recall("troubleshooting diagnostic log expired credential", { kind: "doc", body: true });
  assert.ok(hits.length > 0, "a content-word query should return a hit");
  const top = hits[0];
  assert.equal(top.kind, "doc");
  assert.equal(top.format, "pdf"); // AC#3 — reserved format under kind=doc
  assert.ok(top.body && !top.body.includes("%PDF"), "body must be extracted text, not raw PDF bytes");
  assert.match(top.body, /diagnostic/i, "the troubleshooting section's text should be recallable");
});

test("DOCX buffer → ingest preserves heading structure (multiple section segments)", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  const res = await ctx.ingest(bytes("report.docx"), { filename: "report.docx" });
  assert.equal(res.format, "docx");
  assert.ok(res.chunks > 1, `DOCX with 3 headings should yield >1 segment, got ${res.chunks}`);

  // a query for the Configuration section's distinctive terms returns that section, tightly.
  const hits = await ctx.recall("configuration environment variables database path", { kind: "doc", body: true });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].format, "docx");
  assert.match(hits[0].body, /environment variables/i);
  // granularity: the returned segment is one section, not the whole document.
  assert.ok(hits[0].body.length < 1200, `expected a tight section, got ${hits[0].body.length} chars`);
});

test("whole-paragraph packing: normal segments stay under the cap; a paragraph is never split", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  const res = await ctx.ingest(bytes("report.pdf"), { filename: "report.pdf", id: "doc:r" });
  for (let i = 0; i < res.chunks; i++) {
    const seg = await ctx.get(`doc:r#${i}`);
    assert.ok(seg.text.length <= 800, `segment ${i} should stay under the 800 cap, got ${seg.text.length}`);
  }
});

test("over-budget paragraph rides whole — never split or truncated (the one over-cap exception)", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  const res = await ctx.ingest(bytes("bigpara.pdf"), { filename: "bigpara.pdf", id: "doc:big" });
  assert.equal(res.chunks, 1, "a single long paragraph must remain a single segment, not be split");
  const seg = await ctx.get("doc:big#0");
  assert.ok(seg.text.length > 800, "the oversized paragraph rides whole (above the soft cap), not truncated");
  // both the first and last distinctive markers survive in the SAME segment → no truncation.
  assert.match(seg.text, /ZEBRACODE/);
  assert.match(seg.text, /QUOKKAFINISH/);
});

test("ingested doc segments are source='direct' — they survive an index() pass", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  await ctx.ingest(bytes("report.pdf"), { filename: "report.pdf", id: "doc:manual" });
  await ctx.index(); // sweeps the repo's files; must NOT reconcile away the uploaded doc
  const hits = await ctx.recall("prerequisites npm registry proxy", { kind: "doc", body: true });
  assert.ok(hits.some((h) => h.path.startsWith("doc:manual#")), "uploaded doc must persist across index()");
});

test("format field is readable via get(id), and meta passes through to every segment", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  const res = await ctx.ingest(bytes("report.pdf"), { filename: "report.pdf", meta: { chat: "c-42" } });
  const item = await ctx.get(`${res.id}#0`);
  assert.equal(item.format, "pdf");
  assert.equal(item.kind, "doc");
  assert.equal(item.source, "direct");
  const hits = await ctx.recall("installation configuration troubleshooting", { kind: "doc" });
  assert.deepEqual(hits[0].meta, { chat: "c-42" });
});

test("re-ingesting the same id is an upsert — orphaned tail segments are dropped", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  await ctx.ingest(bytes("report.docx"), { filename: "report.docx", id: "doc:up" });
  // simulate a previous, LONGER ingest leaving a high-index tail segment behind
  await ctx.remember("doc:up#99", "an orphaned tail segment from a longer prior version", { kind: "doc", format: "docx" });
  assert.ok((await ctx.get("doc:up#99")) !== null);

  await ctx.ingest(bytes("report.docx"), { filename: "report.docx", id: "doc:up" }); // re-ingest
  assert.equal(await ctx.get("doc:up#99"), null, "re-ingest must drop the orphaned tail segment");
  const orphan = await ctx.recall("orphaned tail segment longer prior version", { kind: "doc", body: true });
  assert.ok(!orphan.some((h) => /orphaned tail/.test(h.body ?? "")), "orphan text must be gone from recall");
});

// --- §4 untrusted-input bounds: each fails with a CLEAR error and writes NOTHING ---------------
async function assertWritesNothing(ctx, fn, re) {
  await assert.rejects(fn, re);
  const hits = await ctx.recall("installation configuration troubleshooting diagnostic environment", { kind: "doc" });
  assert.equal(hits.length, 0, "a failed ingest must leave the index empty");
}

test("bound: oversized buffer is rejected before parse", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  await assertWritesNothing(ctx, () => ctx.ingest(bytes("report.pdf"), { filename: "report.pdf", maxSize: 1000 }), /maxSize/);
});

test("bound: scanned/image-only PDF → clear 'no extractable text' (not an empty chunk)", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  await assertWritesNothing(ctx, () => ctx.ingest(bytes("scan.pdf"), { filename: "scan.pdf" }), /no extractable text/i);
});

test("bound: encrypted/password-protected PDF → clear error", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  await assertWritesNothing(ctx, () => ctx.ingest(bytes("encrypted.pdf"), { filename: "encrypted.pdf" }), /encrypt|password/i);
});

test("an unknown extension is NOT an error — it routes to the byte-exact blob path (R3)", async () => {
  // (was: "unsupported format → error". Under the unified ingest, an unrecognized extension is a
  //  valid blob — stored byte-exact, filename-searchable, not parsed. Full R3 coverage: docstore.test.js.)
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  const payload = bytes("report.pdf"); // arbitrary bytes; the .xyz extension makes it a blob, never parsed
  const res = await ctx.ingest(payload, { filename: "mystery.xyz" });
  assert.equal(res.mode, "blob");
  assert.equal(res.format, "xyz");
  const got = await ctx.get(res.id);
  assert.ok(Buffer.isBuffer(got.bytes) && got.bytes.equals(Buffer.from(payload)), "blob round-trips byte-exact");
});

test("bound: corrupt bytes → catchable parse error", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  const garbage = Buffer.from("this is plainly not a pdf ".repeat(40));
  await assertWritesNothing(ctx, () => ctx.ingest(garbage, { filename: "x.pdf" }), /failed to parse pdf/i);
});

test("bound: over-page PDF is rejected", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  await assertWritesNothing(ctx, () => ctx.ingest(bytes("multipage.pdf"), { filename: "big.pdf", maxPages: 5 }), /maxPages/);
});

test("bound: per-page parse timeout aborts a multi-page parse mid-extraction", async () => {
  // The timeout is checked BETWEEN pages; a 14-page parse (~100ms) far exceeds a 1ms budget, so it
  // aborts within the first pages regardless of machine speed. (A single page is bounded by maxSize/
  // maxPages, not the timer — JS can't preempt synchronous CPU work; see docparse.js.)
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  await assertWritesNothing(ctx, () => ctx.ingest(bytes("multipage.pdf"), { filename: "big.pdf", parseTimeoutMs: 1 }), /parseTimeoutMs/);
});
