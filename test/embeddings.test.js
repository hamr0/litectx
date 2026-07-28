// Slice 6 integration tests — the embeddings tier WIRING, exercised with an INJECTED stub embedder
// so they stay hermetic and fast (no model download, no network). The real model's retrieval QUALITY
// is validated by the bench (poc/embeddings-poc.mjs), not here — these pin the mechanism: storage,
// incremental re-embed, delete, the fused re-rank, the off-path invariant, and the missing-dep guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import { Embedder, cosine } from "../src/embedder.js";

// Deterministic stub: a 2-D bag-of-markers vector over "alpha"/"beta". Counts how often it's called
// (to prove incremental re-embed + the query cache). Shape-compatible with the real Embedder.
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

// All files share the FTS term "widget" (so all land in the pool); the markers steer the semantics.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "litectx-emb-"));
  writeFileSync(join(root, "one.js"), "export function one() { return widget; }\n"); // no marker → [0,0]
  writeFileSync(join(root, "two.js"), "export function two() { return widget; } // alpha\n"); // → [1,0]
  writeFileSync(join(root, "three.js"), "export function three() { return widget; } // beta beta\n"); // → [0,1]
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

test("cosine of L2-normalized vectors is their dot product; missing vector → 0", () => {
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0])), 1);
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1])), 0);
  assert.equal(cosine(undefined, Float32Array.from([1, 0])), 0, "absent embedding contributes no boost");
});

test("embeddings off (default) stores no vectors and never builds an embedder", async () => {
  await withCtx({}, async (ctx) => {
    await ctx.index();
    assert.equal(ctx.store.embeddingCount(), 0, "no vectors stored on the default path");
    assert.equal(ctx._embedder, null, "the embedder is never constructed when the tier is off");
  });
});

test("embeddings on stores one vector per file (BLOB round-trips to a Float32Array)", async () => {
  const stub = markerStub();
  await withCtx({ embeddings: true, embedder: stub }, async (ctx) => {
    await ctx.index();
    assert.equal(ctx.store.embeddingCount(), 3, "one vector per indexed file");
    const v = ctx.store.getEmbeddings(["two.js"]).get("two.js");
    assert.ok(v instanceof Float32Array && v.length === 2, "stored BLOB round-trips to the vector");
    assert.deepEqual([...v], [1, 0], "two.js → [alpha=1, beta=0] survives the BLOB round-trip");
  });
});

// The library defaults embeddings OFF but the CLI/hook defaults them ON, so the common lifecycle is:
// `ctx.index()` (off) writes chunks with no vectors, then a later warm-index pass turns the tier ON over
// UNCHANGED files. The content diff correctly fast-skips them — so without a backfill they'd stay
// vectorless forever and semantic recall would be silently dead. The backfill embeds any indexed file
// that has no vector, without re-chunking. Two ctx over one persistent db mirror the two real processes.
test("embeddings backfill: a file indexed with the tier OFF gets a vector on a later ON pass, idempotently", async () => {
  const root = fixture();
  const dbPath = join(root, "idx.db");

  const off = new LiteCtx({ root, dbPath, embeddings: false });
  await off.index();
  assert.equal(off.store.embeddingCount(), 0, "the off pass stores no vectors (the library default)");
  off.close();

  const stub = markerStub();
  const on = new LiteCtx({ root, dbPath, embeddings: true, embedder: stub });
  const r = await on.index();
  assert.equal(r.unchanged, 3, "the files ARE content-unchanged — the diff correctly fast-skips them");
  assert.equal(stub.calls, 3, "yet all three are embedded: the backfill, not the diff, did it");
  assert.equal(on.store.embeddingCount(), 3, "every previously-vectorless file now carries a vector");

  await on.index();
  assert.equal(stub.calls, 3, "a warm re-index backfills NOTHING — idempotent, no per-pass re-embed tax");
  on.close();
  rmSync(root, { recursive: true, force: true });
});

