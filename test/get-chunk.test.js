// get(path, {startLine, endLine}) — fetch ONE chunk instead of the whole file, and the index-format
// stamp that keeps an index honest across a litectx upgrade.
//
// The load-bearing invariant here is a SAFETY one, and it is the whole reason this code exists: a
// pointer's line numbers only mean anything against the file the index actually saw. If the file moved
// on, slicing by them hands back a DIFFERENT symbol's body — silently, no error. So the fetch is gated
// on the file's content hash and refuses when it drifted. These tests are written to fail if that gate
// is ever removed: several assert on WRONGNESS being prevented, not on happy-path shape.
//
// Symbol names are deliberately not the anchor. They are duplicated (`recall` exists on both LiteCtx
// and ScopedView), renamed by the very edits we're guarding against, and absent on ~40% of chunks.
// The tests below cover each of those cases through the hash path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, StalePointerError } from "../src/index.js";
import { chunkFile } from "../src/chunker.js";
import { indexStamp } from "../src/indexer.js";

// A file with the three shapes that break naive resolution: a documented symbol, a DUPLICATE symbol
// name (two classes each defining `handle`), and anonymous chunks (arrow callbacks).
const SRC = `import { run } from "./run.js";

/**
 * Alpha's contract lives here, above the code.
 * @param {string} t
 */
export function validateToken(t) {
  return verifySignature(t);
}

export class Reader {
  handle(x) {
    return [x].map((v) => v + 1);
  }
}

export class Writer {
  handle(x) {
    return [x].filter((v) => v > 0);
  }
}
`;

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-getchunk-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.js"), SRC);
  return root;
}

/** The chunk list straight from the chunker — an oracle independent of the index under test. */
const chunksOf = (root) => chunkFile("src/a.js", readFileSync(join(root, "src", "a.js"), "utf8"));

test("get(path,{startLine,endLine}) returns that chunk alone — not the whole file", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();

  const target = (await chunksOf(root)).find((c) => c.symbol === "validateToken");
  assert.ok(target);
  const item = ctx.get("src/a.js", { startLine: target.startLine, endLine: target.endLine });
  assert.ok(item);
  assert.equal(item.text, target.text, "byte-identical to the chunk the chunker draws");
  assert.ok(item.text != null && item.text.length < SRC.length, "strictly smaller than the whole file");
  assert.ok(item.text?.startsWith("/**"), "and it carries the docstring — the chunk starts at the doc, not the code");

  const whole = ctx.get("src/a.js");
  assert.equal(whole?.text, SRC, "the no-range call is unchanged: still the whole file");
});

test("a DUPLICATE symbol name resolves correctly — lines disambiguate where a name cannot", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();

  const dupes = (await chunksOf(root)).filter((c) => c.symbol === "handle");
  assert.equal(dupes.length, 2, "fixture really does define `handle` twice");

  const first = ctx.get("src/a.js", { startLine: dupes[0].startLine, endLine: dupes[0].endLine });
  const second = ctx.get("src/a.js", { startLine: dupes[1].startLine, endLine: dupes[1].endLine });
  assert.equal(first?.text, dupes[0].text);
  assert.equal(second?.text, dupes[1].text);
  assert.notEqual(first?.text, second?.text, "the two `handle`s are distinct bodies");
  assert.ok(second?.text?.includes("filter"), "the SECOND one is Writer's — a name-keyed lookup would return Reader's");
});

test("an ANONYMOUS chunk (no symbol) is fetchable — 40% of the index has no name to key on", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();

  const anon = (await chunksOf(root)).filter((c) => !c.symbol);
  assert.ok(anon.length > 0, "fixture really does produce anonymous chunks");
  const item = ctx.get("src/a.js", { startLine: anon[0].startLine, endLine: anon[0].endLine });
  assert.equal(item?.text, anon[0].text);
});

