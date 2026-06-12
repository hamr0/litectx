// Slice 2 integration tests — tree-sitter symbol chunking + md sections, and the `nodes`
// substrate they populate. Real WASM grammars + a temp repo with an in-memory DB; chunks are
// additive (recall is unaffected — that invariant is the bench's job, asserted there).
// Behavior, not implementation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import { chunkFile } from "../src/chunker.js";

test("chunks python into functions, classes, methods, and a preamble", async () => {
  const src = ["import os", "", "def alpha(x):", "    return x + 1", "", "class Beta:", "    def gamma(self):", "        return 2", ""].join("\n");
  const chunks = await chunkFile("m.py", src);
  const symbols = chunks.map((c) => c.symbol);
  assert.ok(symbols.includes("alpha"), `expected alpha in ${symbols}`);
  assert.ok(symbols.includes("Beta"), `expected Beta in ${symbols}`);
  assert.ok(symbols.includes("gamma"), `expected gamma (method) in ${symbols}`);
  const preamble = chunks.find((c) => c.nodeType === "preamble");
  assert.ok(preamble && preamble.text.includes("import os"), "preamble should hold the top-level import");
  for (const c of chunks) assert.ok(c.endLine >= c.startLine, "line range must be ordered");
});

test("attaches a leading JSDoc to its symbol chunk, not the preamble", async () => {
  // regression: JS/TS JSDoc is a sibling node ABOVE the def — without attachment it orphans into
  // `preamble`, dissociating the doc from the symbol it documents (recall localizes to the wrong
  // chunk). The doc must ride in the function's own chunk. (poc/rc7-doc-localize-poc.mjs)
  const src = [
    "import { run } from './r.js';",
    "",
    "/**",
    " * Reconcile invoices before the settlement window.",
    " */",
    "export function settle(acct) {",
    "  return run(acct);",
    "}",
    "",
  ].join("\n");
  const chunks = await chunkFile("billing.js", src);
  const settle = chunks.find((c) => c.symbol === "settle");
  assert.ok(settle, "settle chunk exists");
  assert.ok(settle.text.includes("Reconcile invoices"), "JSDoc rides in the symbol chunk");
  assert.ok(settle.text.startsWith("/**"), "chunk starts at the doc-comment");
  const preamble = chunks.find((c) => c.nodeType === "preamble");
  assert.ok(!preamble || !preamble.text.includes("Reconcile invoices"), "doc is NOT orphaned into preamble");
});

test("a blank line breaks doc attachment (the comment isn't this def's)", async () => {
  const src = ["# unrelated banner", "", "def f(x):", "    return x", ""].join("\n");
  const chunks = await chunkFile("m.py", src);
  const f = chunks.find((c) => c.symbol === "f");
  assert.ok(f && !f.text.includes("banner"), "a comment separated by a blank line stays in preamble");
});

test("chunks markdown into heading sections", async () => {
  const md = ["# Title", "intro", "", "## Section A", "body a", "", "## Section B", "body b", ""].join("\n");
  const chunks = await chunkFile("doc.md", md);
  assert.deepEqual(chunks.map((c) => c.symbol), ["Title", "Section A", "Section B"]);
  assert.ok(chunks.every((c) => c.nodeType === "section"));
});

test("falls back to a single file chunk for unsupported types", async () => {
  const chunks = await chunkFile("data.json", "{ \"a\": 1 }\n");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].nodeType, "file");
});

test("malformed source never throws — falls back to a file chunk", async () => {
  const chunks = await chunkFile("broken.py", "def (((:\n  ???\n");
  assert.ok(chunks.length >= 1, "must always return at least one chunk");
});

test("indexing populates the nodes substrate per file", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-chunk-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.js"), "function validateToken(t){ return verifySignature(t); }\n");
  writeFileSync(join(root, "README.md"), "# Demo\nintro text\n## Usage\nrun it\n");
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();

  assert.ok(ctx.store.nodeCount() >= 3, "expected chunks for the function + md sections");
  const authNodes = ctx.store.nodesForPath("src/auth.js");
  assert.ok(authNodes.some((n) => n.symbol === "validateToken"), "auth.js should yield a validateToken node");
  const docNodes = ctx.store.nodesForPath("README.md");
  assert.ok(docNodes.some((n) => n.symbol === "Usage"), "README should yield a Usage section node");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("re-indexing a changed file replaces its nodes; deleting removes them", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-chunk-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const f = join(root, "src", "svc.py");
  writeFileSync(f, "def first():\n    return 1\n");
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  assert.deepEqual(ctx.store.nodesForPath("src/svc.py").map((n) => n.symbol), ["first"]);

  writeFileSync(f, "def second():\n    return 2\n");
  await ctx.index({ force: true });
  assert.deepEqual(ctx.store.nodesForPath("src/svc.py").map((n) => n.symbol), ["second"], "old node should be gone");

  rmSync(f);
  await ctx.index();
  assert.equal(ctx.store.nodesForPath("src/svc.py").length, 0, "deleted file's nodes should be dropped");

  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
