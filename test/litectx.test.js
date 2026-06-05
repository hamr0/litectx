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
  const hits = ctx.recall("how do we validate the auth token", { kind: "code", n: 5 });
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
  const grouped = ctx.recall("sending email notifications");
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
  assert.deepEqual(ctx.recall("a of to"), { code: [], doc: [] });
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
