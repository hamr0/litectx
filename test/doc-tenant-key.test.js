// Scope-qualified PHYSICAL key on the doc axis (the doc counterpart of the memory axis' W4 `memKey`). Before this, a written/
// uploaded doc was stored under its BARE id, so tenant B ingesting `contract.txt` (or remember(id,{kind:'doc'}))
// deleted tenant A's row of the same id — cross-tenant data loss (no leak). Now a tenant doc lives at
// `scope\x1Eid` (GLOBAL/unscoped = `\x1Eid`; a doc key space distinct from the fact `owner\x1Fid` one), and every delete/upsert/get resolves on that key.
//
// Test names carry the lock that guards them, so a mutation run can be read off the failure list:
//   [K]  guarded by the KEY only (a fence cannot stop a same-id clobber)
//   [F]  guarded by the doc_scope FENCE only (a key cannot fence a MATCH)
//   [KF] guarded by BOTH (by-id read isolation, no-leak, forgery guard: the key AND the doc_scope check each hold alone)
//   [S]  guarded by neither: the `source='direct'` predicate keeps indexed md rows out of every delete

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LiteCtx, GLOBAL } from "../src/index.js";

const enc = (s) => new TextEncoder().encode(s);
const mk = () => new LiteCtx({ root: mkdtempSync(join(tmpdir(), "litectx-dtk-")), dbPath: ":memory:" });
const rows = (ctx, sql, ...a) => ctx.store.db.prepare(sql).all(...a);
const SEP = "\x1e"; // the DOC key separator
const FSEP = "\x1f"; // the fact/episode key separator (must never reach a caller either)
const texts = async (view, q, kind = "doc") => (await view.recall(q, { kind, n: 10, body: true })).map((h) => h.body);

test("[K] regression (verify-A): same filename ingested by A and B — both survive, each reads only its own", async () => {
  const ctx = mk();
  const A = ctx.scoped("A");
  const B = ctx.scoped("B");
  const ra = await A.ingest(enc("alpha secret text"), { filename: "contract.txt" });
  assert.equal((await A.recall("alpha secret", { kind: "doc" })).length, 1);
  await B.ingest(enc("beta other text"), { filename: "contract.txt" });
  assert.equal((await A.recall("alpha secret", { kind: "doc" })).length, 1, "A's row survives B's same-name ingest");
  assert.equal((await B.recall("beta other", { kind: "doc" })).length, 1);
  assert.equal((await A.recall("beta other", { kind: "doc" })).length, 0, "A never sees B's");
  assert.equal((await B.recall("alpha secret", { kind: "doc" })).length, 0, "B never sees A's");
  assert.equal(A.get(`${ra.id}#0`).text, "alpha secret text");
  assert.equal(B.get(`${ra.id}#0`).text, "beta other text");
  assert.equal(rows(ctx, "SELECT path FROM doc_fts WHERE source='direct'").length, 2, "two physical rows, one public id");
  ctx.close();
});

test("[K] re-ingest under A replaces only A's segments (shorter re-ingest leaves no orphan, B untouched)", async () => {
  const ctx = mk();
  const A = ctx.scoped("A");
  const B = ctx.scoped("B");
  await A.ingest(enc("aardvark one\n\naardvark two\n\naardvark three"), { filename: "notes.txt" });
  await B.ingest(enc("bonobo one\n\nbonobo two"), { filename: "notes.txt" });
  const before = rows(ctx, "SELECT path FROM doc_fts WHERE source='direct' AND path LIKE 'B%'").length;
  await A.ingest(enc("armadillo only"), { filename: "notes.txt" });
  assert.equal((await A.recall("aardvark", { kind: "doc" })).length, 0, "A's old text replaced");
  assert.equal((await A.recall("armadillo", { kind: "doc" })).length, 1);
  assert.equal(rows(ctx, "SELECT path FROM doc_fts WHERE source='direct' AND path LIKE 'B%'").length, before, "B's rows unchanged");
  assert.ok((await B.recall("bonobo", { kind: "doc" })).length >= 1);
  ctx.close();
});

test("[K] same-name BLOB under A and B: bytes kept per tenant; forgetting A leaves B's bytes", async () => {
  const ctx = mk();
  const A = ctx.scoped("A");
  const B = ctx.scoped("B");
  const ra = await A.ingest(Uint8Array.from([1, 2, 3]), { filename: "sheet.xlsx" });
  await B.ingest(Uint8Array.from([9, 8, 7]), { filename: "sheet.xlsx" });
  assert.deepEqual([...A.get(ra.id).bytes], [1, 2, 3]);
  assert.deepEqual([...B.get(ra.id).bytes], [9, 8, 7]);
  assert.equal(rows(ctx, "SELECT path FROM blobs").length, 2);
  assert.equal(A.forget({ id: ra.id }), 1);
  assert.equal(A.get(ra.id), null);
  assert.deepEqual([...B.get(ra.id).bytes], [9, 8, 7]);
  assert.equal(rows(ctx, "SELECT path FROM blobs").length, 1, "A's bytes reclaimed, B's kept");
  ctx.close();
});

