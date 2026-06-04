// Slice 1 integration tests — incremental, git-aware re-indexing (§6) and the first-class
// kind/format columns (§3.1). Real pipeline against a temp repo + in-memory DB; one LiteCtx
// instance is reused across index() calls so the file_index persists between passes.
// Behavior, not implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

// Deterministic, monotonically-advancing mtime so change detection never depends on
// filesystem timestamp resolution or wall-clock. Detection is equality-based, so any
// distinct value forces a re-read.
let clock = 1_700_000_000;
/** @param {string} p */
function bump(p) {
  clock += 10;
  utimesSync(p, clock, clock);
}

/** @param {string} root @param {string} rel @param {string} body */
function write(root, rel, body) {
  const full = join(root, rel);
  writeFileSync(full, body);
  bump(full);
}

/** Build a throwaway repo on disk; returns its root. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-inc-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // plain-word bodies: FTS body tokens aren't identifier-split until slice 3, so queries
  // here match whole words (or path tokens), which is what slice-1 recall actually supports.
  write(root, "src/auth.js", "validate the auth token by signature check\n");
  write(root, "src/mailer.py", "send email notifications to the user via smtp\n");
  write(root, "README.md", "# Demo\nThis project sends email notifications.\n");
  return root;
}

test("first index reports everything as added", () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  const r = ctx.index();
  assert.deepEqual(
    { files: r.files, added: r.added, updated: r.updated, removed: r.removed, unchanged: r.unchanged },
    { files: 3, added: 3, updated: 0, removed: 0, unchanged: 0 }
  );
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("re-index with no changes touches nothing", () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  ctx.index();
  const r = ctx.index();
  assert.equal(r.added, 0);
  assert.equal(r.updated, 0);
  assert.equal(r.removed, 0);
  assert.equal(r.unchanged, 3);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a changed file is the only one re-indexed, and recall reflects the new content", () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  ctx.index();
  write(root, "src/auth.js", "rotate credentials and refresh the session here\n");
  const r = ctx.index();
  assert.equal(r.updated, 1);
  assert.equal(r.added, 0);
  assert.equal(r.unchanged, 2);
  const hits = ctx.recall("rotate credentials refresh session", { limit: 5 });
  assert.equal(hits[0].path, "src/auth.js");
  // the old body is gone: a query for words only in the old content no longer matches auth.js
  assert.ok(ctx.recall("signature check", { limit: 5 }).every((h) => h.path !== "src/auth.js"));
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("identical content with a newer mtime is not re-indexed (content-hash backstop)", () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  ctx.index();
  bump(join(root, "src/auth.js")); // advance mtime only; bytes unchanged
  const r = ctx.index();
  assert.equal(r.updated, 0);
  assert.equal(r.unchanged, 3);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a same-mtime edit that changes length is still caught (size guard)", () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  const authPath = join(root, "src/auth.js");
  const { atime, mtime } = statSync(authPath); // the exact times the first index will record
  ctx.index();
  // edit the content to a different length, then force the mtime back to its original value:
  // mtime now matches the stored value, so only the size guard can catch the change.
  writeFileSync(authPath, "tiny\n");
  utimesSync(authPath, atime, mtime);
  const r = ctx.index();
  assert.equal(r.updated, 1);
  assert.equal(r.unchanged, 2);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a removed file is dropped from the index and from recall", () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  ctx.index();
  rmSync(join(root, "src/mailer.py"));
  const r = ctx.index();
  assert.equal(r.removed, 1);
  assert.equal(r.files, 2);
  assert.ok(ctx.recall("send email", { limit: 5 }).every((h) => h.path !== "src/mailer.py"));
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("force rebuilds from scratch", () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  ctx.index();
  const r = ctx.index({ force: true });
  assert.equal(r.added, 3);
  assert.equal(r.unchanged, 0);
  assert.equal(r.files, 3);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("hits carry first-class kind and format from the extension", () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  ctx.index();
  const code = ctx.recall("auth token validate", { limit: 5 }).find((h) => h.path === "src/auth.js");
  assert.ok(code);
  assert.equal(code.kind, "code");
  assert.equal(code.format, "js");
  const doc = ctx.recall("demo notifications email", { limit: 5 }).find((h) => h.path === "README.md");
  assert.ok(doc);
  assert.equal(doc.kind, "doc");
  assert.equal(doc.format, "md");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
