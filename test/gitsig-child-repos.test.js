// childRepos: `git log` (the slow part of an index pass on a big folder) runs only for the repos that have a file
// to write; an untouched repo keeps its stored git_sig rows. A `git` shim on PATH records each invocation.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "litectx-gitsig-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function mkRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  return g;
}

test("git log runs only for repos with upserts; other repos' git_sig rows are untouched; changed repo's rows are correct", async () => {
  const root = join(tmp, "root");
  const gA = mkRepo(join(root, "alpha"), { "a.js": "export const a = 1;\n" });
  mkRepo(join(root, "beta"), { "b.js": "export const b = 1;\n" });
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(tmp, "bin");
  const log = join(tmp, "git.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> '${log}'\nexec '${realGit}' "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const ctx = new LiteCtx({ root, childRepos: true, dbPath: ":memory:" });
    await ctx.index();
    const rows = () => ctx.store.db.prepare("SELECT path, commits, last_commit FROM git_sig ORDER BY path").all();
    const before = rows();
    assert.deepEqual(before.map((r) => r.path), ["alpha/a.js", "beta/b.js"]);

    writeFileSync(join(root, "alpha", "a.js"), "export const a = 2;\n");
    gA("commit", "-qam", "second");
    writeFileSync(log, "");
    await ctx.index();

    const logs = readFileSync(log, "utf8").split("\n").filter((l) => /\blog\b/.test(l));
    assert.ok(logs.length > 0, "git log ran for the changed repo");
    assert.ok(logs.every((l) => l.includes(join(root, "alpha"))), `only alpha was read, got: ${logs.join(" | ")}`);
    const after = rows();
    assert.deepEqual(after.find((r) => r.path === "beta/b.js"), before.find((r) => r.path === "beta/b.js"), "beta's row kept");
    assert.equal(after.find((r) => r.path === "alpha/a.js")?.commits, 2, "alpha's row reflects the new commit");
    ctx.close();
  } finally {
    process.env.PATH = oldPath;
  }
});
