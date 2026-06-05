// Slice 4 integration tests — import edges + 1-hop spreading (§4, §7). Edges are resolved from a
// single tree-sitter parse (chunker) to intra-repo files (edges.js) and stored directed in `edges`;
// recall blends BM25 with the best relevance among a candidate's import-neighbours. These tests pin
// the per-language extraction/resolution, the intra-repo-only rule, the incremental refresh/drop of
// edges, and the behaviour that earns the slice — a graph-adjacent file is lifted in recall.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import { resolveImports, buildResolveCtx } from "../src/edges.js";

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "litectx-edges-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
// edges as a Set of "src→dst" strings, read straight off the store for assertions.
function edgesOf(ctx) {
  const rows = ctx.store.db.prepare("SELECT src_path, dst_path FROM edges WHERE type='import'").all();
  return new Set(rows.map((r) => `${r.src_path}→${r.dst_path}`));
}
async function indexed(files) {
  const root = repo(files);
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  return { ctx, root, edges: edgesOf(ctx) };
}
const cleanup = (ctx, root) => {
  ctx.close();
  rmSync(root, { recursive: true, force: true });
};

test("JS ESM + CJS imports resolve to intra-repo files (extension + bare require)", async () => {
  const { ctx, root, edges } = await indexed({
    "src/a.js": "import { b } from './b.js';\nconst c = require('./c');\nexport function a(){ return b() + c(); }\n",
    "src/b.js": "export function b(){ return 1; }\n",
    "src/c.js": "module.exports = function c(){ return 2; };\n",
  });
  assert.ok(edges.has("src/a.js→src/b.js"), "ESM import with extension resolves");
  assert.ok(edges.has("src/a.js→src/c.js"), "CJS bare require resolves via .js");
  assert.equal(ctx.store.edgeCount(), 2);
  cleanup(ctx, root);
});

test("Python absolute + relative imports resolve through the package layout", async () => {
  const { ctx, root, edges } = await indexed({
    "pkg/__init__.py": "",
    "pkg/a.py": "from pkg.b import thing\nfrom .c import other\n\ndef a():\n    return thing() + other()\n",
    "pkg/b.py": "def thing():\n    return 1\n",
    "pkg/c.py": "def other():\n    return 2\n",
  });
  assert.ok(edges.has("pkg/a.py→pkg/b.py"), "absolute dotted import resolves by module suffix");
  assert.ok(edges.has("pkg/a.py→pkg/c.py"), "relative `.c` import resolves from the package dir");
  cleanup(ctx, root);
});

test("INTRA-REPO ONLY: external packages and unfound modules yield no edge", async () => {
  const { ctx, root } = await indexed({
    "src/a.js": "import React from 'react';\nimport { x } from './missing.js';\nexport const a = 1;\n",
    "src/b.js": "export const b = 2;\n",
  });
  assert.equal(ctx.store.edgeCount(), 0, "neither the external pkg nor the unfound module makes an edge");
  cleanup(ctx, root);
});

test("VALUE: of two equal-BM25 files, spreading lifts the one a strong hit imports", async () => {
  // `target` and `twin` match the query identically (same term, same length) — pure BM25 ties
  // them. `hub` dominates the query and imports `target`, so spreading lets `target` inherit
  // `hub`'s relevance while `twin` (unconnected) gets nothing. The mechanism's whole point,
  // tested as behaviour and free of any BM25 tie-break fragility.
  const { ctx, root } = await indexed({
    "src/hub.js": `// ${"widget ".repeat(9)}\nimport { build } from './target.js';\nexport function run(){ return build(); }\n`,
    "src/twin.js": "// widget\nexport function twinfn(){ return 0; }\n",
    "src/target.js": "// widget\nexport function build(){ return 0; }\n",
  });
  const score = (hits, p) => hits.find((h) => h.path === p)?.score;
  const bm25 = ctx.store.search("widget", "code", 10, 0);
  assert.equal(score(bm25, "src/target.js"), score(bm25, "src/twin.js"), "precondition: target and twin tie on BM25");

  const spread = ctx.store.search("widget", "code", 10, 0.3);
  assert.ok(score(spread, "src/target.js") > score(spread, "src/twin.js"), "spreading scores the imported file above its unconnected twin");
  const order = spread.map((h) => h.path);
  assert.ok(order.indexOf("src/target.js") < order.indexOf("src/twin.js"), "and ranks it higher");
  cleanup(ctx, root);
});

test("INCREMENTAL: edges refresh when an importer changes and drop when a file is deleted", async () => {
  const root = repo({
    "src/a.js": "import './b.js';\nexport const a = 1;\n",
    "src/b.js": "export const b = 1;\n",
    "src/c.js": "export const c = 1;\n",
  });
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  assert.ok(edgesOf(ctx).has("src/a.js→src/b.js"), "initial edge a→b");

  // repoint a's import b → c; its old edge must not linger.
  writeFileSync(join(root, "src", "a.js"), "import './c.js';\nexport const a = 2;\n");
  await ctx.index();
  let e = edgesOf(ctx);
  assert.ok(!e.has("src/a.js→src/b.js"), "stale edge a→b removed on re-index");
  assert.ok(e.has("src/a.js→src/c.js"), "new edge a→c added");

  // delete c — the edge pointing AT it must be dropped from both ends.
  rmSync(join(root, "src", "c.js"));
  await ctx.index();
  assert.equal(ctx.store.edgeCount(), 0, "edge to a deleted file is dropped, not dangling");
  cleanup(ctx, root);
});

test("unit: resolveImports — suffix match, relative, external skip, self-edge removal", () => {
  const ctx = buildResolveCtx(["packages/core/src/app/a.py", "packages/core/src/app/b.py", "web/x.js", "web/y.js"]);
  // absolute python resolves through the source-root prefix by module suffix
  assert.deepEqual(resolveImports("py", "packages/core/src/app/a.py", ["app.b"], ctx), ["packages/core/src/app/b.py"]);
  // js relative resolves; a bare specifier is external → dropped; self-import → dropped
  assert.deepEqual(resolveImports("js", "web/x.js", ["./y", "lodash", "./x"], ctx), ["web/y.js"]);
  // nothing resolvable → empty
  assert.deepEqual(resolveImports("py", "packages/core/src/app/a.py", ["numpy.linalg"], ctx), []);
});
