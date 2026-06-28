// enumerate({ kind, scope, offset, limit, body }) (bareagent RLM `scan`) — exhaustive, scope-fenced,
// deterministic, rank-free paginated read of one memory kind: the structural opposite of recall (which is
// FTS-gated + ranked + capped, so it misses the tail). Behavior, not implementation; every claim is written
// to FAIL if a page dropped/duplicated a row, leaked another tenant's row, or polluted the demand signal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, GLOBAL } from "../src/index.js";

function db(tag) {
  const root = mkdtempSync(join(tmpdir(), `litectx-enum-${tag}-`));
  return { root, dbPath: join(root, "e.db") };
}

/** page-walk a kind to its end → ordered id list. */
async function drain(ctx, opts, limit = 100) {
  const ids = [];
  let off = 0,
    page;
  do {
    page = await ctx.enumerate({ ...opts, offset: off, limit });
    assert.ok(page.items.length <= limit, "page must not exceed limit");
    page.items.forEach((it) => ids.push(it.path));
    off = page.nextOffset;
  } while (off !== null);
  return ids;
}

test("unioning every page yields EXACTLY the kind's rows — gapless, no dupes", async () => {
  const { root, dbPath } = db("complete");
  const ctx = new LiteCtx({ root, dbPath });
  const truth = new Set();
  for (let i = 0; i < 250; i++) {
    const id = `fact:${i}`;
    truth.add(id);
    await ctx.remember(id, `record ${i}`, { kind: "fact" });
  }
  const ids = await drain(ctx, { kind: "fact" }, 40);
  const seen = new Set(ids);
  assert.equal(seen.size, truth.size, "complete");
  assert.deepEqual([...truth].filter((id) => !seen.has(id)), [], "no row missing");
  assert.equal(ids.length, seen.size, "no duplicate row across pages");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("does what recall structurally cannot — returns the no-lexical-overlap tail recall misses", async () => {
  const { root, dbPath } = db("vs-recall");
  const ctx = new LiteCtx({ root, dbPath });
  for (let i = 0; i < 100; i++) {
    // even rows mention "sports"; odd rows carry a token no query supplies.
    await ctx.remember(`fact:${i}`, i % 2 === 0 ? `sports league ${i}` : `zzqx payload ${i}`, { kind: "fact" });
  }
  const enumSet = new Set(await drain(ctx, { kind: "fact" }));
  const recSet = new Set((await ctx.recall("sports", { kind: "fact", n: 100 })).map((h) => h.path));
  assert.equal(enumSet.size, 100, "enumerate sees all");
  assert.ok(recSet.size < enumSet.size, "recall(big-n) misses rows");
  assert.ok([...recSet].every((p) => enumSet.has(p)), "recall set ⊆ enumerate set");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("scope-fenced — a scoped instance enumerates its own ∪ shared, never another tenant's", async () => {
  const { root, dbPath } = db("scope");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("fact:a1", "A one", { kind: "fact", scope: "A" });
  await ctx.remember("fact:a2", "A two", { kind: "fact", scope: "A" });
  await ctx.remember("fact:b1", "B one", { kind: "fact", scope: "B" });
  await ctx.remember("fact:g1", "shared", { kind: "fact", scope: GLOBAL });

  const aIds = new Set(await drain(ctx, { kind: "fact", scope: "A" }));
  assert.deepEqual([...aIds].sort(), ["fact:a1", "fact:a2", "fact:g1"], "A's own + shared, not B");
  assert.equal((await ctx.enumerate({ kind: "fact", scope: "A", offset: 0, limit: 100 })).total, 3, "total is scoped");

  // ScopedView binds the scope so it can't be forgotten.
  const bView = ctx.scoped("B");
  const bIds = new Set((await bView.enumerate({ kind: "fact", offset: 0, limit: 100 })).items.map((it) => it.path));
  assert.deepEqual([...bIds].sort(), ["fact:b1", "fact:g1"], "B's own + shared, not A");

  // an unscoped instance sees everything
  assert.equal((await ctx.enumerate({ kind: "fact", offset: 0, limit: 100 })).total, 4, "unscoped sees all");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("deterministic order — two full walks are identical", async () => {
  const { root, dbPath } = db("determ");
  const ctx = new LiteCtx({ root, dbPath });
  for (let i = 0; i < 60; i++) await ctx.remember(`fact:${i}`, `r${i}`, { kind: "fact" });
  const w1 = await drain(ctx, { kind: "fact" }, 17);
  const w2 = await drain(ctx, { kind: "fact" }, 17);
  assert.deepEqual(w1, w2);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("body:true inlines verbatim stored text (=== get); body:false returns pointers only", async () => {
  const { root, dbPath } = db("body");
  const ctx = new LiteCtx({ root, dbPath });
  await ctx.remember("fact:x", "the verbatim body of x", { kind: "fact" });
  const withBody = await ctx.enumerate({ kind: "fact", offset: 0, limit: 10, body: true });
  assert.equal(withBody.items[0].body, "the verbatim body of x");
  assert.equal(withBody.items[0].body, ctx.get("fact:x").text, "=== get(id).text");
  const noBody = await ctx.enumerate({ kind: "fact", offset: 0, limit: 10 });
  assert.equal(noBody.items[0].body, undefined, "pointers only by default");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("total === count(kind); nextOffset stops exactly at the last page", async () => {
  const { root, dbPath } = db("paging");
  const ctx = new LiteCtx({ root, dbPath });
  for (let i = 0; i < 25; i++) await ctx.remember(`fact:${i}`, `r${i}`, { kind: "fact" });
  const first = await ctx.enumerate({ kind: "fact", offset: 0, limit: 10 });
  assert.equal(first.total, ctx.count({ kind: "fact" }));
  assert.equal(first.nextOffset, 10, "advances by items.length");
  const last = await ctx.enumerate({ kind: "fact", offset: 20, limit: 10 });
  assert.equal(last.items.length, 5);
  assert.equal(last.nextOffset, null, "null exactly at the last page");
  const past = await ctx.enumerate({ kind: "fact", offset: 999, limit: 10 });
  assert.deepEqual(past.items, [], "past end → empty");
  assert.equal(past.nextOffset, null);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("episodes too; a full walk writes NO recall_log row (not user demand)", async () => {
  const { root, dbPath } = db("episode-nolog");
  const ctx = new LiteCtx({ root, dbPath });
  for (let i = 0; i < 5; i++) await ctx.remember(`ep:${i}`, `exchange ${i}`, { kind: "episode" });
  const logCount = () => ctx.store.db.prepare("SELECT count(*) AS n FROM recall_log").get().n;
  const before = logCount();
  const ids = await drain(ctx, { kind: "episode" });
  assert.equal(ids.length, 5, "episode axis enumerates");
  assert.equal(logCount(), before, "no demand-signal pollution");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("rejects non-mem kinds and bad pagination args", async () => {
  const { root, dbPath } = db("guard");
  const ctx = new LiteCtx({ root, dbPath });
  await assert.rejects(() => ctx.enumerate({ kind: "doc" }), /memory axis only/);
  await assert.rejects(() => ctx.enumerate({ kind: "code" }), /fact \| episode/);
  await assert.rejects(() => ctx.enumerate({ kind: "fact", offset: -1 }), /non-negative/);
  await assert.rejects(() => ctx.enumerate({ kind: "fact", limit: 0 }), /positive/);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