test("indexing embeds only CHANGED files (incremental — reuses stored vectors)", async () => {
  const stub = markerStub();
  await withCtx({ embeddings: true, embedder: stub }, async (ctx, root) => {
    await ctx.index();
    assert.equal(stub.calls, 3, "first pass embeds all three files");
    await ctx.index(); // nothing changed
    assert.equal(stub.calls, 3, "a no-op re-index embeds nothing");
    writeFileSync(join(root, "two.js"), "export function two() { return widget; } // alpha alpha\n");
    await ctx.index();
    assert.equal(stub.calls, 4, "only the one changed file is re-embedded, not all three");
  });
});

test("deleting a file drops its stored embedding", async () => {
  const stub = markerStub();
  await withCtx({ embeddings: true, embedder: stub }, async (ctx, root) => {
    await ctx.index();
    assert.equal(ctx.store.embeddingCount(), 3);
    unlinkSync(join(root, "three.js"));
    await ctx.index(); // full pass reconciles the deletion
    assert.equal(ctx.store.embeddingCount(), 2, "the removed file's vector is gone");
    assert.equal(ctx.store.getEmbeddings(["three.js"]).size, 0);
  });
});

test("the fused re-rank lifts the semantically-closest file to #1 (high weight → semantic dominates)", async () => {
  const stub = markerStub();
  // weight 50 → semantic term dominates the fusion, so the cosine-nearest pooled file must rank first.
  await withCtx({ embeddings: true, embedder: stub, embedWeight: 50 }, async (ctx) => {
    await ctx.index();
    // query → [alpha=1, beta=0]; two.js is the only file with cosine 1 to it.
    const hits = await ctx.recall("widget alpha", { kind: "code", n: 5 });
    assert.ok(hits.length >= 2, "all marker files are in the pool via the shared 'widget' term");
    assert.equal(hits[0].path, "two.js", "the alpha file (cosine 1) is lifted to #1 by the semantic term");
  });
});

test("an uninformative semantic signal preserves the dual ranking (no corruption)", async () => {
  // a stub that returns the SAME vector for everything → constant cosine → min-max flattens it → the
  // semantic term adds an equal constant to every candidate → the BM25+spread order is preserved.
  const constStub = { async embed() { return Float32Array.from([1, 0]); } };
  await withCtx({ embeddings: true, embedder: constStub }, async (ctx) => {
    await ctx.index();
    const on = (await ctx.recall("widget", { kind: "code", n: 5 })).map((h) => h.path);
    ctx.embeddings = false; // same ctx, dual path
    const off = (await ctx.recall("widget", { kind: "code", n: 5 })).map((h) => h.path);
    assert.deepEqual(on, off, "a constant semantic signal does not reorder the dual ranking");
  });
});

test("the query embedding is cached (a repeated query is not re-embedded)", async () => {
  const stub = markerStub();
  await withCtx({ embeddings: true, embedder: stub }, async (ctx) => {
    await ctx.index();
    const base = stub.calls; // = 3 (the files)
    await ctx.recall("widget alpha", { kind: "code" });
    assert.equal(stub.calls, base + 1, "first recall embeds the query once");
    await ctx.recall("widget alpha", { kind: "code" });
    assert.equal(stub.calls, base + 1, "the identical query is served from the LRU cache");
  });
});

test("the real Embedder fails loudly when the optional peer dep is absent", async (t) => {
  // @huggingface/transformers is NOT a dependency of the core (optional peer dep) — so importing it
  // from the lib root fails, and the tier must say so clearly rather than silently producing no
  // vectors. The contract only exists where the dep is absent: a dev box with the model installed for
  // local bench runs (`poc/memory-bench.mjs --embeddings`) skips, same discipline as the bench corpora.
  try {
    await import("@huggingface/transformers");
    t.skip("@huggingface/transformers is installed here — the missing-dep contract is untestable");
    return;
  } catch {
    /* absent — the contract under test applies */
  }
  await assert.rejects(
    () => new Embedder().embed("anything"),
    /@huggingface\/transformers/,
    "a missing model dependency is a clear, actionable error"
  );
});

