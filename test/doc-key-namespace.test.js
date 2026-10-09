// Direct DOCS own a key namespace (`scope\x1Eid`, global `\x1Eid`), distinct from the fact/episode one
// (`owner\x1Fid`, global bare id). Before, a doc and a same-id fact of one tenant — or both in the global tier —
// shared mem_text/mem_meta/mem_embeddings/recall_log rows: a doc recall returned the fact's body and forgetting
// the fact deleted the doc, and migrating such a db threw `UNIQUE constraint failed` on every open.
//
// Test names carry the piece of the fix that guards them, so a mutation run reads off the failure list:
//   [KEY]  docKey vs memKey in the write path        [BODY] body-fill reads the PHYSICAL key
//   [DEL]  the doc-axis delete predicate             [MIG]  migrateDocKeyNamespace collision rules
//   [IDX]  migrateDocFts invalidates file_index      [SEP]  the `\x1E` forgery guard

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LiteCtx, GLOBAL } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "litectx-dkn-"));
const rows = (ctx, sql, ...a) => ctx.store.db.prepare(sql).all(...a);
const bodies = async (view, q, kind) => (await view.recall(q, { kind, n: 10, body: true })).map((h) => h.body);
const vec = (x) => Float32Array.from([x, 0, 0, 1]);
const RS = "\x1e";

// one scenario for BOTH tiers: `view` writes a doc and a fact under the same id
async function independence(view, ctx) {
  await view.remember("x", "zebra doc body", { kind: "doc", meta: { d: 1 } });
  await view.remember("x", "llama fact body", { kind: "fact", meta: { f: 1 } });
  assert.deepEqual(await bodies(view, "zebra", "doc"), ["zebra doc body"], "doc recall returns the DOC's body, not the fact's");
  assert.deepEqual(await bodies(view, "llama", "fact"), ["llama fact body"]);
  assert.equal((await view.recall("zebra", { kind: "doc" }))[0].path, "x", "public id out");
  assert.equal(rows(ctx, "SELECT path FROM mem_text").length, 2, "two physical sidecar rows, one public id");
  assert.equal(rows(ctx, "SELECT path FROM mem_meta").length, 2);
  // embeddings: two separate rows too (write both through the store with a vector)
  assert.equal(view.get("x").text, "llama fact body", "get(x) keeps its documented precedence (fact first)");
  assert.equal(view.recentMemory({ kind: "doc", body: true })[0].body, "zebra doc body");
  // forgetting the FACT leaves the doc whole (body, meta, sidecars)
  assert.equal(view.forget({ id: "x", kind: "fact" }), 1);
  assert.deepEqual(await bodies(view, "zebra", "doc"), ["zebra doc body"], "doc survives forgetting the same-id fact");
  assert.equal(rows(ctx, "SELECT path FROM mem_text").length, 1);
  assert.equal(rows(ctx, "SELECT path FROM mem_meta").length, 1);
  assert.equal(view.get("x").text, "zebra doc body");
  assert.deepEqual(view.get("x").meta, { d: 1 });
  // and the reverse: re-add the fact, forget the DOC, the fact survives
  await view.remember("x", "llama fact body", { kind: "fact" });
  assert.equal(view.forget({ id: "x", kind: "doc" }), 1);
  assert.deepEqual(await bodies(view, "llama", "fact"), ["llama fact body"], "fact survives forgetting the same-id doc");
  assert.equal(await (await view.recall("zebra", { kind: "doc" })).length, 0);
}

test("[KEY][BODY][DEL] a tenant doc and a tenant fact with the same id stay independent (recall body, get, forget)", async () => {
  const ctx = new LiteCtx({ root: tmp(), dbPath: ":memory:" });
  await independence(ctx.scoped("acme"), ctx);
  ctx.close();
});

test("[KEY][BODY][DEL] a GLOBAL doc and a GLOBAL fact with the same id stay independent (pre-existing collision since main)", async () => {
  const ctx = new LiteCtx({ root: tmp(), dbPath: ":memory:" });
  await independence(ctx.scoped(GLOBAL), ctx);
  ctx.close();
});

