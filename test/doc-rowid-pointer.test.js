// Direct docs/blobs and indexed md rows are reached through their `doc_fts` ROWID, never by a scan of `doc_fts`
// (`path` is an UNINDEXED fts5 column, so a by-path lookup/delete reads every body — ~100ms at 100k rows). The
// pointer is `doc_scope.rid` (the sidecar every direct doc already has) and, for an indexed md file,
// `doc_sections.doc_rowid`. The search fence joins the sidecar by that same rowid.
//
// The pointer must survive an OLDER writer that knows nothing of `rid` (replace = delete+insert doc_fts, then
// delete+insert doc_scope with rid NULL; rowids get reused). The hazard is a NULL rid reading as "global" — a
// cross-tenant read — so those cases are driven by raw SQL exactly as the older code ran it.
//
// Test names carry the guard they pin, so a mutation run reads off the failure list:
//   [ROUTE] lookups/writes resolve by shelf number, results unchanged   [OLD] an older writer's rewrite stays fenced
//   [HEAL]  NULL-rid probe / heal-on-miss                                [MIG] open-time backfill + migrateDocFts nulling
//   [FENCE] the rowid-keyed search fence                                 [CASE] forget idPrefix stays ASCII-case-insensitive

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LiteCtx, GLOBAL } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "litectx-rid-"));
const enc = (s) => new TextEncoder().encode(s);
const rows = (ctx, sql, ...a) => ctx.store.db.prepare(sql).all(...a);
const RS = "\x1e";
const mem = () => new LiteCtx({ root: tmp(), dbPath: ":memory:" });
const ids = async (view, q) => (await view.recall(q, { kind: "doc", n: 20 })).map((h) => h.path).sort();

// every direct doc's sidecar must name exactly the doc_fts row that carries its key (-1 = orphan marker)
const pointersHold = (ctx) =>
  rows(ctx, "SELECT d.path AS path, d.rid AS rid, f.path AS fpath FROM doc_scope d LEFT JOIN doc_fts f ON f.rowid = d.rid")
    .filter((r) => r.rid !== -1)
    .every((r) => r.rid != null && r.fpath === r.path);

// An OLDER writer's remember(kind:'doc'): exactly the SQL the pre-pointer code ran (no rid anywhere).
function oldRemember(ctx, scope, id, text, { expiresAt = null } = {}) {
  const db = ctx.store.db;
  const key = (scope ?? "") + RS + id;
  db.prepare("DELETE FROM doc_fts WHERE path = ? AND source = 'direct'").run(key);
  db.prepare("INSERT INTO doc_fts(path, kind, format, source, provenance, occurred_at, body) VALUES (?, 'doc', 'md', 'direct', 'agent', NULL, ?)").run(key, text);
  db.prepare("DELETE FROM doc_scope WHERE path = ?").run(key);
  db.prepare("INSERT INTO doc_scope(path, scope, expires_at, created_at) VALUES (?, ?, ?, ?)").run(key, scope, expiresAt, Date.now());
  db.prepare("INSERT INTO mem_text(path, text) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET text = excluded.text").run(key, text);
}
function oldForget(ctx, scope, id) {
  const db = ctx.store.db;
  const key = (scope ?? "") + RS + id;
  db.prepare("DELETE FROM doc_fts WHERE path = ? AND source = 'direct'").run(key);
  for (const t of ["doc_scope", "mem_text", "blobs"]) db.prepare(`DELETE FROM ${t} WHERE path = ?`).run(key);
}

// === [ROUTE] =====================================================================================

test("[ROUTE] a direct doc's sidecar carries its doc_fts rowid after every write path (remember, ingest, blob, supersede)", async () => {
  const ctx = mem();
  await ctx.scoped("acme").remember("a", "alpha one", { kind: "doc" });
  await ctx.scoped(GLOBAL).remember("g", "gamma one", { kind: "doc" });
  await ctx.scoped("acme").ingest(enc("# T\n\nfirst para\n\nsecond para"), { filename: "n.txt" });
  await ctx.scoped("acme").ingest(enc("PK\x03\x04bin"), { filename: "s.xlsx" });
  assert.ok(pointersHold(ctx));
  assert.equal(rows(ctx, "SELECT 1 FROM doc_scope WHERE rid IS NULL").length, 0);
  await ctx.scoped("acme").remember("a", "alpha two", { kind: "doc" }); // supersede: new row, new rowid
  await ctx.scoped("acme").ingest(enc("PK\x03\x04bin2"), { filename: "s.xlsx" }); // blob re-ingest
  assert.ok(pointersHold(ctx));
  assert.equal(rows(ctx, "SELECT path FROM doc_fts WHERE path = ?", "acme" + RS + "a").length, 1, "supersede leaves exactly one row");
  ctx.close();
});