// The vector-table split (mem_embeddings vs file_embeddings). Written-memory vectors used to share
// file_embeddings keyed by memKey — which in the global tier is the BARE id, indistinguishable from a
// file path. A remember() whose id equalled an indexed file's path then CLOBBERED that file's vector on
// the one shared row (and a forget deleted it). This pins that a colliding id keeps the two vectors
// independent and that recall reads the right table per kind. Written to fail on the shared-table bug.
test("a global-tier remember() whose id equals a file path does NOT clobber the file's vector", async () => {
  const stub = markerStub();
  await withCtx({ embeddings: true, embedder: stub }, async (ctx) => {
    await ctx.index(); // two.js carries the "alpha" marker → file vector ~[1,0]
    const fileVec = Array.from(ctx.store.getEmbeddings(["two.js"], "code").get("two.js") ?? []);
    assert.deepEqual(fileVec, [1, 0], "precondition: the file's vector is the alpha marker");

    // a fact whose id COLLIDES with the file path, unrelated semantics (beta marker → ~[0,1])
    await ctx.remember("two.js", "beta beta", { kind: "fact" });

    // the file's vector is untouched; the fact's lives in its own keyspace
    assert.deepEqual(Array.from(ctx.store.getEmbeddings(["two.js"], "code").get("two.js") ?? []), [1, 0], "file (code) vector survived the colliding write");
    assert.deepEqual(Array.from(ctx.store.getEmbeddings(["two.js"], "fact").get("two.js") ?? []), [0, 1], "fact vector reads from mem_embeddings, not the file's row");
    // both rows coexist physically — one per table, no shared PK
    assert.equal(ctx.store.db.prepare("SELECT COUNT(*) c FROM file_embeddings WHERE path='two.js'").get().c, 1, "file vector row present");
    assert.equal(ctx.store.db.prepare("SELECT COUNT(*) c FROM mem_embeddings WHERE path='two.js'").get().c, 1, "mem vector row present");

    // and a forget of the colliding fact leaves the file's vector intact (forget touches mem_embeddings only)
    ctx.forget("two.js");
    assert.deepEqual(Array.from(ctx.store.getEmbeddings(["two.js"], "code").get("two.js") ?? []), [1, 0], "forget did not delete the file's vector");
    assert.equal(ctx.store.db.prepare("SELECT COUNT(*) c FROM mem_embeddings WHERE path='two.js'").get().c, 0, "the fact's vector is gone");
  });
});

