// multis M4 W4 — update / supersede a fact by stable key, tenant-fenced.
//
// Pre-W4 a fact/episode keyed on the bare id GLOBALLY, so two tenants' same id (`fact:age`) collided:
// the second write clobbered the first. W4 folds the owner into the PHYSICAL key (`owner\x1Fid`) so the
// same id under two scopes is two distinct rows, while a re-write under ONE scope still supersedes in
// place. The consumer never sees the prefix — recall/get/recentMemory return the public id. Behavior,
// not implementation; every assertion would FAIL under the pre-W4 owner-blind key (the mutation check is
// built in — clause 2 below clobbers without the encoding).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LiteCtx } from "../src/index.js";

function sharedDb() {
  const root = mkdtempSync(join(tmpdir(), "litectx-w4-"));
  mkdirSync(join(root, "src"), { recursive: true });
  return { root, dbPath: join(root, "w4.db") };
}
const texts = async (p) => (await p).map((h) => h.body); // recall({body:true}) fills `body`, not `text`
const SEP = "\x1f";

// === Acceptance clause 1: supersede in place (same id, same scope → ONE row, the latest) =========
test("W4: re-remember the same id under the same scope supersedes (recall/recentMemory return only v2)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  const A = ctx.scoped("cust:A");
  await A.remember("fact:age", "the user is 44", { kind: "fact" });
  await A.remember("fact:age", "the user is 45", { kind: "fact" }); // supersede

  const hits = await A.recall("user age", { kind: "fact" });
  assert.equal(hits.length, 1, "exactly one row survives (no pile-up)");
  assert.equal(hits[0].text, undefined, "recall returns pointers; body only with { body: true }");
  assert.deepEqual(await texts(A.recall("user age", { kind: "fact", body: true })), ["the user is 45"], "the surviving row is v2");
  // and the public id round-trips back through get under the same scope
  assert.equal(hits[0].path, "fact:age", "recall returns the PUBLIC id, not the owner-qualified key");
  assert.equal(ctx.get("fact:age", { scope: "cust:A" })?.text, "the user is 45", "get(publicId, scope) retrieves it");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === Acceptance clause 2: no cross-tenant clobber (same id under A and B → two rows) =============
test("W4: the same id under a different scope is a SEPARATE row (no cross-tenant clobber)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.scoped("cust:A").remember("fact:age", "A is 44", { kind: "fact" });
  await ctx.scoped("cust:B").remember("fact:age", "B is 30", { kind: "fact" }); // would clobber A pre-W4

  assert.deepEqual(await texts(ctx.scoped("cust:A").recall("age", { kind: "fact", body: true })), ["A is 44"], "A's row survived B's same-id write");
  assert.deepEqual(await texts(ctx.scoped("cust:B").recall("age", { kind: "fact", body: true })), ["B is 30"], "B has its own row");
  // each tenant's get sees only its own value for the shared id
  assert.equal(ctx.get("fact:age", { scope: "cust:A" })?.text, "A is 44", "A's get");
  assert.equal(ctx.get("fact:age", { scope: "cust:B" })?.text, "B is 30", "B's get");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === recentMemory rides the same fence + decode ==================================================
test("W4: recentMemory on the memory axis returns each tenant's own row by public id", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.scoped("cust:A").remember("fact:x", "A value", { kind: "fact" });
  await ctx.scoped("cust:B").remember("fact:x", "B value", { kind: "fact" });

  const recentA = ctx.scoped("cust:A").recentMemory({ kind: "fact", body: true });
  assert.deepEqual(recentA.map((h) => [h.path, h.body]), [["fact:x", "A value"]], "A's recency view: public id, A's value");
  const recentB = ctx.scoped("cust:B").recentMemory({ kind: "fact", body: true });
  assert.deepEqual(recentB.map((h) => [h.path, h.body]), [["fact:x", "B value"]], "B's recency view: public id, B's value");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === Injection guard: the reserved separator can't be smuggled into an id/owner =================
test("W4: a reserved-separator id or scope is rejected on write (key-forgery guard)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await assert.rejects(() => ctx.scoped("cust:A").remember(`fact${SEP}forged`, "x", { kind: "fact" }), /reserved/, "a separator in the id throws");
  await assert.rejects(() => ctx.scoped(`cust${SEP}A`).remember("fact:y", "x", { kind: "fact" }), /reserved/, "a separator in the scope throws");
  // the separator is reserved in EVERY id namespace, not just mem — `memId` decodes every returned path,
  // so a doc/blob id with it would be silently mangled on the way out (security finding F1).
  await assert.rejects(() => ctx.remember(`doc${SEP}x`, "x", { kind: "doc" }), /reserved/, "a separator in a doc id throws too");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === Global tier coexists with tenant rows under the same id =====================================
test("W4: a GLOBAL (ownerless) row and a tenant row can share an id; a tenant sees its own then the global", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("fact:policy", "the shared default", { kind: "fact" }); // ownerless instance → global row at bare key
  await ctx.scoped("cust:A").remember("fact:policy", "A's override", { kind: "fact" });

  assert.equal(ctx.get("fact:policy", { scope: "cust:A" })?.text, "A's override", "A's own row wins on get");
  assert.equal(ctx.get("fact:policy", { scope: "cust:B" })?.text, "the shared default", "B (no own row) falls back to the global default");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// === getNode resolves an owner-keyed mem row by its public id (regression: no scope param) ========
test("W4: getNode finds a single-tenant instance's own fact by public id, and a global fact", async () => {
  const { root, dbPath } = sharedDb();
  const owned = new LiteCtx({ root, dbPath, owner: "alice" }); // single-tenant instance
  await owned.remember("fact:role", "alice is staff", { kind: "fact" }); // → key alice\x1Ffact:role
  const n = owned.getNode("fact:role");
  assert.equal(n?.source, "direct", "getNode resolves the instance owner's own fact by public id");
  assert.equal(n?.kind, "fact", "kind surfaced");
  assert.equal(n?.id, "fact:role", "node id is the PUBLIC id");
  owned.close();
  // a global (ownerless) fact is found by a global instance
  const glob = new LiteCtx({ root, dbPath });
  await glob.remember("fact:global", "the shared default", { kind: "fact" });
  assert.equal(glob.getNode("fact:global")?.source, "direct", "global fact found via bare id");
  glob.close();
  rmSync(root, { recursive: true, force: true });
});

// === Migration: a simulated pre-W4 owner-tagged row (bare-id key) is re-keyed on open ============
test("W4 migration: a legacy owner-tagged row (pre-W4 bare-id key) re-keys on open; a re-remember supersedes (no duplicate)", async () => {
  const { root, dbPath } = sharedDb();
  // 1. build the W4 schema, then close — migration runs on an empty store (no-op).
  new LiteCtx({ root, dbPath }).close();
  // 2. hand-seed a PRE-W4 owner-tagged fact: path = bare id, owner in mem_scope (how 0.21/0.22 wrote it).
  const raw = new Database(dbPath);
  raw.prepare("INSERT INTO mem(path, kind, format, provenance, occurred_at, body) VALUES (?, 'fact', 'text', 'human', NULL, ?)").run("fact:legacy", "the auth service uses jwt tokens");
  raw.prepare("INSERT INTO mem_text(path, text) VALUES (?, ?)").run("fact:legacy", "the auth service uses JWT tokens");
  raw.prepare("INSERT INTO mem_scope(path, owner, session, created_at) VALUES (?, ?, NULL, ?)").run("fact:legacy", "cust:A", 1000);
  raw.prepare("INSERT INTO recall_log(path, kind, action, ts) VALUES (?, 'fact', 'recall', ?)").run("fact:legacy", 1000);
  raw.close();
  // 3. re-open → constructor runs the W4 migration.
  const ctx = new LiteCtx({ root, dbPath });
  // the legacy row is still readable by its PUBLIC id under its owner's scope...
  assert.deepEqual(await texts(ctx.scoped("cust:A").recall("auth jwt", { kind: "fact", body: true })), ["the auth service uses JWT tokens"], "legacy row found post-migration");
  // ...and the underlying key was re-keyed to the owner-qualified form.
  const after = new Database(dbPath);
  const keys = after.prepare("SELECT path FROM mem_scope WHERE owner = 'cust:A'").all().map((r) => r.path);
  after.close();
  assert.deepEqual(keys, ["cust:A" + SEP + "fact:legacy"], "mem_scope row re-keyed to owner\\x1Fid");
  // 4. a re-remember of the same id under the same scope SUPERSEDES (no duplicate from the migrated row).
  await ctx.scoped("cust:A").remember("fact:legacy", "the auth service uses OAuth now", { kind: "fact" });
  assert.deepEqual(await texts(ctx.scoped("cust:A").recall("auth", { kind: "fact", body: true })), ["the auth service uses OAuth now"], "supersedes the migrated row — one row, not two");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
