// Cold-build batching (v0.37.x). A first build commits in batches so a concurrent reader sees results fill in;
// a rebuild over an EXISTING index stays one atomic transaction. Each test is written to FAIL if its half regresses
// (mutation-verified: forcing `batched = false` fails #1/#3; forcing `batched` true fails #2/#6-class guards).
// `ctx._batchFiles` is an internal test hook (the batch size is a constant, not a config option).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import { indexStamp } from "../src/indexer.js";

const N = 11;
function repo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-cold-"));
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < N; i++) {
    const imp = i > 0 ? `import { feature${i - 1} } from "./m${i - 1}.js";\n` : "";
    writeFileSync(join(root, "src", `m${i}.js`), `${imp}/** documented unit ${i} */\nexport function feature${i}(x){ return x + ${i}; }\n`);
  }
  writeFileSync(join(root, "NOTES.md"), "# Title\n\nintro text\n\n## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n");
  return root;
}
const open = (root, db) => {
  const c = new LiteCtx({ root, dbPath: join(root, db) });
  c._batchFiles = 2;
  return c;
};
const hashes = (c) => c.store.db.prepare("SELECT path, content_hash h FROM file_index ORDER BY path").all().map((r) => `${r.path}:${r.h}`).join("|");
const count = (c) => c.store.db.prepare("SELECT COUNT(*) c FROM file_index").get().c;
const dump = (c) => {
  const q = (sql) => c.store.db.prepare(sql).all();
  return JSON.stringify({
    docs: q("SELECT path, kind, format, source, body FROM docs ORDER BY path, body"),
    doc_fts: q("SELECT path, kind, format, source, body FROM doc_fts ORDER BY path, body"),
    nodes: q("SELECT path, kind, symbol, node_type, start_line, end_line, body, stamp FROM nodes ORDER BY path, start_line, body"),
    edges: q("SELECT type, src_path, dst_path FROM edges ORDER BY src_path, dst_path"),
    file_index: q("SELECT path, content_hash, size FROM file_index ORDER BY path"),
    sections: q("SELECT path FROM doc_sections ORDER BY path, node_id"),
    stamp: c.store.storedStamp(),
  });
};

test("#1 cold build: a second connection sees rows before the pass ends", async () => {
  const root = repo();
  const w = open(root, "idx.db");
  const r = new LiteCtx({ root, dbPath: join(root, "idx.db") });
  try {
    let seen = -1;
    await w.index({ onProgress: ({ done, total }) => { if (done === total && total > 0) seen = count(r); } });
    assert.ok(seen > 0 && seen < N + 1, `reader saw a partial index mid-pass (${seen} of ${N + 1})`);
    assert.equal(count(r), N + 1, "and the whole index after");
  } finally { w.close(); r.close(); rmSync(root, { recursive: true, force: true }); }
});

test("#2 rebuild over an existing index stays atomic: reader sees the old rows, never a partial new set", async () => {
  const root = repo();
  const w = open(root, "idx.db");
  const r = new LiteCtx({ root, dbPath: join(root, "idx.db") });
  try {
    await w.index();
    const old = hashes(r);
    for (let i = 0; i < N; i++) writeFileSync(join(root, "src", `m${i}.js`), `export function zebra${i}(){ return ${i * 7}; }\n`);
    const during = [];
    await w.index({ onProgress: () => during.push(hashes(r)) });
    assert.ok(during.length > 3);
    assert.ok(during.every((h) => h === old), "every observation mid-pass equals the old index");
    assert.notEqual(hashes(r), old, "and the new index lands after");
    // a force rebuild is atomic too
    const old2 = hashes(r);
    const d2 = [];
    await w.index({ force: true, onProgress: () => d2.push(hashes(r)) });
    assert.ok(d2.every((h) => h === old2));
  } finally { w.close(); r.close(); rmSync(root, { recursive: true, force: true }); }
});

test("#3 cancel mid cold build: batches kept, NOT stamped current; next index() finishes to the same final state", async () => {
  const root = repo();
  const w = open(root, "cut.db");
  const ref = open(root, "ref.db");
  try {
    await ref.index();
    const ac = new AbortController();
    const res = await w.index({ signal: ac.signal, onProgress: ({ done }) => { if (done === 5) ac.abort(); } });
    assert.equal(res.aborted, true);
    assert.equal(count(w), 4, "the two committed batches (2 files each) survive; the in-flight third does not");
    assert.notEqual(w.store.storedStamp(), indexStamp(), "not marked current");
    assert.equal(w.store.storedStamp(), -indexStamp(), "marked in-progress");

    const total = [];
    const res2 = await w.index({ onProgress: (p) => total.push(p.total) });
    assert.equal(res2.aborted, false);
    assert.equal(total[0], N + 1 - 4, "resumed incrementally: only the remainder is re-indexed, not from zero");
    assert.equal(res2.added, N + 1 - 4);
    assert.equal(w.store.storedStamp(), indexStamp());
    assert.equal(dump(w), dump(ref), "final state identical to an uninterrupted build");
  } finally { w.close(); ref.close(); rmSync(root, { recursive: true, force: true }); }
});

test("#4 final state: batched cold build == single-transaction build", async () => {
  const root = repo();
  const a = open(root, "a.db");
  const b = open(root, "b.db");
  b._batchFiles = 100000; // one batch
  try {
    await a.index();
    await b.index();
    assert.equal(dump(a), dump(b));
    assert.equal(a.store.storedStamp(), indexStamp());
  } finally { a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
});

test("#5 onProgress: increasing done, ends at total; warm no-op pass reports 0 of 0", async () => {
  const root = repo();
  const w = open(root, "idx.db");
  try {
    const seen = [];
    await w.index({ onProgress: (p) => seen.push(p) });
    assert.deepEqual(seen[0], { done: 0, total: N + 1 });
    assert.deepEqual(seen.at(-1), { done: N + 1, total: N + 1 });
    for (let i = 1; i < seen.length; i++) assert.equal(seen[i].done, seen[i - 1].done + 1);
    const warm = [];
    await w.index({ onProgress: (p) => warm.push(p) });
    assert.deepEqual(warm, [{ done: 0, total: 0 }]);
  } finally { w.close(); rmSync(root, { recursive: true, force: true }); }
});

test("#6 a paths-scoped cold pass never batches and never stamps", async () => {
  const root = repo();
  const w = open(root, "idx.db");
  const r = new LiteCtx({ root, dbPath: join(root, "idx.db") });
  try {
    const during = [];
    await w.index({ paths: ["src"], onProgress: () => during.push(count(r)) });
    assert.ok(during.every((c) => c === 0), "single commit at the end");
    assert.equal(w.store.storedStamp(), 0);
  } finally { w.close(); r.close(); rmSync(root, { recursive: true, force: true }); }
});
