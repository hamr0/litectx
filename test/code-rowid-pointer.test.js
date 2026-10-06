// Code rows are reached through their `docs` ROWID, never by a scan of `docs` (`path` is an UNINDEXED fts5 column,
// so a by-path lookup/delete reads every code body — ~0.3ms per 1k files per call, which made a cold index
// super-linear: 2k files 1.7s, 20k 71s). The pointer is `file_index.code_rowid` (written in the same transaction as
// the `docs` row; -1 = a doc file with no code row; NULL = unknown/legacy, filled by the open-time heal or on first
// use). Guard names so a mutation run reads off the failure list:
//   [ROUTE] delete/upsert/get resolve by the pointer   [LIFE] the pointer stays true across every index lifecycle
//   [LEGACY] a NULL pointer still works and is healed

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const repo = (files) => {
  const root = mkdtempSync(join(tmpdir(), "litectx-crid-"));
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [p, t] of Object.entries(files)) writeFileSync(join(root, p), t);
  return root;
};
const F = { "src/a.js": "export function alpha() { return 1; }\n", "src/b.js": "export function bravo() { return 2; }\n", "src/c.py": "def charlie():\n    return 3\n", "notes.md": "# Notes\n\nzebra section\n" };
const rows = (ctx, sql, ...a) => ctx.store.db.prepare(sql).all(...a);
const fresh = async (files = F) => {
  const root = repo(files);
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  return { root, ctx };
};
// every indexed code file points at exactly its own `docs` row; every doc file at -1; no `docs` row is unpointed
const pointersHold = (ctx) => {
  const fi = rows(ctx, "SELECT f.path AS path, f.code_rowid AS rid, d.path AS dpath FROM file_index f LEFT JOIN docs d ON d.rowid = f.code_rowid");
  const code = fi.filter((r) => r.rid !== -1);
  const pointed = code.every((r) => r.rid != null && r.dpath === r.path);
  const nDocs = rows(ctx, "SELECT count(*) AS n FROM docs")[0].n;
  return pointed && nDocs === code.length && rows(ctx, "SELECT count(DISTINCT path) AS n FROM docs")[0].n === nDocs;
};
const codeHits = async (ctx, q) => (await ctx.recall(q, { kind: "code", n: 10, log: false })).map((h) => h.path).sort();

test("[ROUTE] every indexed file carries its docs rowid (code) or -1 (doc), written with the row", async () => {
  const { ctx } = await fresh();
  const m = Object.fromEntries(rows(ctx, "SELECT path, code_rowid AS r FROM file_index").map((r) => [r.path, r.r]));
  assert.equal(m["notes.md"], -1, "a doc file has no code row");
  for (const p of ["src/a.js", "src/b.js", "src/c.py"]) {
    assert.ok(m[p] > 0, `${p} has a pointer`);
    assert.equal(rows(ctx, "SELECT path FROM docs WHERE rowid = ?", m[p])[0].path, p, `${p}'s pointer names its own row`);
  }
  assert.ok(pointersHold(ctx));
});

test("[ROUTE] upsert, delete and get never scan `docs` by path", async () => {
  const { root, ctx } = await fresh();
  const seen = [];
  const prep = ctx.store.db.prepare.bind(ctx.store.db);
  ctx.store.db.prepare = (sql) => (seen.push(sql), prep(sql));
  writeFileSync(join(root, "src", "a.js"), "export function alpha() { return 11; }\n");
  rmSync(join(root, "src", "b.js"));
  await ctx.index();
  assert.ok(ctx.get("src/a.js"));
  assert.equal(ctx.get("nope-nothing"), null);
  assert.ok(ctx.store.getItemByKey("src/c.py"));
  const scans = seen.filter((s) => /\bFROM docs\b[^;]*\bWHERE\b[^;]*\bpath\s*=/.test(s) && !/rowid\s*=/.test(s));
  assert.deepEqual(scans, [], "no by-path scan of the code table");
  assert.ok(pointersHold(ctx));
});

test("[ROUTE] the pointer, not a path scan, decides what an upsert replaces", async () => {
  const { root, ctx } = await fresh();
  // forge 'no code row' for a.js: if the delete scanned by path it would still remove the old row and re-pointer cleanly
  ctx.store.db.prepare("UPDATE file_index SET code_rowid = -1 WHERE path = 'src/a.js'").run();
  writeFileSync(join(root, "src", "a.js"), "export function alpha() { return 22; }\n");
  await ctx.index();
  assert.equal(rows(ctx, "SELECT count(*) AS n FROM docs WHERE path = 'src/a.js'")[0].n, 2, "the forged -1 was trusted: the old row was not found by scan");
});

test("[ROUTE] get / getItemByKey return the right row and null for unknown or doc-file paths", async () => {
  const { ctx } = await fresh();
  assert.match(ctx.store.getItemByKey("src/b.js").text ?? "", /bravo|/);
  assert.equal(ctx.store.getItemByKey("src/b.js").kind, "code");
  assert.equal(ctx.store.getItemByKey("src/zzz.js"), null);
  assert.equal(ctx.get("src/zzz.js"), null);
  assert.equal(ctx.get("notes.md").kind, "doc");
});

