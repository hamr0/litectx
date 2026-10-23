// childRepos: a root that is a FOLDER of git repos (docs/wiki/local-ui.md, all-repos mode). Pins that
// only each child repo's TRACKED files are indexed, prefixed `<repo>/`; that untracked data, loose root
// files, non-repo dirs and repos deeper than one level stay out; that git metadata and pathspec scoping
// follow the prefix; and that the default (childRepos unset) keeps the legacy walk byte-identical.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import { childRepos, repoPathspecs } from "../src/indexer.js";

function repo(dir, files) {
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.dev");
  g("config", "user.name", "Test");
  g("config", "commit.gpgsign", "false");
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  g("add", "-A");
  g("commit", "-qm", "init");
}

function tree() {
  const root = mkdtempSync(join(tmpdir(), "litectx-children-"));
  repo(join(root, "alpha"), { "README.md": "# Alpha\n\nzebrafish notes\n", "src/a.js": "export function zebra(){ return 1; }\n" });
  repo(join(root, "beta"), { "docs/guide.md": "# Guide\n\nzebrafish guide\n", "b.py": "def zebra():\n    return 2\n" });
  writeFileSync(join(root, "alpha", "untracked.md"), "# Untracked\n\nzebrafish secret\n"); // not committed
  writeFileSync(join(root, "loose.md"), "# Loose\n\nzebrafish loose\n"); // at the root, in no repo
  mkdirSync(join(root, "plain"));
  writeFileSync(join(root, "plain", "x.md"), "# Plain\n\nzebrafish plain\n"); // a dir with no .git
  repo(join(root, "group", "deep"), { "deep.md": "# Deep\n\nzebrafish deep\n" }); // two levels down
  return root;
}

test("indexes only tracked files of repos one level down, prefixed by repo", async () => {
  const root = tree();
  try {
    const ctx = new LiteCtx({ root, dbPath: ":memory:", childRepos: true });
    const r = await ctx.index();
    assert.equal(r.added, 4);
    const doc = await ctx.recall("zebrafish", { kind: "doc", n: 20 });
    assert.deepEqual(doc.map((h) => h.path).sort(), ["alpha/README.md", "beta/docs/guide.md"]);
    const code = await ctx.recall("zebra", { kind: "code", n: 20 });
    assert.deepEqual(code.map((h) => h.path).sort(), ["alpha/src/a.js", "beta/b.py"]);
    assert.equal(ctx.get("alpha/src/a.js")?.text, "export function zebra(){ return 1; }\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git metadata follows the repo prefix", async () => {
  const root = tree();
  try {
    const ctx = new LiteCtx({ root, dbPath: ":memory:", childRepos: true });
    await ctx.index();
    const [hit] = await ctx.recall("zebrafish guide", { kind: "doc", n: 1 });
    assert.equal(hit.path, "beta/docs/guide.md");
    assert.equal(hit.git?.commits, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second pass is incremental", async () => {
  const root = tree();
  try {
    const ctx = new LiteCtx({ root, dbPath: ":memory:", childRepos: true });
    await ctx.index();
    const r = await ctx.index();
    assert.deepEqual([r.added, r.updated, r.removed, r.unchanged], [0, 0, 0, 4]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repo-named pathspec scopes to that repo; a plain one applies to every repo", async () => {
  const root = tree();
  try {
    const one = new LiteCtx({ root, dbPath: ":memory:", childRepos: true, pathspecs: ["alpha/src"] });
    await one.index();
    assert.deepEqual((await one.recall("zebra", { kind: "code", n: 20 })).map((h) => h.path), ["alpha/src/a.js"]);
    assert.deepEqual(await one.recall("zebrafish", { kind: "doc", n: 20 }), []);

    const md = new LiteCtx({ root, dbPath: ":memory:", childRepos: true, pathspecs: ["*.md"] });
    await md.index();
    assert.deepEqual((await md.recall("zebrafish", { kind: "doc", n: 20 })).map((h) => h.path).sort(), ["alpha/README.md", "beta/docs/guide.md"]);
    assert.deepEqual(await md.recall("zebra", { kind: "code", n: 20 }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default (childRepos unset) keeps the legacy walk", async () => {
  const root = tree();
  try {
    const ctx = new LiteCtx({ root, dbPath: ":memory:" });
    await ctx.index();
    const paths = (await ctx.recall("zebrafish", { kind: "doc", n: 20 })).map((h) => h.path);
    assert.ok(paths.includes("loose.md") && paths.includes("alpha/untracked.md"), "walk sees untracked + loose files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("childRepos + repoPathspecs units", () => {
  const root = tree();
  try {
    assert.deepEqual(childRepos(root), ["alpha", "beta"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const names = new Set(["alpha", "beta"]);
  assert.equal(repoPathspecs("alpha", undefined, names), undefined);
  assert.equal(repoPathspecs("alpha", ["alpha"], names), undefined);
  assert.deepEqual(repoPathspecs("alpha", ["alpha/src", "beta/x"], names), ["src"]);
  assert.equal(repoPathspecs("beta", ["alpha/src"], names), null);
  assert.deepEqual(repoPathspecs("beta", ["*.md", "docs/a.md"], names), ["*.md", "docs/a.md"]);
});
