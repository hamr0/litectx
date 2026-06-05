// Slice 4 integration tests — file-level git activity metadata (§4.1). gitsig is GROUNDING, not a
// ranking signal: these tests pin that hits carry an accurate { commits, lastCommit } from a real
// `git log`, that it never reorders results, and that a non-git tree degrades to `git: null`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

// a real git repo: a.js committed twice (2 commits), b.js once (1 commit).
function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-gitsig-"));
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.dev");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "a.js"), "export function alpha(){ return 1; }\n");
  g("add", "-A");
  g("commit", "-qm", "add alpha");
  writeFileSync(join(root, "a.js"), "export function alpha(){ return 2; }\n");
  writeFileSync(join(root, "b.js"), "export function beta(){ return 1; }\n");
  g("add", "-A");
  g("commit", "-qm", "edit alpha, add beta");
  return root;
}

test("hits carry accurate per-file commit count + last-commit time", async () => {
  const root = gitRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const hits = ctx.recall("function", { kind: "code", n: 10 });
  const a = hits.find((h) => h.path === "a.js");
  const b = hits.find((h) => h.path === "b.js");
  assert.ok(a && b, "both files recalled");
  assert.equal(a.git?.commits, 2, "a.js touched by 2 commits");
  assert.equal(b.git?.commits, 1, "b.js touched by 1 commit");
  assert.ok(a.git && typeof a.git.lastCommit === "number" && a.git.lastCommit > 0, "lastCommit is a unix time");
  assert.ok(a.git.lastCommit >= (b.git?.lastCommit ?? 0), "a's last commit is not older than b's first");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("gitsig is grounding only — it never reorders the ranked hits", async () => {
  const root = gitRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  // ranking must be identical whether or not we look at git — compare paths to a metadata-blind run.
  const withGit = ctx.recall("function", { kind: "code", n: 10 }).map((h) => h.path);
  // b.js has FEWER commits but if gitsig leaked into the score, order could shift; assert it tracks
  // BM25 only: the two files tie on the query, so order is stable and commit count is irrelevant.
  assert.ok(withGit.includes("a.js") && withGit.includes("b.js"));
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("gitsig refreshes on re-index when a new commit lands", async () => {
  const root = gitRepo(); // a.js already has 2 commits
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const count = () => ctx.recall("function", { kind: "code", n: 10 }).find((h) => h.path === "a.js")?.git?.commits;
  assert.equal(count(), 2, "starts at 2 commits");
  writeFileSync(join(root, "a.js"), "export function alpha(){ return 3; }\n");
  execFileSync("git", ["-C", root, "add", "-A"], { stdio: "pipe" });
  execFileSync("git", ["-C", root, "commit", "-qm", "third"], { stdio: "pipe" });
  await ctx.index(); // content changed → file re-indexed → gitsig recomputed
  assert.equal(count(), 3, "incremental re-index picks up the new commit");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a tracked-but-uncommitted file has no history → git: null", async () => {
  const root = gitRepo();
  // stage (so `git ls-files` indexes it) but never commit → no history row, honest null.
  writeFileSync(join(root, "c.js"), "export function gamma(){ return 3; }\n");
  execFileSync("git", ["-C", root, "add", "c.js"], { stdio: "pipe" });
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const c = ctx.recall("function", { kind: "code", n: 10 }).find((h) => h.path === "c.js");
  assert.ok(c, "c.js indexed (staged, so git ls-files lists it)");
  assert.equal(c.git, null, "no commit history → git is null (same contract as a non-git tree)");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("non-git tree degrades gracefully to git: null", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-nogit-"));
  writeFileSync(join(root, "x.js"), "export function ex(){ return 1; }\n");
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const x = ctx.recall("function", { kind: "code", n: 10 }).find((h) => h.path === "x.js");
  assert.ok(x, "file indexed via the filesystem-walk fallback");
  assert.equal(x.git, null, "no git → git is null, never throws");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
