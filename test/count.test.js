// count({scope, kind}) (multis M4 O1) — per-tenant memory counts for `/memory`, `/docs` without
// pulling rows. Tenant-fenced + expiry-aware on the SAME predicates as recall/recentMemory. Behavior,
// not implementation; the fence and expiry claims are written to FAIL if a tenant's count leaked
// another's rows or counted an expired upload.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, GLOBAL } from "../src/index.js";

function db(tag) {
  const root = mkdtempSync(join(tmpdir(), `litectx-count-${tag}-`));
  return { root, dbPath: join(root, "c.db") };
}

test("counts a tenant's facts ∪ shared, never another tenant's", async () => {
  const { root, dbPath } = db("fence");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("fact:a1", "A one", { kind: "fact", scope: "A" });
  await ctx.remember("fact:a2", "A two", { kind: "fact", scope: "A" });
  await ctx.remember("fact:b1", "B one", { kind: "fact", scope: "B" });
  await ctx.remember("fact:g1", "shared", { kind: "fact", scope: GLOBAL });

  assert.equal(ctx.count({ scope: "A", kind: "fact" }), 3, "A's two + the shared one");
  assert.equal(ctx.count({ scope: "B", kind: "fact" }), 2, "B's one + the shared one");
  assert.equal(ctx.count({ scope: GLOBAL, kind: "fact" }), 1, "shared tier only");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("kind splits fact vs episode; omitted kind sums all writable kinds for the scope", async () => {
  const { root, dbPath } = db("kinds");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("fact:a", "a fact", { kind: "fact", scope: "A" });
  await ctx.remember("ep:a1", "an exchange", { kind: "episode", scope: "A" });
  await ctx.remember("ep:a2", "another exchange", { kind: "episode", scope: "A" });
  await ctx.remember("doc:a", "a doc", { kind: "doc", scope: "A" });

  assert.equal(ctx.count({ scope: "A", kind: "fact" }), 1);
  assert.equal(ctx.count({ scope: "A", kind: "episode" }), 2);
  assert.equal(ctx.count({ scope: "A", kind: "doc" }), 1);
  assert.equal(ctx.count({ scope: "A", kind: ["fact", "episode"] }), 3, "array sums across kinds");
  assert.equal(ctx.count({ scope: "A" }), 4, "omitted = fact+episode+doc for the scope (spans both axes)");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("doc count excludes expired uploads (R5)", async () => {
  const { root, dbPath } = db("expiry");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("doc:live", "fresh", { kind: "doc", scope: "A" });
  await ctx.remember("doc:dead", "stale", { kind: "doc", scope: "A", expiresAt: Date.now() - 1000 });

  assert.equal(ctx.count({ scope: "A", kind: "doc" }), 1, "only the live upload counts");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("strictScope: a count with no scope throws (fail-closed, like the read verbs)", async () => {
  const { root, dbPath } = db("strict");
  const ctx = new LiteCtx({ root, dbPath, strictScope: true });
  await ctx.remember("fact:t", "tenant fact", { kind: "fact", scope: "t1" });

  assert.throws(() => ctx.count({ kind: "fact" }), /strictScope/, "missing scope throws on the memory axis");
  assert.throws(() => ctx.count({ kind: "doc" }), /strictScope/, "missing scope throws on the doc axis");
  assert.equal(ctx.count({ scope: "t1", kind: "fact" }), 1, "explicit scope works");
  assert.throws(() => ctx.count({ scope: "t1", kind: "bogus" }), /fact \| episode \| doc/, "unknown kind throws");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("ScopedView.count binds the tenant", async () => {
  const { root, dbPath } = db("view");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("fact:a", "A", { kind: "fact", scope: "A" });
  await ctx.remember("fact:b", "B", { kind: "fact", scope: "B" });
  await ctx.remember("fact:g", "shared", { kind: "fact", scope: GLOBAL });

  assert.equal(ctx.scoped("A").count({ kind: "fact" }), 2, "A + shared, never B");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
