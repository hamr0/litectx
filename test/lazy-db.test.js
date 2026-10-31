// The index file is created on the first WRITE, not by `new LiteCtx`. Reads on a store with no file behave as an
// empty store and create nothing; a connection opened before the file exists picks it up once someone writes.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "litectx-lazy-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** @param {boolean} [withFile] */
function root(withFile = false) {
  const d = join(tmp, `r${++n}`);
  mkdirSync(d);
  if (withFile) writeFileSync(join(d, "a.js"), "export function alpha() { return 1; }\n");
  return d;
}
const folder = (/** @type {string} */ r) => join(r, ".litectx");

test("every read on a fresh root answers as an empty store and creates nothing", async () => {
  const r = root();
  const ctx = new LiteCtx({ root: r });
  const sc = ctx.scoped("t");
  const answers = {
    recall: await ctx.recall("x"),
    recallCode: await ctx.recall("x", { kind: "code", body: true }),
    recallFact: await ctx.recall("x", { kind: "fact" }),
    scoped: await sc.recall("x"),
    impact: await ctx.impact("foo"),
    get: ctx.get("a.js"),
    chunk: ctx.get("a.js", { startLine: 0, endLine: 3 }),
    node: ctx.getNode("a.js"),
    size: ctx.size(),
    count: ctx.count({ kind: "fact" }),
    recent: ctx.recentActivity({}),
    recentMem: ctx.recentMemory({}),
    enumerate: ctx.enumerate({ kind: "fact" }),
    review: ctx.reviewCandidates(),
    promo: ctx.promotionCandidates(),
    peek: ctx.peek("z"),
    forget: ctx.forget("nope"),
    forgetKind: ctx.forget({ kind: "fact" }),
    purge: ctx.purge(),
    evict: ctx.evict("z"),
  };
  assert.deepEqual(answers.recallCode, []);
  assert.deepEqual(answers.recallFact, []);
  assert.deepEqual(answers.recall, { code: [], doc: [], fact: [], episode: [] });
  assert.equal(answers.impact, null);
  assert.equal(answers.get, null);
  assert.equal(answers.chunk, null);
  assert.equal(answers.node, null);
  assert.equal(answers.size, 0);
  assert.equal(answers.count, 0);
  assert.equal(answers.forget, 0);
  assert.equal(answers.purge, 0);
  assert.equal(existsSync(folder(r)), false, "no .litectx after reads");
  ctx.close();
  assert.equal(existsSync(folder(r)), false, "nor after close");
});

test("each kind of first write creates the file; reads before it left nothing behind", async () => {
  const mk = async (/** @type {(c: LiteCtx, r: string) => unknown} */ write) => {
    const r = root(true);
    const c = new LiteCtx({ root: r });
    await c.recall("alpha");
    assert.equal(existsSync(folder(r)), false);
    await write(c, r);
    assert.equal(existsSync(join(folder(r), "index.db")), true);
    c.close();
    return r;
  };
  await mk((c) => c.index());
  await mk((c) => c.remember("k", "a fact", { kind: "fact" }));
  await mk((c) => c.stash("s1", "text"));
  await mk((c) => c.ingest(Buffer.from("hello world"), { filename: "n.txt" }));
  const r = await mk((c) => c.index());
  const again = new LiteCtx({ root: r });
  assert.equal((await again.recall("alpha", { kind: "code" })).length, 1, "the file is reopened with its data");
  again.close();
});

test("a read at a home-directory root creates nothing", async () => {
  const r = root();
  const prev = process.env.HOME;
  process.env.HOME = r;
  try {
    const c = new LiteCtx({ root: r });
    assert.deepEqual(await c.recall("anything", { kind: "code" }), []);
    c.close();
  } finally {
    process.env.HOME = prev;
  }
  assert.equal(existsSync(folder(r)), false);
});

test("an explicit dbPath and :memory: still work; the dbPath folder appears only on the first write", async () => {
  const r = root(true);
  const dbPath = join(r, "deep", "x", "idx.db");
  const c = new LiteCtx({ root: r, dbPath });
  await c.recall("alpha");
  assert.equal(existsSync(join(r, "deep")), false);
  await c.index();
  assert.equal(existsSync(dbPath), true);
  c.close();
  const m = new LiteCtx({ root: r, dbPath: ":memory:" });
  assert.equal(await m.index().then((x) => x.files), 1);
  assert.equal((await m.recall("alpha", { kind: "code" })).length, 1);
  m.close();
});

test("a connection opened before the file exists sees the writer's data once it is created", async () => {
  const r = root(true);
  const reader = new LiteCtx({ root: r });
  const writer = new LiteCtx({ root: r });
  assert.deepEqual(await reader.recall("alpha", { kind: "code" }), []);
  await writer.index();
  assert.equal((await reader.recall("alpha", { kind: "code" })).length, 1, "the reader adopted the new file");
  assert.equal(reader.size(), 1);
  reader.close();
  writer.close();
});

test("a failed file creation (read-only folder) keeps the store lazy: every write throws, nothing reports stored", { skip: process.getuid?.() === 0 }, async () => {
  const r = root();
  chmodSync(r, 0o555);
  try {
    const ctx = new LiteCtx({ root: r });
    await assert.rejects(() => ctx.remember("a0", "alpha fact", { kind: "fact" }), { code: "EACCES" });
    await assert.rejects(() => ctx.remember("a1", "beta fact", { kind: "fact" }), { code: "EACCES" }, "the retry throws again, not a silent in-memory success");
    assert.equal(ctx.size(), 0, "nothing was stored");
    assert.equal(existsSync(folder(r)), false);
    ctx.close();
  } finally {
    chmodSync(r, 0o755);
  }
});
