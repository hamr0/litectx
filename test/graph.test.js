// R-G1/R-G2 graph substrate — getNode (describe a node) + related (walk its edges). The graph is
// first-class public API: recall/impact are views over it, and so is the human codegraph view
// (examples/graph-view). These tests pin the load-bearing contract:
//   · getNode is kind-agnostic — an indexed file → chunks + EXACT import-edge counts; written memory
//     → a zero-chunk, zero-edge node; unknown id → null.
//   · related walks PERSISTED import edges (calls are impact()'s job, never graph edges): dir
//     out/in/both, multi-hop BFS, deduped, nearest-hop-wins, seed excluded, hop-cap flags truncation.
//   · the seam invariants: getNode.edges.imports === related(out,1).length and
//     getNode.edges.importedBy === related(in,1).length (counts and walk agree).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "litectx-graph-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  return root;
}
// a → b → c → d chain, plus a → c (so a imports two, c is imported by two): a clean directed graph.
async function chainRepo() {
  const root = repo({
    "src/a.js": "import { b } from './b.js';\nimport { c } from './c.js';\nexport function a(){ return b() + c(); }\n",
    "src/b.js": "import { c } from './c.js';\nexport function b(){ return c(); }\n",
    "src/c.js": "import { d } from './d.js';\nexport function c(){ return d(); }\n",
    "src/d.js": "export function d(){ return 1; }\n",
  });
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  return { ctx, root };
}
const cleanup = (ctx, root) => {
  ctx.close();
  rmSync(root, { recursive: true, force: true });
};

test("getNode describes an indexed file: chunks (its symbols) + exact import-edge counts", async () => {
  const { ctx, root } = await chainRepo();
  const n = ctx.getNode("src/a.js");
  assert.ok(n, "indexed file resolves");
  assert.equal(n.source, "file");
  assert.equal(n.kind, "code");
  assert.ok(n.chunks.some((c) => c.symbol === "a"), "exposes its symbols as chunks");
  assert.equal(n.edges.imports, 2, "a imports b and c");
  assert.equal(n.edges.importedBy, 0, "nothing imports a");
  const c = ctx.getNode("src/c.js");
  assert.equal(c.edges.importedBy, 2, "c is imported by a and b");
  cleanup(ctx, root);
});

test("the seam invariant: getNode edge counts equal the related() walk", async () => {
  const { ctx, root } = await chainRepo();
  for (const id of ["src/a.js", "src/b.js", "src/c.js", "src/d.js"]) {
    const n = ctx.getNode(id);
    assert.equal(n.edges.imports, ctx.related(id, { dir: "out", hops: 1 }).items.length, `${id}: imports === related(out,1)`);
    assert.equal(n.edges.importedBy, ctx.related(id, { dir: "in", hops: 1 }).items.length, `${id}: importedBy === related(in,1)`);
  }
  cleanup(ctx, root);
});

test("related: dir out/in/both walk the right direction, tagged by `via`", async () => {
  const { ctx, root } = await chainRepo();
  const out = ctx.related("src/a.js", { dir: "out", hops: 1 }).items;
  assert.deepEqual(new Set(out.map((r) => r.id)), new Set(["src/b.js", "src/c.js"]));
  assert.ok(out.every((r) => r.via === "out"));

  const cIn = ctx.related("src/c.js", { dir: "in", hops: 1 }).items;
  assert.deepEqual(new Set(cIn.map((r) => r.id)), new Set(["src/a.js", "src/b.js"]));
  assert.ok(cIn.every((r) => r.via === "in"));

  const both = ctx.related("src/c.js", { dir: "both", hops: 1 }).items;
  assert.deepEqual(new Set(both.map((r) => r.id)), new Set(["src/a.js", "src/b.js", "src/d.js"]), "both = importers + imported");
  cleanup(ctx, root);
});

test("related: multi-hop BFS reaches transitively, deduped + nearest-hop-wins, seed excluded", async () => {
  const { ctx, root } = await chainRepo();
  const r = ctx.related("src/a.js", { dir: "out", hops: 3 }).items;
  const hop = Object.fromEntries(r.map((x) => [x.id, x.hops]));
  assert.equal(hop["src/b.js"], 1);
  assert.equal(hop["src/c.js"], 1, "c is hop-1 (a→c direct), not hop-2 via b — nearest-hop-wins");
  assert.equal(hop["src/d.js"], 2, "d reached transitively at hop 2");
  assert.equal(new Set(r.map((x) => x.id)).size, r.length, "deduped");
  assert.ok(!r.some((x) => x.id === "src/a.js"), "seed excluded");
  cleanup(ctx, root);
});

test("related: hops cap at 3, truncated flag reports when the request exceeded it", async () => {
  const { ctx, root } = await chainRepo();
  assert.equal(ctx.related("src/a.js", { dir: "out", hops: 2 }).truncated, false);
  assert.equal(ctx.related("src/a.js", { dir: "out", hops: 99 }).truncated, true, "request > MAX_HOPS flags truncation");
  cleanup(ctx, root);
});

test("getNode is kind-agnostic: written memory is a zero-chunk, zero-edge node", async () => {
  const { ctx, root } = await chainRepo();
  await ctx.remember("fact:x", "auth uses JWT", { kind: "fact", by: "human" });
  const f = ctx.getNode("fact:x");
  assert.ok(f, "written memory resolves");
  assert.equal(f.source, "direct");
  assert.equal(f.kind, "fact");
  assert.equal(f.provenance, "human");
  assert.equal(f.chunks.length, 0, "no chunks — the row IS the unit");
  assert.deepEqual(f.edges, { imports: 0, importedBy: 0 }, "written memory has no edges");
  assert.deepEqual(ctx.related("fact:x").items, [], "related on a zero-edge node is empty");
  cleanup(ctx, root);
});

test("getNode returns null for an unknown id", async () => {
  const { ctx, root } = await chainRepo();
  assert.equal(ctx.getNode("src/nope.js"), null);
  assert.equal(ctx.getNode("fact:nope"), null);
  cleanup(ctx, root);
});