test("[KEY][DEL] vectors are per-axis: a same-id doc and fact keep separate mem_embeddings rows; forgetting one leaves the other's", () => {
  for (const [scope, owner] of [["acme", "acme"], [null, null]]) {
    const ctx = new LiteCtx({ root: tmp(), dbPath: ":memory:" });
    ctx.store.writeMemory({ id: "v", text: "doc side", kind: "doc", format: "md", provenance: "agent", occurredAt: null, scope, embedding: vec(1) });
    ctx.store.writeMemory({ id: "v", text: "fact side", kind: "fact", format: "text", provenance: "agent", occurredAt: null, owner, embedding: vec(2) });
    assert.equal(rows(ctx, "SELECT path FROM mem_embeddings").length, 2);
    const view = scope == null ? ctx.scoped(GLOBAL) : ctx.scoped(scope);
    assert.equal(view.forget({ id: "v", kind: "fact" }), 1);
    assert.deepEqual(rows(ctx, "SELECT path FROM mem_embeddings").map((r) => r.path), [(scope ?? "") + RS + "v"], "only the doc's vector remains");
    ctx.close();
  }
});

test("[DEL] owner-blind forget({ id, kind }) matches the public id on the doc axis too, and only that kind", async () => {
  const ctx = new LiteCtx({ root: tmp(), dbPath: ":memory:" });
  await ctx.scoped("acme").remember("x", "zebra doc body", { kind: "doc" });
  await ctx.scoped("acme").remember("x", "llama fact body", { kind: "fact" });
  assert.equal(ctx.forget({ id: "x", kind: "doc" }), 1, "reaches the tenant's doc by its public id");
  assert.deepEqual(await bodies(ctx.scoped("acme"), "llama", "fact"), ["llama fact body"], "the fact is untouched");
  ctx.close();
});

// --- migration -------------------------------------------------------------------------------------------------

// rewrite a db built by the CURRENT code into main's legacy shape: every direct doc key loses its `scope\x1E`
// prefix (bare id; scope lives on only in doc_scope). Where a doc and a fact then share the bare key (the global
// tier on main) ONE shared mem_* row survives — the fact's, as on main (last writer wins).
function toMainShape(dbPath) {
  const raw = new Database(dbPath);
  const strip = "substr(path, instr(path, char(30)) + 1)";
  raw.exec(`UPDATE doc_fts SET path = ${strip} WHERE source='direct' AND instr(path, char(30)) > 0`);
  for (const t of ["doc_scope", "blobs"]) raw.exec(`UPDATE ${t} SET path = ${strip} WHERE instr(path, char(30)) > 0`);
  for (const t of ["mem_text", "mem_meta", "mem_embeddings"]) {
    raw.exec(`UPDATE OR IGNORE ${t} SET path = ${strip} WHERE instr(path, char(30)) > 0`);
    raw.exec(`DELETE FROM ${t} WHERE instr(path, char(30)) > 0`); // lost the collision: the fact's row stays
  }
  raw.exec(`UPDATE recall_log SET path = ${strip} WHERE instr(path, char(30)) > 0`);
  assert.equal(raw.prepare("SELECT count(*) n FROM doc_fts WHERE source='direct' AND instr(path, char(30)) > 0").get().n, 0, "precondition: main shape has no doc separator");
  raw.close();
}

