// Indexed md = one `docs` row PER heading section (tinymem retrieval change). Behaviour, not shape: a
// section ranks and localizes on its own, a file can appear several times, an edit replaces every row and
// vector of the file (no orphans), and everything that is NOT indexed md (code, uploads, written memory)
// keeps its one-row-per-unit behaviour. Embeddings are an injected stub (hermetic).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

// 2-D bag-of-markers stub (alpha / beta), counts calls — same shape as the real Embedder.
function markerStub() {
  return {
    calls: 0,
    /** @param {string} text */
    async embed(text) {
      this.calls++;
      const a = (text.match(/alpha/g) || []).length;
      const b = (text.match(/beta/g) || []).length;
      const n = Math.hypot(a, b) || 1;
      return Float32Array.from([a / n, b / n]);
    },
  };
}

const GUIDE = [
  "Intro paragraph about the project.",
  "",
  "# Setup",
  "install the thing with widget tooling",
  "",
  "## Zebra handling",
  "the zebra migration needs a widget flag alpha",
  "",
  "## Quokka handling",
  "the quokka cache needs a widget flag beta beta",
  "",
].join("\n");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "litectx-docsec-"));
  writeFileSync(join(root, "guide.md"), GUIDE);
  writeFileSync(join(root, "app.js"), "export function app() { return widget; }\n");
  return root;
}

