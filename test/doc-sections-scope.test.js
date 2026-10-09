// The multis scope fence on indexed-md SECTION rows. Repo md is global (no doc_scope row) and now spans
// several `docs` rows per file; tenant uploads are `direct` doc rows fenced by `doc_scope`. The claims,
// each written to FAIL if the fence leaks: (1) a tenant's upload never reaches another tenant — with an
// embeddings stub that gives every row the SAME vector and the same text, so only the fence differs;
// (2) repo sections stay visible to every tenant and GLOBAL under strictScope; (3) get(id) fences uploads,
// get(path, chunk) of a repo section works for any scope; (4) forget/purge never touch file sections,
// doc_sections or nodes; (5) strictScope throws without a scope; (6) re-ingest replaces only its own rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, GLOBAL } from "../src/index.js";

// every text → the same vector, so cosine can never separate rows: scope is the only differentiator
const flatStub = { async embed() { return Float32Array.from([1, 0]); } };

const SHARED = "quarterly revenue widgets report";
const enc = (s) => new TextEncoder().encode(s);

async function setup(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "litectx-docsec-scope-"));
  writeFileSync(join(root, "handbook.md"), `# Handbook\n\nintro\n\n## Finance\n${SHARED} for the whole company\n\n## Travel\ntravel policy and ${SHARED}\n`);
  const ctx = new LiteCtx({ root, dbPath: join(root, "s.db"), strictScope: true, embeddings: true, embedder: flatStub, ...extra });
  await ctx.index();
  await ctx.scoped("A").ingest(enc(`# Plan A\n\nsecret ${SHARED} for tenant A`), { filename: "plan-a.md" });
  await ctx.scoped("B").ingest(enc(`# Plan B\n\nprivate ${SHARED} for tenant B`), { filename: "plan-b.md" });
  return { root, ctx };
}
const done = ({ root, ctx }) => (ctx.close(), rmSync(root, { recursive: true, force: true }));
const ids = (hits) => hits.map((h) => h.path);
const isUpload = (p) => p.startsWith("doc:");
const n = (ctx, sql) => ctx.store.db.prepare(sql).get().n;

test("fence: tenant A's upload never appears in B's recall (embeddings on, identical vectors and text)", async () => {
  const s = await setup();
  const a = ids(await s.ctx.scoped("A").recall(SHARED, { kind: "doc", n: 20 }));
  const b = ids(await s.ctx.scoped("B").recall(SHARED, { kind: "doc", n: 20 }));
  const g = ids(await s.ctx.scoped(GLOBAL).recall(SHARED, { kind: "doc", n: 20 }));
  assert.ok(a.includes("doc:plan-a#0"), "A sees its own upload");
  assert.ok(!a.includes("doc:plan-b#0"), "A never sees B's");
  assert.ok(b.includes("doc:plan-b#0") && !b.includes("doc:plan-a#0"), "B sees only its own");
  assert.deepEqual(g.filter(isUpload), [], "GLOBAL sees no tenant upload");
  done(s);
});

test("repo md sections are visible to A, B and GLOBAL under strictScope while same-terms tenant uploads stay fenced", async () => {
  const s = await setup();
  for (const scope of ["A", "B", GLOBAL]) {
    const hits = await s.ctx.scoped(scope).recall(SHARED, { kind: "doc", n: 20 });
    const sections = hits.filter((h) => h.path === "handbook.md");
    assert.equal(sections.length, 2, `${String(scope)}: both matching repo sections are visible`);
    assert.deepEqual(sections.map((h) => h.chunk.symbol).sort(), ["Finance", "Travel"]);
    const other = { A: "doc:plan-b#0", B: "doc:plan-a#0" }[String(scope)];
    if (other) assert.ok(!ids(hits).includes(other), "…while the other tenant's same-terms upload stays fenced");
    if (scope === GLOBAL) assert.deepEqual(ids(hits).filter(isUpload), [], "GLOBAL sees no tenant upload");
  }
  done(s);
});

