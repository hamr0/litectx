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

// git log quotes `"`, `\`, tab and newline even with core.quotepath=off; the metadata pass reads `-z` so
// the key is the raw path and `hit.git` is present. (Newline case: Linux filesystems allow it.)
const AWKWARD = ['we"ird é.md', "back\\slash.md", "tab\tname.md", "new\nline.md"];

test("git metadata survives names with quote, backslash, tab and newline", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-awkward-"));
  try {
    const g = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "pipe" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t.dev");
    g("config", "user.name", "Test");
    g("config", "commit.gpgsign", "false");
    AWKWARD.forEach((n, i) => writeFileSync(join(root, n), `# T${i}\n\nuniqueword${i} body\n`));
    g("add", "-A");
    g("commit", "-qm", "one");
    writeFileSync(join(root, AWKWARD[0]), "# T0\n\nuniqueword0 body edited\n");
    g("commit", "-qam", "two");
    const ctx = new LiteCtx({ root, dbPath: ":memory:" });
    assert.equal((await ctx.index()).added, AWKWARD.length);
    for (const [i, n] of AWKWARD.entries()) {
      const [hit] = await ctx.recall(`uniqueword${i}`, { kind: "doc", n: 1 });
      assert.equal(hit?.path, n);
      assert.equal(hit.git?.commits, i === 0 ? 2 : 1, `git metadata for ${JSON.stringify(n)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