test("[K] remember kind:'doc' same id under A, B, GLOBAL — three rows coexist; get resolves tenant first, then the shared id", async () => {
  const ctx = mk();
  await ctx.scoped("A").remember("faq", "apple faq answer", { kind: "doc" });
  await ctx.scoped("B").remember("faq", "banana faq answer", { kind: "doc" });
  await ctx.remember("faq", "shared faq answer", { kind: "doc", scope: GLOBAL });
  assert.equal(rows(ctx, "SELECT path FROM doc_fts WHERE source='direct'").length, 3);
  assert.equal(ctx.scoped("A").get("faq").text, "apple faq answer", "tenant row wins over the same-id shared row");
  assert.equal(ctx.scoped("B").get("faq").text, "banana faq answer");
  assert.equal(ctx.scoped(GLOBAL).get("faq").text, "shared faq answer", "GLOBAL view reads only the shared row");
  assert.equal(ctx.scoped("C").get("faq").text, "shared faq answer", "a tenant with no own row falls back to the shared one");
  // re-remember under A supersedes in place
  await ctx.scoped("A").remember("faq", "avocado faq answer", { kind: "doc" });
  assert.equal(rows(ctx, "SELECT path FROM doc_fts WHERE source='direct'").length, 3, "no duplicate row");
  assert.equal(ctx.scoped("A").get("faq").text, "avocado faq answer");
  assert.equal(ctx.scoped("B").get("faq").text, "banana faq answer");
  // a tenant's EXPIRED row falls back to the shared row (not to null)
  await ctx.scoped("D").remember("faq", "durian faq answer", { kind: "doc", expiresAt: Date.now() - 1000 });
  assert.equal(ctx.scoped("D").get("faq").text, "shared faq answer");
  ctx.close();
});

test("[K] forget({id}) under A deletes only A's row; GLOBAL forget deletes only the shared row", async () => {
  const ctx = mk();
  await ctx.scoped("A").remember("faq", "apple faq answer", { kind: "doc" });
  await ctx.scoped("B").remember("faq", "banana faq answer", { kind: "doc" });
  await ctx.remember("faq", "shared faq answer", { kind: "doc", scope: GLOBAL });
  assert.equal(ctx.scoped("A").forget({ id: "faq" }), 1);
  assert.equal(ctx.scoped("B").get("faq").text, "banana faq answer");
  assert.equal(ctx.scoped(GLOBAL).get("faq").text, "shared faq answer");
  assert.equal(ctx.scoped("A").get("faq").text, "shared faq answer", "A's own row is gone — falls back to shared");
  assert.equal(ctx.forget({ scope: GLOBAL, id: "faq" }), 1, "GLOBAL forget removes only the shared row");
  assert.equal(ctx.scoped("B").get("faq").text, "banana faq answer", "B survived the GLOBAL forget");
  assert.equal(ctx.scoped("A").forget({ id: "faq" }), 0, "a second forget under A finds nothing — never B's row");
  assert.equal(ctx.scoped("B").get("faq").text, "banana faq answer");
  ctx.close();
});

test("[K] forget({scope, kind:'doc'}) wipes only that tenant's docs; forget({idPrefix}) only that tenant's segments", async () => {
  const ctx = mk();
  const A = ctx.scoped("A");
  const B = ctx.scoped("B");
  await A.ingest(enc("alpha one\n\nalpha two"), { filename: "d.txt", id: "doc:d" });
  await B.ingest(enc("bravo one\n\nbravo two"), { filename: "d.txt", id: "doc:d" });
  await A.remember("fact:keep", "alpha fact stays", { kind: "fact" });
  await ctx.remember("shared", "shared doc stays", { kind: "doc", scope: GLOBAL });
  assert.equal(B.forget({ idPrefix: "doc:d" }) >= 1, true);
  assert.equal((await B.recall("bravo", { kind: "doc" })).length, 0);
  assert.ok((await A.recall("alpha", { kind: "doc" })).length >= 1, "A's segments untouched by B's idPrefix forget");
  const n = A.forget({ kind: "doc" });
  assert.ok(n >= 1, "tenant doc wipe removed A's rows");
  assert.equal((await A.recall("alpha one", { kind: "doc" })).length, 0);
  assert.equal(A.get("fact:keep").text, "alpha fact stays", "a doc wipe never touches the tenant's memory axis");
  assert.equal(ctx.scoped(GLOBAL).get("shared").text, "shared doc stays", "shared tier untouched by a tenant wipe");
  assert.equal(rows(ctx, "SELECT path FROM doc_scope WHERE scope='A' OR scope='B'").length, 0, "no orphan doc_scope rows");
  assert.equal(rows(ctx, "SELECT path FROM mem_text WHERE path LIKE 'A%' AND path LIKE '%doc:d%'").length, 0, "no orphan mem_text");
  ctx.close();
});