// #3 — the RESIDUAL the table-split left for `doc`, the one recall kind spanning BOTH vector tables.
// `getEmbeddings('doc')` reads file_embeddings THEN mem_embeddings into one PATH-keyed map, so when a
// written doc's id equals an indexed `.md` path (both embedded), the mem vector silently overwrote the
// file vector at cosine time. docCandidateVectors routes each candidate by its OWN `source` and returns
// vectors POSITIONALLY, so a file-doc and a written-doc sharing a path each keep their own vector.
test("docCandidateVectors routes each doc candidate to its source's table — no cross-table clobber on a shared path", async () => {
  await withCtx({ embeddings: true, embedder: markerStub() }, async (ctx) => {
    const P = "README.md";
    const buf = (/** @type {Float32Array} */ v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
    ctx.store.db.prepare("INSERT INTO file_embeddings(path,dim,vec) VALUES (?,2,?)").run(P, buf(Float32Array.from([1, 0])));
    ctx.store.db.prepare("INSERT INTO mem_embeddings(path,dim,vec) VALUES (?,2,?)").run(P, buf(Float32Array.from([0, 1])));
    // two candidates share the path but differ in source — each must resolve to its OWN table's vector
    const out = ctx.store.docCandidateVectors([{ path: P, source: "file" }, { path: P, source: "direct" }]);
    assert.deepEqual(Array.from(out[0] ?? []), [1, 0], "the file-doc candidate reads file_embeddings");
    assert.deepEqual(Array.from(out[1] ?? []), [0, 1], "the written-doc candidate reads mem_embeddings — NOT clobbered by the file row");
  });
});

// End-to-end through recall: a file-doc must be re-ranked on its OWN vector even when a written doc shares
// its path. The fixture is built so cosine is the SOLE tiebreaker — `answer.md` and `decoy.md` match the
// query's one FTS term ("widget") identically, so BM25 ties; only the vectors differ. `answer`'s file
// vector ALIGNS with the query (cosine +1) while `decoy` is orthogonal (0) — so with the fix `answer` is
// #1. The colliding written doc's vector OPPOSES the query (cosine −1): if it clobbers `answer`'s file
// vector (the bug), `answer` drops below `decoy` and the test flips. Mutation-verified both directions.
// A synonym stub keeps the vector markers OUT of the FTS-matched terms (else they'd perturb BM25).
function synVecStub() {
  const map = { QQUERY: [1, 0], AFILE: [1, 0], AWRIT: [-1, 0] }; // QQUERY≈AFILE (query/file synonyms); AWRIT opposes
  return {
    /** @param {string} t */
    async embed(t) {
      for (const k in map) if (t.includes(k)) return Float32Array.from(map[k]);
      return Float32Array.from([0, 0]);
    },
  };
}
test("doc recall re-ranks a file-doc on its file vector, not a same-path written doc's vector", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-doc3-"));
  writeFileSync(join(root, "answer.md"), "widget AFILE\n"); // file vec [1,0]; matches query on "widget"
  writeFileSync(join(root, "decoy.md"), "widget ADECOY\n"); // vec [0,0]; identical FTS profile → BM25 ties
  try {
    const ctx = new LiteCtx({ root, dbPath: join(root, "db.sqlite"), embeddings: true, embedder: synVecStub(), include: [".md"] });
    await ctx.index();
    // a written doc whose id EQUALS the indexed file path, with an OPPOSING vector (AWRIT → [-1,0]). "AWRIT"
    // shares no term with the query, so the written doc is not itself a candidate — it exists only to collide.
    await ctx.remember("answer.md", "AWRIT", { kind: "doc" });
    const hits = await ctx.recall("widget QQUERY", { kind: "doc", n: 5 });
    assert.equal(hits[0]?.path, "answer.md", "the file-doc ranks #1 on its own file vector; the same-path written doc must not clobber it");
    assert.equal("source" in hits[0], false, "the internal routing field never surfaces on a public hit");
    ctx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Upgrade path: a db written by an older litectx has its written-memory vectors in the shared
// file_embeddings table. Opening it with the split-table code must MOVE those (and only those) into
// mem_embeddings — a file's own vector stays put. Simulated by planting the old layout via raw SQL.
test("migration moves written vectors out of the shared file_embeddings, leaving file vectors alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-emb-mig-"));
  writeFileSync(join(root, "two.js"), "export function two() { return widget; } // alpha\n");
  const dbPath = join(root, "idx.db");
  try {
    // build the "old" layout: a file vector + a written-memory vector BOTH in file_embeddings
    const a = new LiteCtx({ root, dbPath, embeddings: true, embedder: markerStub() });
    await a.index();                                        // file vector → file_embeddings['two.js']
    await a.remember("fact:note", "beta", { kind: "fact" }); // written vector → mem_embeddings['fact:note']
    // regress it to the pre-split shape: move the mem vector back into file_embeddings
    a.store.db.exec("INSERT INTO file_embeddings SELECT * FROM mem_embeddings WHERE path='fact:note'");
    a.store.db.exec("DELETE FROM mem_embeddings");
    a.close();
    assert.ok(true);

    // reopen → the constructor migration runs
    const b = new LiteCtx({ root, dbPath, embeddings: true, embedder: markerStub() });
    const cnt = (/** @type {string} */ t, /** @type {string} */ p) => b.store.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE path=?`).get(p).c;
    assert.equal(cnt("mem_embeddings", "fact:note"), 1, "the written vector was migrated into mem_embeddings");
    assert.equal(cnt("file_embeddings", "fact:note"), 0, "…and removed from the shared table");
    assert.equal(cnt("file_embeddings", "two.js"), 1, "the FILE's own vector was left untouched");
    assert.equal(cnt("mem_embeddings", "two.js"), 0, "…and not dragged into mem_embeddings");
    // the migrated vector is still usable by fact recall
    assert.deepEqual(Array.from(b.store.getEmbeddings(["fact:note"], "fact").get("fact:note") ?? []), [0, 1], "migrated vector reads back correctly");
    b.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