test("[LIFE] file delete and rename keep pointers true and recall exact", async () => {
  const { root, ctx } = await fresh();
  rmSync(join(root, "src", "b.js"));
  renameSync(join(root, "src", "a.js"), join(root, "src", "a2.js"));
  await ctx.index();
  assert.ok(pointersHold(ctx));
  assert.deepEqual(await codeHits(ctx, "bravo"), []);
  assert.deepEqual(await codeHits(ctx, "alpha"), ["src/a2.js"]);
  assert.equal(ctx.get("src/b.js"), null);
});

test("[LIFE] edit then force full index, and a no-op re-index, keep exactly one row per file", async () => {
  const { root, ctx } = await fresh();
  writeFileSync(join(root, "src", "a.js"), "export function alpha() { return 99; }\n");
  await ctx.index();
  assert.ok(pointersHold(ctx));
  await ctx.index({ force: true });
  assert.ok(pointersHold(ctx));
  assert.equal(rows(ctx, "SELECT count(*) AS n FROM docs WHERE path='src/a.js'")[0].n, 1);
  await ctx.index();
  assert.ok(pointersHold(ctx));
  assert.deepEqual(await codeHits(ctx, "alpha"), ["src/a.js"]);
});

test("[LIFE] a partial index({paths}) and a scoped force leave out-of-scope pointers alone", async () => {
  const { root, ctx } = await fresh();
  const before = rows(ctx, "SELECT path, code_rowid AS r FROM file_index WHERE path IN ('src/b.js','src/c.py')");
  writeFileSync(join(root, "src", "a.js"), "export function alpha() { return 5; }\n");
  await ctx.index({ paths: ["src/a.js"] });
  assert.deepEqual(rows(ctx, "SELECT path, code_rowid AS r FROM file_index WHERE path IN ('src/b.js','src/c.py')"), before, "out-of-scope rows untouched");
  assert.ok(pointersHold(ctx));
  await ctx.index({ paths: ["src/a.js"], force: true }); // (a scoped force re-chunks files too, new rowids: only truth matters)
  assert.ok(pointersHold(ctx));
  assert.deepEqual(await codeHits(ctx, "bravo"), ["src/b.js"]);
});

test("[LIFE] a stamp-forced full rebuild re-points every file", async () => {
  const { root, ctx } = await fresh();
  ctx.store.setStoredStamp(12345);
  writeFileSync(join(root, "src", "c.py"), "def charlie():\n    return 33\n");
  await ctx.index();
  assert.ok(pointersHold(ctx));
  assert.deepEqual(await codeHits(ctx, "charlie"), ["src/c.py"]);
  ctx.store.setStoredStamp(12345);
  await ctx.index({ paths: ["src/a.js"] }); // stale + partial: in-scope entries invalidated, never deleted
  assert.ok(pointersHold(ctx));
});

test("[LEGACY] NULL pointers are healed on open (a pre-pointer db) and answers are unchanged", async () => {
  const root = repo(F);
  const dbPath = join(root, "x.db");
  const a = new LiteCtx({ root, dbPath });
  await a.index();
  const want = await codeHits(a, "alpha");
  a.store.db.prepare("UPDATE file_index SET code_rowid = NULL").run();
  a.close();
  const b = new LiteCtx({ root, dbPath });
  assert.equal(rows(b, "SELECT count(*) AS n FROM file_index WHERE code_rowid IS NULL")[0].n, 0, "healed at open");
  assert.equal(rows(b, "SELECT code_rowid AS r FROM file_index WHERE path='notes.md'")[0].r, -1);
  assert.ok(pointersHold(b));
  assert.deepEqual(await codeHits(b, "alpha"), want);
});

test("[LEGACY] a column-less file_index (older schema) is migrated by ALTER and backfilled", async () => {
  const root = repo(F);
  const dbPath = join(root, "y.db");
  const a = new LiteCtx({ root, dbPath });
  await a.index();
  a.store.db.exec("DROP INDEX file_index_nocoderid; ALTER TABLE file_index DROP COLUMN code_rowid");
  a.close();
  const b = new LiteCtx({ root, dbPath });
  assert.ok(pointersHold(b));
  await b.index({ force: true });
  assert.ok(pointersHold(b));
});

test("[LEGACY] a NULL pointer met mid-run falls back to the scan once, and the pointer is filled", async () => {
  const { root, ctx } = await fresh();
  ctx.store.db.prepare("UPDATE file_index SET code_rowid = NULL").run();
  assert.ok(ctx.get("src/b.js"), "get falls back by path");
  assert.ok(rows(ctx, "SELECT code_rowid AS r FROM file_index WHERE path='src/b.js'")[0].r > 0, "and records the pointer");
  writeFileSync(join(root, "src", "a.js"), "export function alpha() { return 7; }\n");
  await ctx.index(); // upsert of a NULL-pointer file must replace, not duplicate
  assert.equal(rows(ctx, "SELECT count(*) AS n FROM docs WHERE path='src/a.js'")[0].n, 1);
  rmSync(join(root, "src", "c.py"));
  await ctx.index();
  assert.equal(rows(ctx, "SELECT count(*) AS n FROM docs WHERE path='src/c.py'")[0].n, 0, "a delete of a NULL-pointer file still removes its row");
});