test("[S] forget never touches an indexed (source='file') md row, by id or by tenant wipe", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-dtk-"));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(root, "guide.md"), "# Guide\n\nfile resident zebra paragraph\n");
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  await ctx.scoped("A").remember("guide.md", "tenant doc sharing the file's id", { kind: "doc" });
  assert.equal(ctx.scoped("A").forget({ id: "guide.md" }), 1, "only A's direct row");
  assert.equal(ctx.scoped("A").forget({ kind: "doc" }), 0);
  assert.equal(ctx.forget({ scope: GLOBAL, kind: "doc" }), 0, "GLOBAL doc wipe has no direct shared row to hit");
  assert.ok(rows(ctx, "SELECT 1 FROM doc_fts WHERE source='file' AND path='guide.md'").length >= 1, "file row intact");
  assert.ok((await ctx.recall("zebra", { kind: "doc" })).length >= 1);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("[K] vectors are per-tenant: same-id written docs keep separate mem_embeddings rows; forgetting A drops only A's", () => {
  const ctx = mk();
  const mkVec = (x) => Float32Array.from([x, 0, 0, 1]);
  for (const [scope, x] of [["A", 1], ["B", 2], [null, 3]]) {
    ctx.store.writeMemory({ id: "v", text: `vec doc ${scope}`, kind: "doc", format: "md", provenance: "agent", occurredAt: null, scope, embedding: mkVec(x) });
  }
  assert.equal(rows(ctx, "SELECT path FROM mem_embeddings").length, 3);
  assert.equal(ctx.scoped("A").forget({ id: "v" }), 1);
  assert.deepEqual(rows(ctx, "SELECT path FROM mem_embeddings ORDER BY path").map((r) => r.path), [SEP + "v", "B" + SEP + "v"]);
  ctx.close();
});

test("[K] purge() reclaims only the expired same-id row and its sidecars (bytes, meta, vector, scope)", async () => {
  const ctx = mk();
  const now = Date.now();
  await ctx.scoped("A").remember("p", "pear doc", { kind: "doc", expiresAt: now - 5 });
  await ctx.scoped("B").remember("p", "plum doc", { kind: "doc", expiresAt: now + 60_000 });
  assert.equal(ctx.purge({ now }), 1);
  assert.equal(ctx.scoped("A").get("p"), null);
  assert.equal(ctx.scoped("B").get("p").text, "plum doc");
  assert.equal(rows(ctx, "SELECT path FROM doc_scope").length, 1);
  assert.equal(rows(ctx, "SELECT path FROM mem_text").length, 1);
  ctx.close();
});

test("[KF] get(id) across tenants: B's id is invisible to A and C; chunk/body fetch of a tenant doc is unaffected", async () => {
  const ctx = mk();
  await ctx.scoped("B").remember("only-b", "bravo private text", { kind: "doc" });
  assert.equal(ctx.scoped("A").get("only-b"), null);
  assert.equal(ctx.scoped(GLOBAL).get("only-b"), null);
  assert.equal(ctx.scoped("B").get("only-b").text, "bravo private text");
  assert.equal(ctx.get("only-b", { scope: "A" }), null);
  ctx.close();
});

test("[F] recall fence: a tenant's recall never returns another tenant's doc (a key cannot fence a MATCH)", async () => {
  const ctx = mk();
  await ctx.scoped("A").remember("a1", "quokka habitat notes", { kind: "doc" });
  await ctx.scoped("B").remember("b1", "quokka diet notes", { kind: "doc" });
  await ctx.remember("g1", "quokka shared notes", { kind: "doc", scope: GLOBAL });
  const a = await texts(ctx.scoped("A"), "quokka");
  assert.deepEqual(a.sort(), ["quokka habitat notes", "quokka shared notes"], "own ∪ global");
  const g = await texts(ctx.scoped(GLOBAL), "quokka");
  assert.deepEqual(g, ["quokka shared notes"]);
  assert.deepEqual((await ctx.scoped("A").recentMemory({ kind: "doc" })).map((h) => h.path).sort(), ["a1", "g1"]);
  assert.equal(ctx.scoped("B").count({ kind: "doc" }), 2, "B counts own + shared");
  ctx.close();
});

test("[KF] no \\x1E / \\x1F ever reaches a caller (recall flat+grouped, get, recentMemory, ingest result, body fill)", async () => {
  const ctx = mk();
  const A = ctx.scoped("tenantzed");
  const r = await A.ingest(enc("kiwi bird facts\n\nkiwi egg facts"), { filename: "birds.txt" });
  await A.remember("note", "kiwi note", { kind: "doc" });
  await A.ingest(Uint8Array.from([1, 2]), { filename: "kiwi.xlsx" });
  const flat = await A.recall("kiwi", { kind: "doc", n: 10, body: true });
  const grouped = await A.recall("kiwi", { kind: ["doc"], n: 10 });
  const recent = A.recentMemory({ kind: "doc", n: 10, body: true });
  assert.ok(flat.length >= 3 && recent.length >= 3);
  const all = JSON.stringify([flat, grouped, recent, r, A.get("note"), A.get(`${r.id}#0`)]);
  assert.ok(!all.includes(SEP) && !all.includes(FSEP) && !all.includes("\\u001e") && !all.includes("\\u001f"), "no separator in any output");
  assert.ok(flat.every((h) => !h.path.includes("tenantzed")), "paths are the public ids");
  ctx.close();
});

test("[F] querying a tenant's name never matches its docs (FTS body tokenizes the PUBLIC id)", async () => {
  const ctx = mk();
  await ctx.scoped("tenantzed").remember("note", "kiwi note about birds", { kind: "doc" });
  await ctx.scoped("tenantzed").ingest(enc("kiwi egg facts"), { filename: "eggs.txt" });
  assert.equal(rows(ctx, "SELECT 1 FROM doc_fts WHERE doc_fts MATCH 'tenantzed'").length, 0, "raw FTS: prefix not indexed");
  assert.equal((await ctx.scoped("tenantzed").recall("tenantzed", { kind: "doc" })).length, 0);
  assert.equal((await ctx.recall("tenantzed", { kind: "doc" })).length, 0);
  assert.ok((await ctx.scoped("tenantzed").recall("kiwi", { kind: "doc" })).length >= 2, "precondition: docs are recallable");
  ctx.close();
});

test("[KF] the reserved separators (\\x1E and \\x1F) are rejected in a doc id or scope at write (forgery guard)", async () => {
  const ctx = mk();
  await assert.rejects(() => ctx.remember(`x${SEP}y`, "t", { kind: "doc" }), /\\x1F/);
  await assert.rejects(() => ctx.remember("ok", "t", { kind: "doc", scope: `A${SEP}B` }), /\\x1F/);
  await assert.rejects(() => ctx.ingest(Uint8Array.from([1]), { filename: "a.xlsx", scope: `A${SEP}B` }), /\\x1F/);
  await assert.rejects(() => ctx.ingest(enc("hello world"), { filename: "a.txt", scope: `A${SEP}B` }), /\\x1F/);
  await assert.rejects(() => ctx.ingest(Uint8Array.from([1]), { filename: "a.xlsx", id: `d${SEP}x` }), /\\x1F/);
  assert.equal(rows(ctx, "SELECT 1 FROM doc_fts").length, 0, "nothing written");
  for (const sep of [FSEP]) {
    await assert.rejects(() => ctx.remember(`x${sep}y`, "t", { kind: "doc" }), /\\x1F/);
    await assert.rejects(() => ctx.remember("ok", "t", { kind: "doc", scope: `A${sep}B` }), /\\x1F/);
  }
  ctx.close();
});

test("migration: an old-shape db (bare-keyed scoped direct doc + segments + blob + vector) is re-keyed on open, idempotently", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-dtk-"));
  const dbPath = join(root, "old.db");
  const seed = new LiteCtx({ root, dbPath });
  await seed.scoped("tenantA").remember("doc:written", "old shape quokka note", { kind: "doc", meta: { k: 1 } });
  await seed.scoped("tenantA").ingest(enc("old shape zebra one\n\nold shape zebra two"), { filename: "up.txt" });
  await seed.scoped("tenantA").ingest(Uint8Array.from([4, 5, 6]), { filename: "sheet.xlsx" });
  await seed.remember("doc:shared", "shared unscoped doc", { kind: "doc", scope: GLOBAL });
  await seed.remember("fact:mine", "a global fact", { kind: "fact", scope: GLOBAL });
  seed.close();
  // rewrite to the OLD (main) shape with raw SQL: strip the `scope\x1E` prefix from every direct-doc key (bare ids)
  const raw = new Database(dbPath);
  const strip = "substr(path, instr(path, char(30)) + 1)";
  raw.exec(`UPDATE doc_fts SET path = ${strip} WHERE source='direct' AND instr(path, char(30)) > 0`);
  for (const t of ["doc_scope", "mem_text", "mem_meta", "blobs"]) raw.exec(`UPDATE ${t} SET path = ${strip} WHERE instr(path, char(30)) > 0`);
  raw.prepare("INSERT INTO mem_embeddings(path, dim, vec) VALUES (?, 4, ?)").run("doc:written", Buffer.from(Float32Array.from([1, 0, 0, 1]).buffer));
  assert.equal(raw.prepare("SELECT count(*) n FROM doc_fts WHERE instr(path, char(30)) > 0").get().n, 0, "precondition: old shape has no keys");
  raw.close();

  const ctx = new LiteCtx({ root, dbPath });
  const keyed = rows(ctx, "SELECT path FROM doc_fts WHERE source='direct' AND instr(path, char(30)) > 0").map((r) => r.path).sort();
  assert.ok(keyed.includes(`tenantA${SEP}doc:written`) && keyed.includes(`tenantA${SEP}doc:up#0`) && keyed.includes(`tenantA${SEP}doc:sheet`), "scoped rows re-keyed");
  assert.ok(rows(ctx, `SELECT 1 FROM doc_fts WHERE path='${SEP}doc:shared'`).length === 1 && rows(ctx, "SELECT 1 FROM doc_fts WHERE path='doc:shared'").length === 0, "unscoped row moved to the global doc key");
  assert.equal(rows(ctx, "SELECT 1 FROM mem WHERE path='fact:mine'").length, 1, "memory axis untouched");
  for (const [t, p] of [["doc_scope", `tenantA${SEP}doc:written`], ["mem_text", `tenantA${SEP}doc:written`], ["mem_meta", `tenantA${SEP}doc:written`], ["mem_embeddings", `tenantA${SEP}doc:written`], ["blobs", `tenantA${SEP}doc:sheet`]]) {
    assert.equal(rows(ctx, `SELECT 1 FROM ${t} WHERE path=?`, p).length, 1, `${t} re-keyed`);
    assert.equal(rows(ctx, `SELECT 1 FROM ${t} WHERE path=?`, p.slice(p.indexOf(SEP) + 1)).length, 0, `${t} bare key gone`);
  }
  const A = ctx.scoped("tenantA");
  assert.equal(A.get("doc:written").text, "old shape quokka note");
  assert.deepEqual(A.get("doc:written").meta, { k: 1 });
  assert.deepEqual([...A.get("doc:sheet").bytes], [4, 5, 6]);
  assert.equal((await A.recall("quokka", { kind: "doc" })).length, 1);
  assert.ok((await A.recall("zebra", { kind: "doc" })).length >= 1);
  assert.equal(ctx.scoped("tenantB").get("doc:written"), null);
  assert.equal((await ctx.scoped("tenantB").recall("quokka", { kind: "doc" })).length, 0);
  // post-migration a same-id write by another tenant no longer clobbers
  await ctx.scoped("tenantB").remember("doc:written", "tenant b version", { kind: "doc" });
  assert.equal(A.get("doc:written").text, "old shape quokka note");
  ctx.close();

  const snap = (c) => JSON.stringify(rows(c, "SELECT rowid, path, source FROM doc_fts ORDER BY rowid"));
  const second = new LiteCtx({ root, dbPath });
  const s1 = snap(second);
  second.close();
  const third = new LiteCtx({ root, dbPath });
  assert.equal(snap(third), s1, "second open is a no-op");
  third.close();
  rmSync(root, { recursive: true, force: true });
});

test("[KF] a bare (non-strict) get stays the documented unfenced by-id model: shared row first, else a tenant's row by its public id", async () => {
  const ctx = mk();
  await ctx.scoped("B").remember("only-b", "bravo private text", { kind: "doc" });
  assert.equal(ctx.get("only-b").text, "bravo private text", "unfenced bare get reaches the tenant row");
  await ctx.scoped("A").remember("both", "apple version", { kind: "doc" });
  await ctx.remember("both", "shared version", { kind: "doc", scope: GLOBAL });
  assert.equal(ctx.get("both").text, "shared version", "shared row wins a bare get when both exist");
  assert.equal(ctx.get("both").id, "both");
  ctx.close();
});
