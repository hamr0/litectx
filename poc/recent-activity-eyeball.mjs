// Eyeball (throwaway, slice 5a): run recentActivity() through the REAL pipeline on a real repo, to
// confirm finding #2's fix — litectx's tree-sitter chunks give clean symbol-grain rows, unlike the
// original git-funcContext POC (class-level for code, random prose for md). Non-mutating: it
// materializes two committed snapshots (oldRef, newRef) into a temp dir and lets index() observe the
// span as one edit pass, then prints what recentActivity() returns.
//
// Usage: node poc/recent-activity-eyeball.mjs [repoPath] [oldRef] [newRef]
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { LiteCtx } from "../src/index.js";

const repo = process.argv[2] ?? "/home/hamr/PycharmProjects/litectx";
const oldRef = process.argv[3] ?? "HEAD~6";
const newRef = process.argv[4] ?? "HEAD";
const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 29 });
const EXT = /\.(ts|js|mjs|cjs|py|md)$/;

/** files of interest present at a ref */
const filesAt = (ref) => git(["ls-tree", "-r", "--name-only", ref]).split("\n").filter((f) => EXT.test(f));
/** materialize a ref's tracked files into dir (only the given list) */
function snapshot(dir, ref, files) {
  for (const f of files) {
    const full = join(dir, f);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, git(["show", `${ref}:${f}`]));
  }
}

const tmp = mkdtempSync(join(tmpdir(), "litectx-eyeball-"));
const ctx = new LiteCtx({ root: tmp, dbPath: ":memory:" });

const oldFiles = filesAt(oldRef);
snapshot(tmp, oldRef, oldFiles);
await ctx.index(); // cold baseline — records nothing

// overwrite with the new snapshot; drop files that disappeared so index() sees deletions too
const newFiles = filesAt(newRef);
for (const f of oldFiles) if (!newFiles.includes(f)) rmSync(join(tmp, f), { force: true });
snapshot(tmp, newRef, newFiles);
const r = await ctx.index(); // observes oldRef→newRef as one edit pass

const rows = ctx.recentActivity({ since: 0, limit: 20 });
console.log(`\n${repo.split("/").pop()}  ${oldRef}→${newRef}  (~${r.updated + r.added} files changed)`);
console.log("recentActivity(limit=20):");
console.log(`${"edits".padEnd(7)}${"kind".padEnd(6)}path  ›  symbol`);
console.log("-".repeat(74));
for (const x of rows) {
  const s = (x.symbol ?? "(file-level)").slice(0, 44);
  console.log(`${String(x.edits).padEnd(7)}${x.kind.padEnd(6)}${x.id}  ›  ${s}`);
}
console.log(`\n(${rows.length} chunks shown; clean tree-sitter symbols, not git's funcContext)`);
ctx.close();
rmSync(tmp, { recursive: true, force: true });
