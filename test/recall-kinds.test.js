// Slice 3 integration tests — kind-scoped recall (§5). The code-over-md fix is structural, not a
// weight: kinds never share a ranking, so prose volume can't bury code. These tests pin the three
// recall modes (single / grouped / omitted-default), the per-kind `n` depth, and the core
// invariant — a `kind:"code"` result can never contain a doc, no matter how prose-heavy the index.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, KINDS } from "../src/index.js";

// A repo where a long prose doc mentions "activation" far more than the terse code that
// implements it — the exact shape that buries code under a shared ranking.
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-kinds-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "activation.js"), "function computeActivation(node){ return node.baseLevel + node.spread; }\n");
  writeFileSync(join(root, "src", "decay.js"), "function applyDecay(v, days){ return v - Math.log10(days); }\n");
  // prose distractor: says "activation" many times, implements nothing.
  writeFileSync(
    join(root, "docs.md"),
    "# Activation\n" + "Activation drives recall. Activation rises on access and activation decays over time. ".repeat(8) + "\n"
  );
  return root;
}

/** @returns {Promise<{ ctx: import("../src/index.js").LiteCtx, root: string }>} */
async function indexed() {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  return { ctx, root };
}

test("single kind → a flat ranked list of only that kind", async () => {
  const { ctx, root } = await indexed();
  const hits = (await ctx.recall("activation", { kind: "code" }));
  assert.ok(Array.isArray(hits), "single kind returns a flat array");
  assert.ok(hits.length > 0);
  assert.ok(hits.every((h) => h.kind === "code"), "every hit is code");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("INVARIANT: a doc can never appear in a kind:code result, however prose-heavy", async () => {
  const { ctx, root } = await indexed();
  // "activation" is mentioned far more in docs.md than in activation.js — under a shared ranking
  // the doc would bury the code. The kind filter makes that structurally impossible.
  const code = (await ctx.recall("activation", { kind: "code" }));
  assert.ok(code.some((h) => h.path === "src/activation.js"), "the code file is found");
  assert.ok(code.every((h) => h.path !== "docs.md"), "no doc leaks into a code result");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("kind:doc returns only docs, ranked among themselves", async () => {
  const { ctx, root } = await indexed();
  const docs = (await ctx.recall("activation", { kind: "doc" }));
  assert.ok(docs.length > 0 && docs.every((h) => h.kind === "doc"));
  assert.ok(docs.some((h) => h.path === "docs.md"));
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("omitted kind → grouped over all KINDS (the safe default)", async () => {
  const { ctx, root } = await indexed();
  const grouped = (await ctx.recall("activation"));
  assert.deepEqual(Object.keys(grouped).sort(), [...KINDS].sort(), "one group per known kind");
  assert.ok(grouped.code.every((h) => h.kind === "code"));
  assert.ok(grouped.doc.every((h) => h.kind === "doc"));
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("explicit multiple kinds → grouped over exactly those kinds", async () => {
  const { ctx, root } = await indexed();
  const grouped = (await ctx.recall("activation", { kind: ["code", "doc"] }));
  assert.deepEqual(Object.keys(grouped).sort(), ["code", "doc"]);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("n caps results per kind; default is 10 single / 5 grouped", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-kinds-n-"));
  mkdirSync(join(root, "src"), { recursive: true });
  // 12 code files all matching "handler" → enough to exercise both defaults and an override.
  // "handler" is a standalone token (not `handler0`, which unicode61 keeps whole).
  for (let i = 0; i < 12; i++) writeFileSync(join(root, "src", `h${i}.js`), `// request handler ${i}\nfunction h${i}(){ return handle(${i}); }\n`);
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();

  assert.equal((await ctx.recall("handler", { kind: "code" })).length, 10, "single-kind default n=10");
  assert.equal((await ctx.recall("handler", { kind: "code", n: 3 })).length, 3, "n overrides the default");
  assert.equal((await ctx.recall("handler", { kind: ["code"] })).code.length, 5, "grouped default n=5 per kind");
  assert.equal((await ctx.recall("handler", { kind: ["code"], n: 8 })).code.length, 8, "grouped n override");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