test("get(id): another tenant's upload is null (whole and ranged); a repo section's get(path,range) works for any scope", async () => {
  const s = await setup();
  const { ctx } = s;
  assert.ok(ctx.get("doc:plan-a#0", { scope: "A" }), "A reads its own");
  assert.equal(ctx.get("doc:plan-a#0", { scope: "B" }), null, "B cannot read A's upload by id");
  assert.equal(ctx.get("doc:plan-a#0", { scope: GLOBAL }), null);
  assert.equal(ctx.get("doc:plan-a#0", { scope: "B", startLine: 0, endLine: 0 }), null, "ranged read of an upload is null (stored whole)");
  const [h] = (await ctx.scoped("A").recall("travel policy", { kind: "doc" })).filter((x) => x.path === "handbook.md");
  for (const scope of ["A", "B", GLOBAL]) {
    const got = ctx.get("handbook.md", { scope, startLine: h.chunk.startLine, endLine: h.chunk.endLine });
    assert.match(got.text, /travel policy/, `${String(scope)} fetches the repo section`);
  }
  done(s);
});

test("forget({kind:'doc'}), forget({id}) and purge() leave file sections, doc_sections and nodes untouched", async () => {
  const s = await setup();
  const { ctx } = s;
  await ctx.scoped("A").ingest(enc(`# Old\n\nexpiring ${SHARED}`), { filename: "old.md", expiresAt: Date.now() - 1000 });
  const snap = () => [
    n(ctx, "SELECT count(*) AS n FROM doc_fts WHERE source='file'"),
    n(ctx, "SELECT count(*) AS n FROM doc_sections"),
    n(ctx, "SELECT count(*) AS n FROM nodes"),
    n(ctx, "SELECT count(*) AS n FROM file_embeddings") + n(ctx, "SELECT count(*) AS n FROM doc_sections WHERE vec IS NOT NULL"),
  ];
  const before = snap();
  assert.ok(before[1] >= 3, "precondition: handbook has section rows");
  assert.equal(ctx.purge(), 1, "purge reclaims the expired upload");
  assert.deepEqual(snap(), before, "purge left the file side alone");
  // forget needs a non-strict handle (strictScope makes the bare owner-blind selector throw) on the same db
  const open = new LiteCtx({ root: s.root, dbPath: join(s.root, "s.db") });
  assert.equal(open.forget("doc:plan-a#0"), 1);
  assert.deepEqual(snap(), before, "forget(id) left the file side alone");
  assert.ok(open.forget({ kind: "doc" }) >= 1, "forget({kind:'doc'}) deletes the remaining uploads");
  assert.deepEqual(snap(), before, "forget({kind:'doc'}) left file sections, doc_sections, nodes and vectors intact");
  assert.equal(n(ctx, "SELECT count(*) AS n FROM doc_fts WHERE source='direct'"), 0);
  assert.ok((await ctx.scoped(GLOBAL).recall("travel policy", { kind: "doc" })).length > 0, "repo sections still recall");
  open.close();
  done(s);
});

test("strictScope throws without a scope on doc recall, get(id) and ingest", async () => {
  const s = await setup();
  await assert.rejects(s.ctx.recall(SHARED, { kind: "doc" }), /strictScope/);
  assert.throws(() => s.ctx.get("handbook.md"), /strictScope/);
  await assert.rejects(s.ctx.ingest(enc("# x\n\ny"), { filename: "x.md" }), /strictScope/);
  done(s);
});

test("re-ingest under one tenant replaces only that upload's rows; repo sections and the other tenant are untouched", async () => {
  const s = await setup();
  const { ctx } = s;
  const fileRows = n(ctx, "SELECT count(*) AS n FROM doc_fts WHERE source='file'");
  const secRows = n(ctx, "SELECT count(*) AS n FROM doc_sections");
  await ctx.scoped("A").ingest(enc(`# Plan A v2\n\nrevised ${SHARED} gamma for tenant A`), { filename: "plan-a.md" });
  const a = await ctx.scoped("A").recall("gamma", { kind: "doc" });
  assert.equal(a.length, 1);
  assert.match(ctx.get(a[0].path, { scope: "A" }).text, /revised/);
  assert.equal((await ctx.scoped("A").recall("secret", { kind: "doc" })).length, 0, "the old A text is gone");
  assert.ok(ids(await ctx.scoped("B").recall("private", { kind: "doc" })).includes("doc:plan-b#0"), "B's upload untouched");
  assert.equal(n(ctx, "SELECT count(*) AS n FROM doc_fts WHERE source='file'"), fileRows);
  assert.equal(n(ctx, "SELECT count(*) AS n FROM doc_sections"), secRows);
  done(s);
});
