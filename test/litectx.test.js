// Slice 0 integration tests — exercise the real pipeline (index -> SQLite/FTS5 -> recall)
// against a temp repo with an in-memory DB. Behavior, not implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import { splitIdent, keywords } from "../src/index.js";

/** Build a throwaway repo on disk; returns its root. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.js"), "function validateToken(t){ return verifySignature(t); }\n");
  writeFileSync(join(root, "src", "mailer.js"), "function sendEmail(to, body){ return smtp.send(to, body); }\n");
  writeFileSync(join(root, "README.md"), "# Demo\nThis project sends email notifications.\n");
  return root;
}

test("indexes files and reports a count", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  const { files } = await ctx.index();
  assert.equal(files, 3);
  assert.equal(ctx.size(), 3);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("recall ranks the relevant file first", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const hits = (await ctx.recall("how do we validate the auth token", { kind: "code", n: 5 }));
  assert.ok(hits.length > 0, "expected at least one hit");
  assert.equal(hits[0].path, "src/auth.js");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("recall matches on intent via the doc body, not just filename", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  // grouped default (no kind) → one ranked list per kind; flatten to check the intent matched.
  const grouped = (await ctx.recall("sending email notifications"));
  const paths = [...grouped.code, ...grouped.doc].map((h) => h.path);
  assert.ok(paths.includes("src/mailer.js") || paths.includes("README.md"), `got ${paths.join(",")}`);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a query with no usable terms returns empty groups", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  // no kind → grouped over all KINDS; no usable terms → every group empty (never a crash).
  // KINDS spans code/doc (indexed) + fact/episode (write-path, slice 7) — empty groups are honest.
  assert.deepEqual((await ctx.recall("a of to")), { code: [], doc: [], fact: [], episode: [] });
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("include filter excludes other extensions", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, include: [".md"], dbPath: ":memory:" });
  assert.equal((await ctx.index()).files, 1);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("tokenizer splits camelCase and snake_case", () => {
  assert.deepEqual(splitIdent("getUserData"), ["get", "user", "data"]);
  assert.deepEqual(splitIdent("base_level.py"), ["base", "level", "py"]);
  assert.deepEqual(keywords("How does the validateToken function work?"), ["validate", "token", "function", "work"]);
});

// --- chunk-granular recall (function pointer > file pointer; ranking untouched) ---

test("chunk-granular recall: a code hit points at the matching function, not just the file", async () => {
  const root = fixtureRepo();
  writeFileSync(
    join(root, "src", "billing.js"),
    "function createInvoice(order){ return order.total; }\n\nfunction refundPayment(tx){ return gateway.refund(tx); }\n"
  );
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const hits = await ctx.recall("refund a payment", { kind: "code", n: 5 });
  assert.equal(hits[0].path, "src/billing.js");
  assert.ok(hits[0].chunk, "expected a chunk pointer on the hit");
  assert.equal(hits[0].chunk.symbol, "refundPayment");
  assert.equal(hits[0].chunk.startLine, 2); // the SECOND function, not the file head
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("chunk-granular recall: a doc hit points at the matching heading section", async () => {
  const root = fixtureRepo();
  writeFileSync(
    join(root, "GUIDE.md"),
    "# Guide\n\n## Setup\nInstall with npm.\n\n## Notifications\nWe send email notifications on failure.\n"
  );
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const hits = await ctx.recall("email notifications", { kind: "doc", n: 5 });
  const guide = hits.find((h) => h.path === "GUIDE.md");
  assert.ok(guide && guide.chunk, "expected GUIDE.md with a chunk pointer");
  assert.equal(guide.chunk.symbol, "Notifications");
  assert.equal(guide.chunk.nodeType, "section");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("chunk-granular recall: a match carried only by the filename localizes no chunk (null, honest)", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  // "mailer" appears only in src/mailer.js's PATH tokens — no chunk body contains it.
  const hits = await ctx.recall("mailer", { kind: "code", n: 5 });
  assert.equal(hits[0].path, "src/mailer.js");
  assert.equal(hits[0].chunk, null);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("chunk-granular recall: a class never beats its own method by aggregation (container trap)", async () => {
  const root = fixtureRepo();
  writeFileSync(
    join(root, "src", "billing.js"),
    "class Billing {\n  createInvoice(order){ return order.total; }\n  refundPayment(tx){ return gateway.refund(tx); }\n}\n"
  );
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const hits = await ctx.recall("refund a payment", { kind: "code", n: 5 });
  assert.equal(hits[0].path, "src/billing.js");
  // the Billing class chunk contains every term refundPayment has — it must NOT win by superset
  assert.equal(hits[0].chunk.symbol, "refundPayment");
  assert.equal(hits[0].chunk.nodeType, "method_definition");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a pre-0.2 db (docs without `source`) self-heals on open instead of crashing index()", async () => {
  const root = fixtureRepo();
  const dbPath = join(root, "stale.db");
  // fabricate the v0.1.0 schema: docs FTS without source/provenance/occurred_at, log without symbol
  const { default: Database } = await import("better-sqlite3");
  const old = new Database(dbPath);
  old.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, kind UNINDEXED, format UNINDEXED, body)");
  old.exec("CREATE TABLE file_index(path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, indexed_at INTEGER NOT NULL)");
  old.exec("CREATE TABLE recall_log(id INTEGER PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL)");
  old.prepare("INSERT INTO docs(path, kind, format, body) VALUES ('x.js','code','js','stale row')").run();
  old.close();
  // reopening through LiteCtx must rebuild (old docs can only hold re-indexable files), then work
  const ctx = new LiteCtx({ root, dbPath });
  const r = await ctx.index();
  assert.equal(r.files, 3); // the stale row is gone; the real repo is indexed
  const hits = await ctx.recall("validate the auth token", { kind: "code" });
  assert.equal(hits[0].path, "src/auth.js");
  assert.equal(hits[0].chunk?.symbol, "validateToken"); // post-heal schema is current (symbol logging works)
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
