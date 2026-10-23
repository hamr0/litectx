// index({ signal }) — cancel keeps the work done so far. The keyword index commits whole in one
// transaction; vectors are written file by file after it, so an abort mid-embed keeps every vector
// written, and the next pass embeds only what is still missing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LiteCtx } from "../src/index.js";

const N = 6;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "litectx-abort-"));
  for (let i = 1; i <= N; i++) writeFileSync(join(root, `m${i}.js`), `export function quokka${i}() { return ${i}; }\n`);
  return root;
}
const vecCount = (root) => {
  const db = new Database(join(root, ".litectx", "index.db"));
  try {
    return { n: db.prepare("SELECT count(*) AS n FROM file_embeddings").get().n, ok: db.pragma("integrity_check")[0].integrity_check };
  } finally {
    db.close();
  }
};
/** embedder stub: counts calls per input, optionally runs a hook before answering */
function stub(hook) {
  const seen = [];
  return { seen, embed: async (t) => { seen.push(t); await hook?.(seen.length); return new Float32Array(8).fill(0.1 * seen.length); } };
}

test("a pre-aborted signal writes nothing and resolves aborted", async () => {
  const root = fixture();
  try {
    const ctx = new LiteCtx({ root, embeddings: true, embedder: stub() });
    const r = await ctx.index({ signal: AbortSignal.abort() });
    assert.equal(r.aborted, true);
    assert.equal(ctx.size(), 0, "nothing committed");
    ctx.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("abort mid-embed keeps the full keyword index and the vectors written so far; the next pass embeds only the rest", async () => {
  const root = fixture();
  try {
    const ac = new AbortController();
    const e1 = stub((n) => { if (n === 3) ac.abort(); });
    const a = new LiteCtx({ root, embeddings: true, embedder: e1 });
    const r = await a.index({ signal: ac.signal });
    assert.equal(r.aborted, true);
    assert.equal(e1.seen.length, 3, "stopped after the in-flight embed");
    assert.equal(r.embedded, 3);
    assert.equal(r.embedPending, N - 3);
    assert.equal(a.size(), N, "every file is in the keyword index");
    const hits = await a.recall("quokka4", { kind: "code" }); // partial vectors: recall still answers
    assert.ok(hits.some((h) => h.path === "m4.js"));
    a.close();
    assert.deepEqual(vecCount(root), { n: 3, ok: "ok" });

    const e2 = stub();
    const b = new LiteCtx({ root, embeddings: true, embedder: e2 });
    const r2 = await b.index();
    assert.equal(r2.aborted, false);
    assert.equal(e2.seen.length, N - 3, "resumed: only the files without a vector were embedded");
    b.close();
    assert.deepEqual(vecCount(root), { n: N, ok: "ok" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a reader during the embed phase sees the whole keyword index", async () => {
  const root = fixture();
  try {
    let seenFiles = -1;
    const w = new LiteCtx({ root, embeddings: true, embedder: stub(async (n) => {
      if (n === 1) {
        const reader = new LiteCtx({ root });
        seenFiles = reader.size();
        reader.close();
      }
    }) });
    await w.index();
    w.close();
    assert.equal(seenFiles, N, "all files visible before the first vector is written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
