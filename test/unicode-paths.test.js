// Regression: a git-tracked file with a non-ASCII name was never indexed. `git ls-files` C-quotes such
// names ("Cr\303\250me.md") unless run with -z, and the quoted string matched no file on disk. Found
// 2026-10-23 when the all-repos index missed 5 tracked recipe notes ("Crème brûlée …md", "Za’atar …md").

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const NAME = "Sweets/Crème brûlée Za’atar.md";

function repo(dir) {
  mkdirSync(join(dir, "Sweets"), { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.dev");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, NAME), "# Dessert\n\ncaramelised sugar crust\n");
  g("add", "-A");
  g("commit", "-qm", "init");
}

test("a tracked non-ASCII filename is indexed with git metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-unicode-"));
  try {
    repo(root);
    const ctx = new LiteCtx({ root, dbPath: ":memory:" });
    assert.equal((await ctx.index()).added, 1);
    const [hit] = await ctx.recall("caramelised", { kind: "doc", n: 1 });
    assert.equal(hit?.path, NAME);
    assert.equal(hit.git?.commits, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same in all-repos mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-unicode-children-"));
  try {
    repo(join(root, "notes"));
    const ctx = new LiteCtx({ root, dbPath: ":memory:", childRepos: true });
    assert.equal((await ctx.index()).added, 1);
    const [hit] = await ctx.recall("caramelised", { kind: "doc", n: 1 });
    assert.equal(hit?.path, `notes/${NAME}`);
    assert.equal(hit.git?.commits, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
