// Plaintext-ingest integration tests — the "text" mode of ingest(buffer) for txt/text/log/csv
// (multis M3 plaintext-chunker ask). Behavior, not implementation: real buffers (no fixtures needed —
// plaintext is already text, no parser), a temp repo + in-memory DB, embeddings OFF (the default).
// Load-bearing invariants: a non-empty plaintext upload is CHUNKED (chunks>=1) and recallable by a
// body term (the gap multis filed: it was a 0-chunk blob); rows are kind:doc with the right format,
// source='direct' (survive index()), bounded under the cap, and a leading '#' is literal (no md heading).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const buf = (s) => Buffer.from(s, "utf8");

/** Throwaway repo with a code + md file, so index() has real work alongside ingested docs. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-txtingest-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.js"), "export function boot(){ return 'ok'; }\n");
  writeFileSync(join(root, "README.md"), "# App\nA small demo application.\n");
  return root;
}

for (const { ext, filename, format } of [
  { ext: "txt", filename: "notes.txt", format: "txt" },
  { ext: "text", filename: "notes.text", format: "txt" }, // "text" canonicalizes to "txt"
  { ext: "log", filename: "server.log", format: "log" },
  { ext: "csv", filename: "data.csv", format: "csv" },
]) {
  test(`.${ext} → chunked (not blob) and recallable by a body term`, async () => {
    const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
    const body = `intro line\n\nthe unique term zonkberry${ext} appears here in the body\n\ntail line`;
    const res = await ctx.ingest(buf(body), { filename });
    assert.equal(res.kind, "doc");
    assert.equal(res.mode, "chunked", `.${ext} must be chunked, not stored as a blob`);
    assert.equal(res.format, format);
    assert.ok(res.chunks >= 1, `expected >=1 chunk, got ${res.chunks}`);

    const hits = await ctx.recall(`zonkberry${ext}`, { kind: "doc", body: true });
    assert.ok(hits.length > 0, "a body-term query must return the ingested plaintext");
    assert.equal(hits[0].kind, "doc");
    assert.equal(hits[0].format, format);
    assert.match(hits[0].body ?? "", new RegExp(`zonkberry${ext}`));
  });
}

test("blank-line paragraphs → multiple bounded segments, each under the 800 cap", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  // four ~400-char paragraphs → must split into >1 segment, none exceeding the cap.
  const para = (tag) => `${tag} ` + "lorem ipsum dolor sit amet ".repeat(15);
  const body = [para("alpha"), para("bravo"), para("charlie"), para("delta")].join("\n\n");
  const res = await ctx.ingest(buf(body), { filename: "big.txt", id: "doc:big" });
  assert.ok(res.chunks > 1, `expected multiple segments, got ${res.chunks}`);
  for (let i = 0; i < res.chunks; i++) {
    const seg = await ctx.get(`doc:big#${i}`);
    assert.ok(seg.text.length <= 800, `segment ${i} should stay under the 800 cap, got ${seg.text.length}`);
  }
});

test("line-oriented log (no blank lines) → packed by line, searchable, bounded", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  const lines = Array.from({ length: 200 }, (_, i) => `2026-06-23T10:00:${String(i).padStart(2, "0")} INFO event ${i} wibblefrotz${i}`);
  const res = await ctx.ingest(buf(lines.join("\n")), { filename: "server.log", id: "doc:log" });
  assert.ok(res.chunks > 1, `a 200-line log should pack into >1 segment, got ${res.chunks}`);
  for (let i = 0; i < res.chunks; i++) {
    const seg = await ctx.get(`doc:log#${i}`);
    assert.ok(seg.text.length <= 800, `log segment ${i} over cap: ${seg.text.length}`);
  }
  const hits = await ctx.recall("wibblefrotz137", { kind: "doc", body: true });
  assert.ok(hits.some((h) => /wibblefrotz137/.test(h.body ?? "")), "a term deep in the log must be recallable");
});

test("a leading '#' in plaintext is literal text — NOT treated as a markdown heading", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  // a .log whose lines start with '#': the md heading-splitter would mangle this; the text packer keeps it.
  const body = "# this is a comment line not a heading quirklewomp\nactual log entry follows here\n# another hashed line";
  const res = await ctx.ingest(buf(body), { filename: "hashy.log", id: "doc:hashy" });
  assert.ok(res.chunks >= 1);
  const seg = await ctx.get("doc:hashy#0");
  assert.match(seg.text, /# this is a comment line/, "the '#' must be preserved as literal text, not stripped as a heading marker");
  const hits = await ctx.recall("quirklewomp", { kind: "doc", body: true });
  assert.ok(hits.length > 0, "the hashed line's content must still be recallable");
});

test("an over-budget single line rides whole — never split or truncated", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  // one CSV row far over the cap, with distinctive head + tail markers: must stay one untruncated segment.
  const row = "ZEBRACODE," + "field,".repeat(300) + "QUOKKAFINISH";
  const res = await ctx.ingest(buf(row), { filename: "wide.csv", id: "doc:wide" });
  assert.equal(res.chunks, 1, "a single over-cap line must remain one segment, not be split");
  const seg = await ctx.get("doc:wide#0");
  assert.ok(seg.text.length > 800, "the oversized line rides whole (above the soft cap)");
  assert.match(seg.text, /ZEBRACODE/);
  assert.match(seg.text, /QUOKKAFINISH/); // both ends survive → no truncation
});

test("mixed bounded + multiple over-cap paragraphs: each over-cap segment is one un-split atom", async () => {
  // Regression for a real-data finding (POC on TypeScript's LICENSE.txt, 3 over-cap paragraphs): the
  // invariant is NOT "at most one over-cap segment" — it's "an over-cap segment is EXACTLY one
  // un-splittable atom" (the packer flushes before concatenating two atoms past the cap), so a file
  // with N over-budget paragraphs yields N ride-whole segments interleaved with bounded ones.
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  const small = "a short paragraph here";
  const big = (tag) => `${tag} ` + "verylongtokenfragment ".repeat(60); // ~1300 chars, > the 800 cap
  const body = [small, big("BRAVOPARA"), small, big("DELTAPARA"), small].join("\n\n");
  const res = await ctx.ingest(buf(body), { filename: "mixed.txt", id: "doc:mix" });

  const atoms = body.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const atomsOver = atoms.filter((a) => a.length > 800);
  const segs = [];
  for (let i = 0; i < res.chunks; i++) segs.push((await ctx.get(`doc:mix#${i}`)).text);
  const segsOver = segs.filter((s) => s.length > 800);

  assert.equal(segsOver.length, atomsOver.length, "one over-cap segment per over-cap source atom");
  assert.ok(segsOver.length >= 2, "this fixture has multiple over-cap paragraphs (the real-data case)");
  for (const s of segsOver) assert.ok(atoms.includes(s), "each over-cap segment is a single un-split atom, never two concatenated");
  // both big paragraphs survive whole and are recallable by their distinctive markers
  assert.ok((await ctx.recall("BRAVOPARA", { kind: "doc", body: true })).length > 0);
  assert.ok((await ctx.recall("DELTAPARA", { kind: "doc", body: true })).length > 0);
});

test("plaintext segments are source='direct' — they survive an index() pass", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  await ctx.ingest(buf("prerequisites: npm registry proxy snorfblat config"), { filename: "setup.txt", id: "doc:setup" });
  await ctx.index(); // sweeps the repo's files; must NOT reconcile away the uploaded doc
  const hits = await ctx.recall("snorfblat registry proxy", { kind: "doc", body: true });
  assert.ok(hits.some((h) => h.path.startsWith("doc:setup#")), "uploaded plaintext must persist across index()");
});

test("format override routes a no-filename buffer through the text path", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  const res = await ctx.ingest(buf("body with term flibberjet and nothing else"), { format: "txt", id: "doc:nofn" });
  assert.equal(res.mode, "chunked");
  assert.equal(res.format, "txt");
  const hits = await ctx.recall("flibberjet", { kind: "doc", body: true });
  assert.ok(hits.length > 0, "format:'txt' override must engage the text chunker without a filename");
});

test("an empty / whitespace-only plaintext upload fails clearly and writes nothing", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  await assert.rejects(() => ctx.ingest(buf("   \n\n  \t \n"), { filename: "blank.txt", id: "doc:blank" }), /no extractable text/i);
  assert.equal(await ctx.get("doc:blank#0"), null, "a failed empty ingest must write nothing");
});

test("re-ingesting the same id is an upsert — orphaned tail segments are dropped", async () => {
  const ctx = new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
  await ctx.ingest(buf("first version of the notes file truvanto"), { filename: "n.txt", id: "doc:up" });
  await ctx.remember("doc:up#99", "an orphaned tail segment from a longer prior version", { kind: "doc", format: "txt" });
  assert.ok((await ctx.get("doc:up#99")) !== null);

  await ctx.ingest(buf("shorter rewrite truvanto"), { filename: "n.txt", id: "doc:up" });
  assert.equal(await ctx.get("doc:up#99"), null, "re-ingest must drop the orphaned tail segment");
});
