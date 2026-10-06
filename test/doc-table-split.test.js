// Code and docs live in SEPARATE FTS5 tables (`docs` = code, `doc_fts` = kind='doc'). BM25 stats are
// table-wide, so a shared table let md rows shift CODE ranking. These tests pin: the physical split, that
// code recall is unmoved by md, and the one-time migration of an old-layout db (written docs survive).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LiteCtx } from "../src/index.js";

const enc = (s) => new TextEncoder().encode(s);

// code files and md files sharing many terms, so md rows would move code IDF/avg-length if they shared a table
const JS = {
  "auth.js": "export function validateToken(token) { return token.length > 0; }\nexport function refreshToken(session) { return session.token; }\n",
  "session.js": "export function openSession(user) { return { user, token: user.token }; }\n",
  "cache.js": "export function cacheLookup(key) { return key; }\nexport function cacheStore(key, value) { return value; }\n",
  "util.js": "export function formatUser(user) { return String(user); }\n",
};
const MD = {
  "guide.md": "# Token handling\n\nthe token session user cache lookup flow validate refresh\n\n## Session cache\n\nsession token cache user store lookup format\n\n## Users\n\nuser token session validate format cache\n",
  "notes.md": "# Notes\n\ntoken token token session session cache cache user user validate lookup\n\n## More\n\nvalidate token refresh session cache store\n",
};

function repo(withMd) {
  const root = mkdtempSync(join(tmpdir(), "litectx-split-"));
  mkdirSync(join(root, "src"));
  for (const [f, t] of Object.entries(JS)) writeFileSync(join(root, "src", f), t);
  if (withMd) for (const [f, t] of Object.entries(MD)) writeFileSync(join(root, f), t);
  return root;
}
const rows = (ctx, sql, ...a) => ctx.store.db.prepare(sql).all(...a);