test("SAFETY: a file edited after indexing throws StalePointerError — never a wrong slice", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const target = (await chunksOf(root)).find((c) => c.symbol === "validateToken");
  assert.ok(target);

  // the worker prepends lines: every line below shifts, so the pointer now spans different code
  writeFileSync(join(root, "src", "a.js"), "// new helper\n".repeat(10) + SRC);

  assert.throws(
    () => ctx.get("src/a.js", { startLine: target.startLine, endLine: target.endLine }),
    (e) => e instanceof StalePointerError && e.code === "STALE_POINTER" && e.path === "src/a.js",
    "must refuse — a slice by these lines is now a different symbol's body",
  );
});

test("SAFETY: an in-place edit that moves NO lines is still caught — lines cannot see it, the hash can", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const target = (await chunksOf(root)).find((c) => c.symbol === "validateToken");
  assert.ok(target);

  // same line count, same byte length class — only the identifier changed. A line-range check passes;
  // only the content hash notices. Without the hash gate the caller silently reads PRE-EDIT code.
  writeFileSync(join(root, "src", "a.js"), SRC.replace("verifySignature(t)", "verifySignaturX(t)"));

  assert.throws(
    () => ctx.get("src/a.js", { startLine: target.startLine, endLine: target.endLine }),
    StalePointerError,
    "the stored body no longer matches disk — serving it would hide the caller's own edit",
  );
});

test("re-index restores service, and the chunk now carries the edit", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();

  writeFileSync(join(root, "src", "a.js"), SRC.replace("verifySignature(t)", "verifyMARKER(t)"));
  await ctx.index(); // what a caller does each loop turn — a no-op pass is milliseconds

  const target = (await chunksOf(root)).find((c) => c.symbol === "validateToken");
  assert.ok(target);
  const item = ctx.get("src/a.js", { startLine: target.startLine, endLine: target.endLine });
  assert.ok(item?.text?.includes("verifyMARKER"), "serves the CURRENT code, not the body it indexed before");
});

test("a line range matching no chunk returns null — never a silent fallback to the whole file", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();

  const item = ctx.get("src/a.js", { startLine: 9000, endLine: 9001 });
  assert.equal(item, null, "a bogus range must MISS; returning the file would reintroduce the bloat invisibly");
});

test("written memory is stored whole — asking it for a chunk misses rather than lying", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:x", "some remembered fact", { kind: "fact" });
  assert.ok(ctx.get("fact:x"), "the fact itself is readable");
  assert.equal(ctx.get("fact:x", { startLine: 0, endLine: 1 }), null, "but it has no chunks");
});

// ---- the index-format stamp: an index must not survive a litectx that would chunk it differently ----

test("a fresh index records the current stamp; an unchanged re-index is a no-op", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  const first = await ctx.index();
  assert.equal(ctx.store.storedStamp(), indexStamp(), "stamped with the litectx that built it");
  assert.equal(first.added, 1);

  const again = await ctx.index();
  assert.equal(again.added, 0, "matching stamp -> incremental, nothing rebuilt");
  assert.equal(again.unchanged, 1, "the file was skipped, not re-read");
});

test("an index written by a DIFFERENT litectx is rebuilt, and written memory survives it", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  await ctx.remember("fact:survives", "must outlive a rebuild", { kind: "fact" });

  // simulate an index built by an older litectx: the stored stamp no longer matches this source.
  ctx.store.setStoredStamp(12345);
  assert.notEqual(ctx.store.storedStamp(), indexStamp());

  const r = await ctx.index();
  assert.equal(r.unchanged, 0, "stamp mismatch -> a full re-chunk, NOT an mtime fast-skip");
  assert.equal(r.added, 1, "every file re-read from scratch");
  assert.equal(ctx.store.storedStamp(), indexStamp(), "and the index is re-stamped");
  assert.equal(ctx.get("fact:survives")?.text, "must outlive a rebuild", "the rebuild clears FILE rows only (§3.2)");
});