async function withCtx(opts, fn) {
  const root = fixture();
  const ctx = new LiteCtx({ root, dbPath: ":memory:", ...opts });
  try {
    await fn(ctx, root);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const q = (ctx, sql, ...a) => ctx.store.db.prepare(sql).all(...a);

test("sections of one md rank separately: the matching section wins and carries its own line range", async () => {
  await withCtx({}, async (ctx) => {
    await ctx.index();
    const hits = await ctx.recall("zebra migration", { kind: "doc" });
    assert.equal(hits[0].path, "guide.md");
    assert.equal(hits[0].chunk.symbol, "Zebra handling", "the best SECTION, not a guess inside the file");
    assert.deepEqual([hits[0].chunk.startLine, hits[0].chunk.endLine], [5, 7]);
    const quokka = await ctx.recall("quokka cache", { kind: "doc" });
    assert.equal(quokka[0].chunk.symbol, "Quokka handling");
  });
});

test("a file may appear several times: two sections matching one query are two hits on the same path", async () => {
  await withCtx({}, async (ctx) => {
    await ctx.index();
    const hits = (await ctx.recall("widget flag", { kind: "doc", n: 10 })).filter((h) => h.path === "guide.md");
    assert.ok(hits.length >= 2, "repeated path allowed");
    assert.equal(new Set(hits.map((h) => h.chunk.startLine)).size, hits.length, "each repeat is a DIFFERENT section");
    for (const h of hits) assert.equal("rid" in h || "source" in h, false, "internal row id/source never surface");
  });
});

test("get(path,{range}) and recall({body}) return the section's own text", async () => {
  await withCtx({}, async (ctx) => {
    await ctx.index();
    const [h] = await ctx.recall("quokka cache", { kind: "doc", body: true });
    assert.match(h.body, /quokka cache needs/);
    assert.doesNotMatch(h.body, /zebra/, "only the section, not the whole file");
    const got = ctx.get("guide.md", { startLine: h.chunk.startLine, endLine: h.chunk.endLine });
    assert.equal(got.text, h.body);
  });
});

test("code files are unchanged: one docs row, a file vector, no section rows", async () => {
  const stub = markerStub();
  await withCtx({ embeddings: true, embedder: stub }, async (ctx) => {
    await ctx.index();
    assert.equal(q(ctx, "SELECT 1 FROM docs WHERE path='app.js'").length, 1);
    assert.equal(q(ctx, "SELECT 1 FROM doc_sections WHERE path='app.js'").length, 0);
    assert.equal(q(ctx, "SELECT 1 FROM file_embeddings WHERE path='app.js'").length, 1);
    assert.equal(q(ctx, "SELECT 1 FROM file_embeddings WHERE path='guide.md'").length, 0, "md has section vectors, no file vector");
    const code = await ctx.recall("widget", { kind: "code" });
    assert.equal(code.length, 1);
  });
});

test("size()/index().files keep meaning FILES, not rows", async () => {
  await withCtx({}, async (ctx) => {
    const r = await ctx.index();
    assert.equal(r.files, 2, "guide.md (4 sections) + app.js = 2 files");
    assert.ok(q(ctx, "SELECT 1 FROM doc_fts WHERE source='file'").length > 2, "…even though md is several rows");
    assert.equal(ctx.size(), 2);
    await ctx.remember("doc:x", "a written doc", { kind: "doc" });
    assert.equal(ctx.size(), 3, "a written doc is one item");
  });
});

test("legacy rows: a whole-file md row with no doc_sections row still recalls and uses its FILE vector", async () => {
  const stub = markerStub();
  await withCtx({ embeddings: true, embedder: stub }, async (ctx) => {
    await ctx.index();
    // turn guide.md back into a pre-upgrade shape: one whole-file docs row, a file vector, no section rows
    const db = ctx.store.db;
    db.prepare("DELETE FROM doc_fts WHERE path='guide.md'").run();
    db.prepare("DELETE FROM doc_sections WHERE path='guide.md'").run();
    db.prepare("INSERT INTO doc_fts(path, kind, format, source, provenance, occurred_at, body) VALUES ('guide.md','doc','md','file',NULL,NULL,?)").run(GUIDE);
    db.prepare("INSERT INTO file_embeddings(path, dim, vec) VALUES ('guide.md', 2, ?)").run(Buffer.from(Float32Array.from([1, 0]).buffer));
    const hits = await ctx.recall("zebra", { kind: "doc" });
    assert.equal(hits.length, 1, "one hit per legacy file, as before");
    assert.equal(hits[0].chunk.symbol, "Zebra handling", "legacy chunk localization (attachChunks) still runs");
    const rid = q(ctx, "SELECT rowid AS r FROM doc_fts WHERE path='guide.md'")[0].r;
    const [v] = ctx.store.docCandidateVectors([{ path: "guide.md", source: "file", rid }]);
    assert.deepEqual([...v], [1, 0], "no section row → the file_embeddings vector");
  });
});

test("editing one section replaces every row and vector of the file — no orphans", async () => {
  const stub = markerStub();
  await withCtx({ embeddings: true, embedder: stub }, async (ctx, root) => {
    await ctx.index();
    const nodes = () => q(ctx, "SELECT count(*) AS n FROM nodes WHERE path='guide.md'")[0].n;
    assert.equal(nodes(), 4);
    assert.equal(q(ctx, "SELECT 1 FROM doc_fts WHERE path='guide.md'").length, 4);
    writeFileSync(join(root, "guide.md"), GUIDE.replace("quokka cache needs a", "quokka cache needs a platypus") + "\n## Extra\nbonus section\n");
    await ctx.index();
    assert.equal(nodes(), 5);
    assert.equal(q(ctx, "SELECT 1 FROM doc_fts WHERE path='guide.md'").length, 5, "old rows gone, new rows in");
    assert.equal(q(ctx, "SELECT 1 FROM doc_sections WHERE path='guide.md'").length, 5);
    assert.equal(q(ctx, "SELECT 1 FROM doc_sections WHERE path='guide.md' AND vec IS NOT NULL").length, 5);
    assert.equal(q(ctx, "SELECT 1 FROM doc_sections s WHERE s.doc_rowid NOT IN (SELECT rowid FROM doc_fts)").length, 0, "no orphan section rows");
    assert.equal(q(ctx, "SELECT 1 FROM doc_sections s WHERE s.node_id NOT IN (SELECT id FROM nodes)").length, 0);
    assert.equal(ctx.store.sectionEmbeddingCount(), 5);
    assert.equal((await ctx.recall("platypus", { kind: "doc" }))[0].chunk.symbol, "Quokka handling");
  });
});

test("deleting an md file drops its rows, section rows and vectors", async () => {
  const stub = markerStub();
  await withCtx({ embeddings: true, embedder: stub }, async (ctx, root) => {
    await ctx.index();
    assert.equal(ctx.store.sectionEmbeddingCount(), 4);
    unlinkSync(join(root, "guide.md"));
    await ctx.index();
    assert.equal(q(ctx, "SELECT 1 FROM doc_fts WHERE path='guide.md'").length, 0);
    assert.equal(q(ctx, "SELECT 1 FROM doc_sections").length, 0);
    assert.equal(ctx.store.sectionEmbeddingCount(), 0);
    assert.deepEqual(await ctx.recall("zebra", { kind: "doc" }), []);
  });
});

test("embeddings off→on backfills section vectors, once, without re-chunking", async () => {
  const root = fixture();
  const dbPath = join(root, "idx.db");
  const off = new LiteCtx({ root, dbPath, embeddings: false });
  await off.index();
  assert.equal(off.store.sectionEmbeddingCount(), 0);
  off.close();

  const stub = markerStub();
  const on = new LiteCtx({ root, dbPath, embeddings: true, embedder: stub });
  const r = await on.index();
  assert.equal(r.unchanged, 2, "content-unchanged — the backfill did it");
  assert.equal(stub.calls, 5, "4 md sections + 1 code file, each embedded once");
  assert.equal(on.store.sectionEmbeddingCount(), 4);
  assert.equal(on.store.embeddingCount(), 1, "only the code file has a file vector");
  await on.index();
  assert.equal(stub.calls, 5, "idempotent — a warm pass embeds nothing");
  on.close();
  rmSync(root, { recursive: true, force: true });
});

test("section vectors re-rank (never nominate): cosine reorders sections inside the BM25 pool", async () => {
  const stub = markerStub();
  await withCtx({ embeddings: true, embedder: stub }, async (ctx) => {
    await ctx.index();
    const hits = await ctx.recall("widget flag beta", { kind: "doc", n: 10 });
    assert.equal(hits[0].chunk.symbol, "Quokka handling", "the beta section's own vector lifts it");
  });
});

test(".eml ingests as plaintext: ~800-char pieces, each recallable", async () => {
  await withCtx({}, async (ctx) => {
    const para = (w) => `${w} `.repeat(70).trim() + ".";
    const eml = ["From: a@b.c", "Subject: quarterly plan", "", para("alpha"), "", para("bravo"), "", para("charlie"), "", para("delta"), ""].join("\n");
    const res = await ctx.ingest(new TextEncoder().encode(eml), { filename: "thread.eml" });
    assert.equal(res.mode, "chunked");
    assert.equal(res.format, "eml");
    assert.ok(res.chunks >= 3, `several pieces (got ${res.chunks})`);
    const rows = q(ctx, "SELECT path FROM doc_fts WHERE path LIKE char(30)||'doc:thread#%'");
    assert.equal(rows.length, res.chunks);
    const hits = await ctx.recall("charlie", { kind: "doc" });
    assert.ok(hits[0].path.startsWith("doc:thread#"));
    for (let i = 0; i < res.chunks; i++) assert.ok(ctx.get(`doc:thread#${i}`).text.length <= 900, "pieces stay near the 800-char cap");
  });
});