test("code rows live only in `docs`, doc rows only in `doc_fts` (indexed md, written doc, ingest, blob)", async () => {
  const root = repo(true);
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  await ctx.remember("doc:w", "a written token doc", { kind: "doc" });
  await ctx.ingest(enc("# Up\n\nuploaded token text"), { filename: "up.md" });
  await ctx.ingest(enc("PK\x03\x04binary"), { filename: "sheet.xlsx" });
  assert.deepEqual(rows(ctx, "SELECT DISTINCT kind FROM docs").map((r) => r.kind), ["code"]);
  assert.deepEqual(rows(ctx, "SELECT DISTINCT kind FROM doc_fts").map((r) => r.kind), ["doc"]);
  const srcs = new Set(rows(ctx, "SELECT DISTINCT source FROM doc_fts").map((r) => r.source));
  assert.deepEqual([...srcs].sort(), ["direct", "file"]);
  assert.ok(rows(ctx, "SELECT 1 FROM doc_fts WHERE path=char(30)||'doc:sheet' AND format='xlsx'").length >= 1, "blob filename row is in doc_fts");
  assert.ok((await ctx.recall("token", { kind: "doc" })).length > 0);
  assert.ok((await ctx.recall("validateToken", { kind: "code" })).length > 0);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("kind:'code' recall is identical (paths AND scores) whether or not md is in the repo", async () => {
  const a = repo(true);
  const b = repo(false);
  const withMd = new LiteCtx({ root: a, dbPath: ":memory:" });
  const without = new LiteCtx({ root: b, dbPath: ":memory:" });
  await withMd.index();
  await without.index();
  for (const query of ["token", "session cache", "validate token", "user", "cache lookup store", "format user"]) {
    const x = (await withMd.recall(query, { kind: "code", n: 10 })).map((h) => [h.path, h.score]);
    const y = (await without.recall(query, { kind: "code", n: 10 })).map((h) => [h.path, h.score]);
    assert.ok(x.length > 0, `precondition: "${query}" hits code`);
    assert.deepEqual(x, y, `code ranking for "${query}" must not depend on md`);
  }
  withMd.close();
  without.close();
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});

test("migration: an old-layout db (doc rows inside `docs`) moves written docs to doc_fts, drops file md, and is idempotent", async () => {
  const root = repo(true);
  const dbPath = join(root, "old.db");
  // 1. build a populated db with the current code, then rewrite it into the OLD layout with raw SQL
  const seed = new LiteCtx({ root, dbPath });
  await seed.index();
  await seed.remember("doc:written", "a written token note about quokkas", { kind: "doc", scope: "tenantA" });
  await seed.ingest(enc("# Seg\n\nuploaded zebra paragraph one\n\nuploaded zebra paragraph two"), { filename: "up.txt", scope: "tenantA" });
  await seed.ingest(enc("PK\x03\x04binary"), { filename: "sheet.xlsx", scope: "tenantA" });
  const directBefore = rows(seed, "SELECT path, kind, format, source, provenance, occurred_at, body FROM doc_fts WHERE source='direct' ORDER BY path");
  assert.ok(directBefore.length >= 3, "precondition: written doc + ingest segments + blob rows");
  seed.close();
  const raw = new Database(dbPath);
  raw.exec("INSERT INTO docs(path, kind, format, source, provenance, occurred_at, body) SELECT path, kind, format, source, provenance, occurred_at, body FROM doc_fts");
  raw.exec("DROP TABLE doc_fts"); // an old db has no such table
  raw.pragma("user_version = 12345");
  assert.ok(raw.prepare("SELECT 1 FROM docs WHERE kind='doc' AND source='file'").get(), "precondition: old-layout file md row");
  raw.close();

  // 2. open with the new code
  const ctx = new LiteCtx({ root, dbPath });
  assert.equal(rows(ctx, "SELECT 1 FROM docs WHERE kind='doc'").length, 0, "`docs` has no kind='doc' rows");
  const directAfter = rows(ctx, "SELECT path, kind, format, source, provenance, occurred_at, body FROM doc_fts WHERE source='direct' ORDER BY path");
  assert.deepEqual(directAfter, directBefore, "direct/ingest/blob rows moved with identical columns");
  assert.equal(rows(ctx, "SELECT 1 FROM doc_fts WHERE source='file'").length, 0, "file md rows dropped (re-derivable)");
  assert.equal(rows(ctx, "SELECT 1 FROM doc_sections").length, 0, "no dangling section rows");
  assert.equal(Number(ctx.store.db.pragma("user_version", { simple: true })), 0, "stamp zeroed → next index() rebuilds");
  assert.equal(ctx.get("doc:written", { scope: "tenantA" }).text, "a written token note about quokkas");
  assert.equal(ctx.get("doc:written", { scope: "tenantB" }), null, "doc_scope fence survived the move");
  const hit = await ctx.recall("quokkas", { kind: "doc", scope: "tenantA" });
  assert.deepEqual(hit.map((h) => h.path), ["doc:written"]);
  assert.equal((await ctx.recall("quokkas", { kind: "doc", scope: "tenantB" })).length, 0);
  assert.ok((await ctx.recall("zebra", { kind: "doc", scope: "tenantA" })).length >= 1, "ingest segments recallable");
  // 3. the rebuild restores the md sections
  await ctx.index();
  assert.ok(rows(ctx, "SELECT 1 FROM doc_fts WHERE source='file'").length >= 2, "index() re-chunked md into doc_fts");
  assert.ok((await ctx.recall("token", { kind: "doc", scope: "tenantA" })).some((h) => h.path === "guide.md"));
  ctx.close();

  // 4. second open is a no-op: a sentinel stamp and the row set must be untouched
  const snap = (c) => JSON.stringify(rows(c, "SELECT rowid, path, source, body FROM doc_fts ORDER BY rowid"));
  const mid = new Database(dbPath);
  mid.pragma("user_version = 777");
  mid.close();
  const again = new LiteCtx({ root, dbPath });
  assert.equal(Number(again.store.db.pragma("user_version", { simple: true })), 777, "re-open did not re-run the migration");
  const s1 = snap(again);
  again.close();
  const third = new LiteCtx({ root, dbPath });
  assert.equal(snap(third), s1, "doc_fts unchanged across opens");
  third.close();
  rmSync(root, { recursive: true, force: true });
});