// Regression (code-review F1): a stamp mismatch triggers a full re-chunk, which CLEARS the index. A
// `paths`-scoped pass covers only a subset — clearing inside one would delete files the caller never
// mentioned, breaking `index()`'s promise that "a scoped pass never deletes files outside its scope".
// Every existing consumer's FIRST pass after upgrading hits a stamp mismatch, so this is the upgrade
// path, not an exotic corner. Needs a real git repo: pathspecs only scope when `git ls-files` runs.
test("a scoped pass on a stale-stamped index re-chunks its scope WITHOUT deleting anything else", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-scoped-"));
  mkdirSync(join(root, "src"), { recursive: true });
  for (const f of ["alpha", "beta", "gamma"]) {
    writeFileSync(join(root, "src", `${f}.js`), `export function ${f}Handler() { return 1; }\n`);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: root });

  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: false });
  await ctx.index();
  assert.equal(ctx.store.count(), 3);

  ctx.store.setStoredStamp(999); // an index built by an OLDER litectx — i.e. every consumer, once

  const r = await ctx.index({ paths: ["src/alpha.js"] });
  assert.equal(ctx.store.count(), 3, "beta.js and gamma.js are untouched on disk and MUST remain indexed");
  assert.equal(r.updated, 1, "the scoped file is re-chunked (a stale stamp means its boundaries may be wrong)");

  const hits = await ctx.recall("betaHandler", { kind: "code", n: 3 });
  assert.equal(hits[0]?.path, "src/beta.js", "recall must still find the out-of-scope file, not a wrong one");

  assert.notEqual(ctx.store.storedStamp(), indexStamp(), "a partial pass must NOT stamp — it cannot vouch for what it never read");
  await ctx.index(); // a full pass can, and does
  assert.equal(ctx.store.storedStamp(), indexStamp());
});

// Regression (code-review F2): the drift guard must hold on EVERY path that serves a stored chunk
// body, not just get(). recall({body:true}) reads the same nodes.body table; without the gate it hands
// an editing caller back its own pre-edit code, silently — the exact bug the chunk fetch exists to kill.
test("recall({body:true}) does not serve pre-edit code after its file drifts", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: false });
  await ctx.index();

  const before = await ctx.recall("validateToken", { kind: "code", n: 1, body: true });
  assert.ok(before[0]?.body?.includes("verifySignature"), "clean index: the body is served");

  writeFileSync(join(root, "src", "a.js"), SRC.replace("verifySignature(t)", "verifyPATCHED(t)"));

  const after = await ctx.recall("validateToken", { kind: "code", n: 1, body: true });
  assert.ok(after.length > 0, "the hit itself still ranks — a drifted file is not hidden from recall");
  assert.equal(after[0].body, null, "but its body is withheld, NOT served as the stale pre-edit text");
  assert.ok(!after[0].body?.includes("verifySignature"), "the caller can never read code its own edit replaced");
});

// A DELETED file is not a DRIFTED file. Drift is dangerous (the range now spans different code, and
// the stored body is what the file used to say). Deletion is merely absence — nothing can be misread,
// and the stored body is the only record left. recall's chunk bodies are index-truth and deliberately
// survive it (test/recall-body.test.js); get is disk-truth and does not. Guards against "fixing" the
// drift bug by nulling everything, which would silently break that older, deliberate contract.
test("a DELETED file is treated as absence, not drift — recall still serves, get does not", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: false });
  await ctx.index();
  const target = (await chunksOf(root)).find((c) => c.symbol === "validateToken");
  assert.ok(target);

  rmSync(join(root, "src", "a.js")); // gone from disk; still in the index

  const [hit] = await ctx.recall("validateToken", { kind: "code", n: 1, body: true });
  assert.ok(hit?.body?.includes("validateToken"), "recall still serves the chunk body (index is not a file cache)");

  assert.equal(
    ctx.get("src/a.js", { startLine: target.startLine, endLine: target.endLine }),
    null,
    "get is disk-truth: a deleted file yields null, and does NOT throw StalePointerError (that would misname absence as drift)",
  );
});

test("the stamp is stable across processes and moves only with litectx's own source", () => {
  assert.equal(indexStamp(), indexStamp(), "deterministic — an unchanged library must not churn indexes");
  assert.ok(Number.isInteger(indexStamp()) && indexStamp() > 0, "a positive i32 — the width PRAGMA user_version stores");
  assert.notEqual(indexStamp(), 0, "0 is reserved for a db that never carried a stamp, so it must never collide");
});
