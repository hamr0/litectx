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