test("[ROUTE] get: direct doc scoped and bare, missing, cross-tenant, shared fallback", async () => {
  const ctx = mem();
  await ctx.scoped("acme").remember("note", "acme text", { kind: "doc" });
  await ctx.scoped(GLOBAL).remember("shared", "shared text", { kind: "doc" });
  await ctx.scoped("other").remember("theirs", "other text", { kind: "doc" });
  const A = ctx.scoped("acme");
  assert.equal(A.get("note", { log: false }).text, "acme text", "scoped");
  assert.equal(ctx.get("note", { log: false }).text, "acme text", "bare get resolves a tenant row by its public id");
  assert.equal(A.get("shared", { log: false }).text, "shared text", "tenant falls back to the shared tier");
  assert.equal(A.get("theirs", { log: false }), null, "another tenant's row is fenced");
  assert.equal(ctx.scoped(GLOBAL).get("note", { log: false }), null, "GLOBAL never reads a tenant row");
  assert.equal(A.get("nothing-here", { log: false }), null, "missing");
  assert.equal(ctx.get("nothing-here", { log: false }), null);
  ctx.close();
});

test("[ROUTE] get: an indexed md file and a section range; getItemByKey on an md key", async () => {
  const root = tmp();
  writeFileSync(join(root, "guide.md"), "# Setup\n\ninstall zebra widget\n\n## Quokka\n\nthe quokka cache widget\n");
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const whole = ctx.get("guide.md", { log: false });
  assert.ok(whole && whole.text.includes("zebra") && whole.text.includes("quokka"), "md file resolves through its section rows");
  const hit = (await ctx.recall("quokka", { kind: "doc", n: 3 })).find((h) => h.chunk);
  assert.ok(hit?.chunk, "a section hit names its chunk");
  const sec = ctx.get(hit.path, { startLine: hit.chunk.startLine, endLine: hit.chunk.endLine, log: false });
  assert.ok(sec.text.includes("quokka cache") && !sec.text.includes("zebra"), "the range returns that section only");
  assert.equal(ctx.get("guide.md", { startLine: 900, endLine: 901, log: false }), null, "a range matching no chunk is null");
  assert.equal(ctx.store.getItemByKey("guide.md").path, "guide.md");
  assert.equal(ctx.store.getItemByKey(RS + "nope"), null);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("[ROUTE] re-ingest replaces (shorter leaves no orphan); forget id / idPrefix / kind:doc / purge delete by shelf number", async () => {
  const ctx = mem();
  const A = ctx.scoped("acme");
  const r = await A.ingest(enc("p1 aardvark\n\np2 aardvark\n\np3 aardvark"), { filename: "n.txt" });
  await A.ingest(enc("armadillo only"), { filename: "n.txt" });
  assert.equal((await A.recall("aardvark", { kind: "doc" })).length, 0);
  assert.equal(rows(ctx, "SELECT 1 FROM doc_fts WHERE source = 'direct'").length, 1);
  assert.equal(A.forget({ idPrefix: r.id }), 1, "idPrefix forget");
  assert.equal(rows(ctx, "SELECT 1 FROM doc_fts WHERE source = 'direct'").length + rows(ctx, "SELECT 1 FROM doc_scope").length, 0);

  await A.remember("x", "zeta text", { kind: "doc" });
  await ctx.scoped("other").remember("x", "eta text", { kind: "doc" });
  assert.equal(A.forget({ id: "x" }), 1, "scoped id forget takes only the tenant's copy");
  assert.equal(ctx.scoped("other").get("x", { log: false }).text, "eta text");
  assert.equal(ctx.forget({ id: "x" }), 1, "owner-blind id forget reaches every tenant's copy");
  assert.equal(ctx.get("x", { log: false }), null);

  await A.remember("d1", "theta", { kind: "doc" });
  await A.remember("d2", "iota", { kind: "doc" });
  await ctx.scoped("other").remember("d3", "kappa", { kind: "doc" });
  assert.equal(A.forget({ kind: "doc" }), 2, "kind:doc is the tenant's docs only");
  assert.equal(ctx.scoped("other").get("d3", { log: false }).text, "kappa");
  assert.equal(ctx.forget({ kind: "doc" }), 1, "owner-blind kind:doc sweeps the rest");
  assert.equal(rows(ctx, "SELECT 1 FROM doc_fts").length + rows(ctx, "SELECT 1 FROM doc_scope").length, 0);

  await A.remember("old", "lambda", { kind: "doc", expiresAt: Date.now() - 1000 });
  await A.remember("live", "mu", { kind: "doc", expiresAt: Date.now() + 60000 });
  assert.equal(ctx.purge(), 1);
  assert.deepEqual(rows(ctx, "SELECT path FROM doc_fts").map((x) => x.path), ["acme" + RS + "live"]);
  ctx.close();
});

test("[ROUTE] blob re-ingest replaces the bytes in place: one row, bytes round-trip", async () => {
  const ctx = mem();
  const A = ctx.scoped("acme");
  const a = await A.ingest(enc("PK\x03\x04one"), { filename: "s.xlsx" });
  await A.ingest(enc("PK\x03\x04two-two"), { filename: "s.xlsx" });
  assert.equal(rows(ctx, "SELECT 1 FROM doc_fts WHERE source = 'direct'").length, 1);
  assert.equal(rows(ctx, "SELECT 1 FROM blobs").length, 1);
  assert.equal(Buffer.from(A.get(a.id, { log: false }).bytes).toString("latin1"), "PK\x03\x04two-two");
  assert.ok(pointersHold(ctx));
  ctx.close();
});

// === [CASE] — forget idPrefix keeps today's `LIKE … ESCAPE` (ASCII case-insensitive) semantics ===

test("[CASE] forget({idPrefix}) is ASCII-case-insensitive on the `<base>#…` rows and case-exact on the base id", async () => {
  for (const owner of ["acme", GLOBAL]) {
    const ctx = mem();
    const view = ctx.scoped(owner);
    for (const id of ["report", "Report", "report#0", "Report#1", "REPORT#2", "reporter", "report#"]) await view.remember(id, "zz " + id, { kind: "doc" });
    // the exact base id (`=`) is case-SENSITIVE; the `#…` segment rows (LIKE) are case-INSENSITIVE; `reporter` is no segment
    assert.equal(view.forget({ idPrefix: "report" }), 5);
    const left = rows(ctx, "SELECT path FROM doc_fts ORDER BY path").map((r) => r.path.slice(r.path.indexOf(RS) + 1));
    assert.deepEqual(left, ["Report", "reporter"]);
    ctx.close();
  }
});

// === [OLD] an older writer is safe (port of the perf3 version-skew probe) ===================================

test("[OLD][HEAL] an older writer's remember/replace/delete leaves NULL rids: fence, get, supersede and forget still hold", async () => {
  const ctx = mem();
  const A = ctx.scoped("acme");
  await A.remember("d5", "original d5 text", { kind: "doc" });
  oldRemember(ctx, "other", "secret1", "zzforeignsecret alpha");
  oldRemember(ctx, "acme", "mine1", "zzforeignmine alpha");
  oldRemember(ctx, "acme", "d5", "zzreplacedbyold alpha"); // REPLACE an existing acme doc
  assert.ok(rows(ctx, "SELECT 1 FROM doc_scope WHERE rid IS NULL").length >= 3, "precondition: the older writer left NULL rids");

  assert.ok((await A.recall("zzforeignmine", { kind: "doc" })).some((h) => h.path === "mine1"), "acme sees its foreign-written doc");
  assert.equal((await A.recall("zzforeignsecret", { kind: "doc" })).length, 0, "acme does NOT see other's foreign-written doc (a NULL rid must not read as global)");
  assert.equal(A.get("secret1", { log: false }), null, "get fence on a foreign-written row");
  assert.ok(A.get("mine1", { log: false })?.text.includes("zzforeignmine"));
  assert.ok(A.get("d5", { log: false })?.text.includes("zzreplacedbyold"), "a replaced doc returns the NEW text");
  assert.equal((await A.recall("zzreplacedbyold", { kind: "doc" })).length, 1);
  assert.equal((await A.recall("original", { kind: "doc" })).length, 0, "the old text is gone");
  assert.ok(pointersHold(ctx), "heal refilled every pointer");

  oldRemember(ctx, "acme", "mine1", "zzforeignmine alpha"); // again, so supersede runs over a NULL-rid row
  await A.remember("mine1", "zznewmine beta", { kind: "doc" });
  assert.equal((await A.recall("zzforeignmine", { kind: "doc" })).length, 0);
  assert.equal((await A.recall("zznewmine", { kind: "doc" })).length, 1, "supersede over a foreign row leaves exactly one");
  assert.equal(rows(ctx, "SELECT 1 FROM doc_fts WHERE path = ?", "acme" + RS + "mine1").length, 1);

  oldRemember(ctx, "acme", "d5", "zzreplacedbyold alpha");
  assert.equal(A.forget({ id: "d5" }), 1, "forget over a foreign row");
  assert.equal(A.get("d5", { log: false }), null);
  assert.equal((await A.recall("zzreplacedbyold", { kind: "doc" })).length, 0);
  ctx.close();
});

test("[OLD][HEAL] heal-on-miss: the FIRST get / getItemByKey / owner-blind forget after an older writer's write already finds the row", async () => {
  const fresh = () => {
    const ctx = mem();
    oldRemember(ctx, "acme", "m", "zzfirst touch", {});
    assert.equal(rows(ctx, "SELECT 1 FROM doc_scope WHERE rid IS NULL").length, 1, "precondition: NULL rid, nothing healed yet");
    return ctx;
  };
  let ctx = fresh();
  assert.equal(ctx.scoped("acme").get("m", { log: false })?.text, "zzfirst touch", "get");
  ctx.close();
  ctx = fresh();
  assert.equal(ctx.get("m", { log: false })?.text, "zzfirst touch", "bare get");
  ctx.close();
  ctx = fresh();
  assert.equal(ctx.store.getItemByKey("acme" + RS + "m")?.text, "zzfirst touch", "getItemByKey");
  ctx.close();
  ctx = fresh();
  assert.equal(ctx.forget({ id: "m" }), 1, "owner-blind forget({id})");
  assert.equal(rows(ctx, "SELECT 1 FROM doc_fts").length, 0);
  ctx.close();
  ctx = fresh();
  assert.equal(ctx.forget({ kind: "doc" }), 1, "owner-blind forget({kind:'doc'})");
  ctx.close();
});

test("[OLD][HEAL] older writer deletes a doc the new code created, then another tenant takes the freed rowid", async () => {
  const ctx = mem();
  const A = ctx.scoped("acme");
  await A.remember("nw1", "zznewwritten gamma", { kind: "doc" });
  const rid = rows(ctx, "SELECT rid FROM doc_scope WHERE path = ?", "acme" + RS + "nw1")[0].rid;
  // older writer: delete the doc_fts row (the sidecar keeps naming it), then another tenant's insert reuses the rowid
  ctx.store.db.prepare("DELETE FROM doc_fts WHERE rowid = ?").run(rid);
  assert.equal(A.get("nw1", { log: false }), null, "orphaned pointer: get is null after a foreign delete");
  oldForget(ctx, "acme", "nw1");
  oldRemember(ctx, "other", "nw1", "zzothertenant delta");
  assert.equal(rows(ctx, "SELECT rowid FROM doc_fts WHERE path = ?", "other" + RS + "nw1")[0].rowid, rid, "precondition: the rowid was reused");
  assert.equal(A.get("nw1", { log: false }), null, "rowid reuse by another tenant: acme still cannot read it");
  assert.equal((await A.recall("zzothertenant", { kind: "doc" })).length, 0, "…nor recall it");
  await A.remember("nw1", "zzacmeagain eps", { kind: "doc" });
  assert.ok(A.get("nw1", { log: false })?.text.includes("zzacmeagain"));
  assert.ok(ctx.scoped("other").get("nw1", { log: false })?.text.includes("zzothertenant"), "acme's re-remember is independent of other's");
  assert.ok(pointersHold(ctx));
  ctx.close();
});

test("[OLD][HEAL] a stale non-NULL pointer (its rowid now holds another key) never serves the wrong row", async () => {
  const ctx = mem();
  await ctx.scoped("acme").remember("a", "zzacme text", { kind: "doc" });
  await ctx.scoped("other").remember("b", "zzother text", { kind: "doc" });
  const ridB = rows(ctx, "SELECT rid FROM doc_scope WHERE path = ?", "other" + RS + "b")[0].rid;
  ctx.store.db.prepare("UPDATE doc_scope SET rid = ? WHERE path = ?").run(ridB, "acme" + RS + "a"); // acme's pointer now names other's row
  assert.equal(ctx.scoped("acme").get("a", { log: false }), null, "get checks the row's own key, so a wrong pointer finds nothing");
  assert.equal(ctx.scoped("acme").get("b", { log: false }), null);
  ctx.close();
});

test("[OLD][HEAL] an older writer's doc with no pointer is never read as global by the search fence", async () => {
  const ctx = mem();
  await ctx.scoped("acme").remember("seed", "nothing special", { kind: "doc" });
  oldRemember(ctx, "other", "p", "zzprivate beta");
  oldRemember(ctx, null, "s", "zzshared beta");
  assert.equal((await ctx.scoped("acme").recall("zzprivate", { kind: "doc" })).length, 0, "the probe heals BEFORE the fence runs");
  assert.deepEqual(await ids(ctx.scoped("acme"), "zzshared"), ["s"]);
  assert.deepEqual(await ids(ctx.scoped(GLOBAL), "zzprivate"), []);
  ctx.close();
});

// === [FENCE] ====================================================================================

test("[FENCE] search fence by row number: tenant isolation under a crowded pool, expiry, GLOBAL sees only shared", async () => {
  const ctx = mem();
  const A = ctx.scoped("acme");
  const O = ctx.scoped("other");
  for (let i = 0; i < 40; i++) await O.remember(`o${i}`, `widget widget widget other number ${i}`, { kind: "doc" }); // outrank acme's on BM25
  await A.remember("a1", "widget acme single", { kind: "doc" });
  await A.remember("aexp", "widget acme expired", { kind: "doc", expiresAt: Date.now() - 1000 });
  await ctx.scoped(GLOBAL).remember("g1", "widget shared one", { kind: "doc" });
  assert.deepEqual(await ids(A, "widget"), ["a1", "g1"], "acme: own + shared, not other's 40, not its expired");
  assert.deepEqual(await ids(ctx.scoped(GLOBAL), "widget"), ["g1"], "GLOBAL: shared only (expired and tenant rows hidden)");
  assert.equal((await O.recall("widget", { kind: "doc", n: 100 })).length, 41, "other: own 40 + shared");
  assert.equal((await ctx.recall("widget", { kind: "doc", scope: "acme", n: 100 })).length, 2);
  ctx.close();
});

test("[FENCE] the fence joins by rowid: a row no sidecar names reads as global", async () => {
  const ctx = mem();
  await ctx.scoped("other").remember("p", "zzmarker private", { kind: "doc" });
  assert.equal((await ctx.scoped("acme").recall("zzmarker", { kind: "doc" })).length, 0, "fenced via its own rowid");
  // detach the pointer (points elsewhere, as a stale non-NULL rid would): the join key is the rowid, so nothing fences the row
  ctx.store.db.prepare("UPDATE doc_scope SET rid = rid + 1000 WHERE path = ?").run("other" + RS + "p");
  assert.equal((await ctx.scoped("acme").recall("zzmarker", { kind: "doc" })).length, 1, "proof the fence key IS the rowid");
  ctx.close();
});

// === [MIG] ======================================================================================

test("[MIG] a branch-layout db (doc_scope without `rid`, a legacy direct doc with no sidecar) backfills on open; a second open is a no-op", async () => {
  const root = tmp();
  const dbPath = join(root, "branch.db");
  const seed = new LiteCtx({ root, dbPath });
  await seed.scoped("acme").remember("a", "zzalpha acme", { kind: "doc", expiresAt: Date.now() + 60000 });
  await seed.scoped("other").remember("b", "zzbeta other", { kind: "doc" });
  await seed.scoped(GLOBAL).remember("g", "zzgamma shared", { kind: "doc" });
  await seed.scoped("acme").ingest(enc("PK\x03\x04bin"), { filename: "s.xlsx" });
  seed.close();
  const raw = new Database(dbPath);
  raw.exec("DROP INDEX doc_scope_pub; DROP INDEX doc_scope_rid; DROP INDEX doc_scope_norid; ALTER TABLE doc_scope DROP COLUMN rid");
  raw.prepare("DELETE FROM doc_scope WHERE path = ?").run(RS + "g"); // a legacy direct doc written before the sidecar existed
  assert.ok(!raw.pragma("table_info(doc_scope)").some((c) => c.name === "rid"), "precondition: branch layout");
  raw.close();

  const ctx = new LiteCtx({ root, dbPath });
  assert.ok(rows(ctx, "PRAGMA table_info(doc_scope)").some((c) => c.name === "rid"));
  assert.ok(pointersHold(ctx));
  assert.equal(rows(ctx, "SELECT 1 FROM doc_scope").length, rows(ctx, "SELECT 1 FROM doc_fts WHERE source = 'direct'").length, "every direct doc has a sidecar again");
  const g = rows(ctx, "SELECT scope, expires_at, created_at FROM doc_scope WHERE path = ?", RS + "g")[0];
  assert.deepEqual(g, { scope: null, expires_at: null, created_at: null }, "created sidecar = global / forever / undated, identical to absent");
  assert.equal(ctx.scoped("acme").get("a", { log: false }).text, "zzalpha acme");
  assert.equal(ctx.scoped("acme").get("b", { log: false }), null);
  assert.equal(ctx.scoped("acme").get("g", { log: false }).text, "zzgamma shared");
  assert.deepEqual(await ids(ctx.scoped("acme"), "zzbeta"), []);
  assert.deepEqual(await ids(ctx.scoped("other"), "zzbeta"), ["b"]);
  const snap = (c) => JSON.stringify([rows(c, "SELECT * FROM doc_scope ORDER BY path"), rows(c, "SELECT rowid, path FROM doc_fts ORDER BY rowid")]);
  const s1 = snap(ctx);
  ctx.close();
  const again = new LiteCtx({ root, dbPath });
  assert.equal(snap(again), s1, "second open changes nothing");
  assert.equal(again.store.healDocScopeRid(), false, "nothing left to heal");
  again.close();
  rmSync(root, { recursive: true, force: true });
});

test("[MIG] an old-layout db (direct docs inside `docs`): migrateDocFts nulls every stale rid and the heal at open refills them", async () => {
  const root = tmp();
  writeFileSync(join(root, "guide.md"), "# One\n\nzebra token\n\n## Two\n\nquokka token\n");
  const dbPath = join(root, "old.db");
  const seed = new LiteCtx({ root, dbPath });
  await seed.index(); // file md rows first: the direct rows' doc_fts rowids sit past them…
  await seed.scoped("acme").remember("w1", "zzwritten acme", { kind: "doc" });
  await seed.scoped("other").remember("w2", "zzwritten other", { kind: "doc" });
  await seed.scoped("acme").ingest(enc("PK\x03\x04bin"), { filename: "s.xlsx" });
  seed.close();
  const raw = new Database(dbPath);
  raw.exec("INSERT INTO docs(path, kind, format, source, provenance, occurred_at, body) SELECT path, kind, format, source, provenance, occurred_at, body FROM doc_fts");
  raw.exec("DROP TABLE doc_fts"); // …and are NOT the rowids they get when moved into a fresh doc_fts (file rows are dropped)
  raw.close();

  const ctx = new LiteCtx({ root, dbPath });
  assert.equal(rows(ctx, "SELECT 1 FROM doc_scope WHERE rid IS NULL").length, 0, "healed");
  assert.ok(pointersHold(ctx), "pointers name the NEW rowids (a stale rid from the old table would not)");
  assert.equal(ctx.scoped("acme").get("w1", { log: false }).text, "zzwritten acme");
  assert.equal(ctx.scoped("acme").get("w2", { log: false }), null);
  assert.deepEqual(await ids(ctx.scoped("acme"), "zzwritten"), ["w1"]);
  assert.deepEqual(await ids(ctx.scoped("other"), "zzwritten"), ["w2"]);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