test("[MIG] a main-shaped db with a doc+fact of the same id (tenant and global) opens twice without throwing and loses nothing", async () => {
  const root = tmp();
  const dbPath = join(root, "legacy.db");
  const seed = new LiteCtx({ root, dbPath });
  const A = seed.scoped("acme");
  await A.remember("td", "zebra tenant doc", { kind: "doc", meta: { d: 1 } });
  await A.remember("td", "llama tenant fact", { kind: "fact" });
  await seed.remember("gd", "okapi global doc", { kind: "doc", scope: GLOBAL });
  await seed.remember("gd", "quokka global fact", { kind: "fact", scope: GLOBAL });
  for (const [id, kind, scope, owner, x] of [["td", "doc", "acme", undefined, 1], ["gd", "doc", null, undefined, 3]]) {
    seed.store.writeMemory({ id, text: id === "td" ? "zebra tenant doc" : "okapi global doc", kind, format: "md", provenance: "agent", occurredAt: null, scope, owner, embedding: vec(x), meta: JSON.stringify({ d: 1 }) });
  }
  seed.store.writeMemory({ id: "gd", text: "quokka global fact", kind: "fact", format: "text", provenance: "agent", occurredAt: null, owner: null, embedding: vec(9) });
  seed.close();
  toMainShape(dbPath);

  let ctx;
  assert.doesNotThrow(() => (ctx = new LiteCtx({ root, dbPath })), "first open (migrates)");
  const snap = (c) => JSON.stringify([rows(c, "SELECT path FROM doc_fts WHERE source='direct' ORDER BY path"), rows(c, "SELECT path FROM mem_text ORDER BY path"), rows(c, "SELECT path FROM mem_embeddings ORDER BY path")]);
  const s1 = snap(ctx);
  const A2 = ctx.scoped("acme");
  assert.equal(A2.get("td").text, "llama tenant fact", "tenant fact keeps its body");
  assert.deepEqual(await bodies(A2, "zebra", "doc"), ["zebra tenant doc"], "tenant doc keeps its own body (copied, not stolen)");
  assert.deepEqual(await bodies(A2, "llama", "fact"), ["llama tenant fact"]);
  // global tier: main shared ONE mem_text row (the fact's, last writer) — both keys carry that body now, no throw, no lost row
  assert.deepEqual(await bodies(ctx.scoped(GLOBAL), "quokka", "fact"), ["quokka global fact"]);
  assert.equal((await bodies(ctx.scoped(GLOBAL), "okapi", "doc")).length, 1, "global doc row survives");
  assert.ok((await bodies(ctx.scoped(GLOBAL), "okapi", "doc"))[0] != null, "and its body is served");
  assert.deepEqual(rows(ctx, "SELECT path FROM doc_fts WHERE source='direct' ORDER BY path").map((r) => r.path), [`${RS}gd`, `acme${RS}td`]);
  assert.ok(rows(ctx, "SELECT 1 FROM mem WHERE path = 'gd'").length === 1 && rows(ctx, "SELECT 1 FROM mem WHERE path = 'acme\x1ftd'").length === 1, "facts keep their keys");
  ctx.close();
  assert.doesNotThrow(() => (ctx = new LiteCtx({ root, dbPath })), "second open");
  assert.equal(snap(ctx), s1, "second open is a no-op");
  ctx.close();
  assert.doesNotThrow(() => (ctx = new LiteCtx({ root, dbPath })), "third open");
  assert.equal(snap(ctx), s1);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("[MIG] mixed versions: a main-version writer re-writes a doc after a migration — the old-shape row is the NEWER write and replaces the target", async () => {
  const root = tmp();
  const dbPath = join(root, "mixed.db");
  const seed = new LiteCtx({ root, dbPath });
  await seed.scoped("acme").remember("x", "first version zebra", { kind: "doc", meta: { v: 1 } });
  seed.close();
  // the 0.34.0 pre-release shape for the existing row: `acme\x1Fx`
  const raw = new Database(dbPath);
  raw.exec("UPDATE doc_fts SET path = 'acme' || char(31) || 'x' WHERE source='direct'");
  for (const t of ["doc_scope", "mem_text", "mem_meta"]) raw.exec(`UPDATE ${t} SET path = 'acme' || char(31) || 'x'`);
  // …then a main-version writer upserts the same doc under the BARE key (what main's writeMemory does)
  raw.prepare("INSERT INTO doc_fts(path, kind, format, source, provenance, occurred_at, body) VALUES ('x','doc','md','direct','agent',NULL,'second version zebra')").run();
  raw.prepare("INSERT INTO doc_scope(path, scope, expires_at, created_at) VALUES ('x','acme',NULL,?)").run(Date.now());
  raw.prepare("INSERT INTO mem_text(path, text) VALUES ('x','second version zebra')").run();
  raw.close();

  let ctx;
  assert.doesNotThrow(() => (ctx = new LiteCtx({ root, dbPath })), "no UNIQUE failure on doc_scope.path / mem_text.path");
  assert.deepEqual(rows(ctx, "SELECT path FROM doc_fts WHERE source='direct'").map((r) => r.path), [`acme${RS}x`], "one row, the doc key");
  assert.equal(ctx.scoped("acme").get("x").text, "second version zebra", "the bare (newer) write won");
  assert.equal(ctx.scoped("acme").get("x").meta, null, "its (absent) meta replaced the older one");
  assert.deepEqual(await bodies(ctx.scoped("acme"), "zebra", "doc"), ["second version zebra"]);
  assert.equal(rows(ctx, "SELECT path FROM doc_scope").length, 1);
  ctx.close();
  assert.doesNotThrow(() => (ctx = new LiteCtx({ root, dbPath })), "idempotent");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("[IDX] after the old-layout migration a PARTIAL index({ paths }) brings the dropped md sections back (a full pass re-chunks them too)", async () => {
  for (const full of [false, true]) {
    const root = tmp();
    writeFileSync(join(root, "a.md"), "# One\nwombat alpha\n\n## Two\nwombat beta\n");
    writeFileSync(join(root, "c.js"), "export function wombat() { return 1 }\n");
    // a committed git repo: `paths` scoping is a git-pathspec feature (a non-repo walk would index everything)
    execSync("git init -q && git add a.md c.js && git -c user.email=a@b -c user.name=a commit -qm i", { cwd: root });
    const dbPath = join(root, "old.db");
    const seed = new LiteCtx({ root, dbPath });
    await seed.index();
    assert.ok((await seed.recall("wombat", { kind: "doc" })).length >= 2, "precondition: md sections indexed");
    seed.close();
    // old layout: indexed md rows inside `docs`, no doc_sections
    const raw = new Database(dbPath);
    raw.exec("INSERT INTO docs(path, kind, format, source, provenance, occurred_at, body) SELECT path, kind, format, source, provenance, occurred_at, body FROM doc_fts WHERE source='file'");
    raw.exec("DELETE FROM doc_fts WHERE source='file'");
    raw.exec("DELETE FROM doc_sections");
    raw.close();

    const ctx = new LiteCtx({ root, dbPath });
    assert.equal((await ctx.recall("wombat", { kind: "doc" })).length, 0, "md rows were dropped by the migration");
    assert.deepEqual(rows(ctx, "SELECT content_hash h, mtime m, size s FROM file_index WHERE path='a.md'"), [{ h: "", m: -1, s: -1 }], "entry INVALIDATED, not deleted");
    const r = await ctx.index(full ? {} : { paths: ["a.md"] });
    // partial: the invalidated entry makes the scoped pass re-chunk it (reported `updated`). Full: the zeroed stamp
    // already forces a whole-index rebuild, which reports every file `added` (existing behaviour, not asserted here).
    assert.ok(full ? r.added + r.updated >= 1 : r.updated === 1, `a.md re-chunked (full=${full} ${JSON.stringify(r)})`);
    const hits = await ctx.recall("wombat", { kind: "doc" });
    assert.ok(hits.length >= 2 && hits.every((h) => h.path === "a.md" && h.chunk), "sections are back");
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("[SEP] \\x1E (the doc separator) is rejected in an id or scope on write, like \\x1F — for docs, blobs, ingest and facts", async () => {
  const ctx = new LiteCtx({ root: tmp(), dbPath: ":memory:" });
  const bad = `a${RS}b`;
  await assert.rejects(() => ctx.remember(bad, "t", { kind: "doc" }), /\\x1E/);
  await assert.rejects(() => ctx.remember("ok", "t", { kind: "doc", scope: bad }), /\\x1E/);
  await assert.rejects(() => ctx.remember(bad, "t", { kind: "fact" }), /\\x1E/);
  await assert.rejects(() => ctx.remember("ok", "t", { kind: "fact", scope: bad }), /\\x1E/);
  await assert.rejects(() => ctx.ingest(Uint8Array.from([1]), { filename: "a.xlsx", scope: bad }), /\\x1E/);
  await assert.rejects(() => ctx.ingest(Uint8Array.from([1]), { filename: "a.xlsx", id: bad }), /\\x1E/);
  await assert.rejects(() => ctx.ingest(new TextEncoder().encode("hello world"), { filename: "a.txt", scope: bad }), /\\x1E/);
  assert.equal(rows(ctx, "SELECT 1 FROM doc_fts").length + rows(ctx, "SELECT 1 FROM mem").length, 0, "nothing written");
  ctx.close();
});

test("[MULTIS] a customer uploading a file with the same name as a KB file or another tenant's file does not delete it", async () => {
  const ctx = new LiteCtx({ root: tmp(), dbPath: ":memory:" });
  const enc = (t) => new TextEncoder().encode(t);
  await ctx.scoped(GLOBAL).ingest(enc("official price list gold plan 99"), { filename: "pricing.txt" });
  await ctx.scoped("admin").ingest(enc("internal margin notes secret"), { filename: "notes.txt" });
  const u42 = ctx.scoped("user:42");
  await u42.ingest(enc("my own pricing sheet bronze tier"), { filename: "pricing.txt" });
  await u42.ingest(enc("my own notes about lunch"), { filename: "notes.txt" });
  const texts = async (view, q) => (await view.recall(q, { kind: "doc", body: true })).map((h) => h.body);
  assert.deepEqual(await texts(ctx.scoped("user:7"), "price"), ["official price list gold plan 99"], "the KB pricing file survives user:42's same-named upload");
  assert.deepEqual(await texts(ctx.scoped("admin"), "margin"), ["internal margin notes secret"], "admin's notes survive user:42's same-named upload");
  assert.deepEqual(await texts(u42, "margin"), [], "user:42 cannot recall admin's notes");
  assert.deepEqual(await texts(u42, "bronze"), ["my own pricing sheet bronze tier"]);
  assert.deepEqual(await texts(u42, "lunch"), ["my own notes about lunch"]);
  ctx.close();
});
