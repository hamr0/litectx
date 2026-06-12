// RT-3 inline-body — `recall(q, { body: true })` integration tests (behavior, not implementation).
// The flag exists so a consumer mounting litectx as a memory store (or feeding an assembler) gets
// content inline instead of a pointer + N follow-up get()s. The load-bearing invariants:
//   1. off by default — recall returns pointers, body is undefined unless asked;
//   2. written memory comes back VERBATIM (the FTS body is a processed search surface, not the text);
//   3. a localized file hit returns ITS CHUNK, not the whole file — and from the index, so it is
//      drift-free (survives the file being deleted from disk);
//   4. a path-only file hit (nothing localized) falls back to the whole file, read fresh from disk;
//   5. grouped recall attaches body across kinds too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const TWO_FN = // two functions: a query for one must return only its chunk, never the sibling
  "function computeActivation(node){ return node.baseLevel + node.spread; }\n\n" +
  "function applyDecay(value, days){ return value - Math.log10(days); }\n";

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-body-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "activation.js"), TWO_FN);
  // distinctive filename token absent from the body → a path-only match (no chunk localizes).
  writeFileSync(join(root, "src", "zephyrwidget.js"), "function compute(){ return 1; }\n");
  return root;
}

/** @returns {Promise<import("../src/index.js").LiteCtx>} */
async function indexed(root) {
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  return ctx;
}

test("body is undefined by default — recall returns pointers, not payloads", async () => {
  const root = fixtureRepo();
  const ctx = await indexed(root);
  const hits = await ctx.recall("computeActivation", { kind: "code" });
  assert.ok(hits.length > 0);
  assert.equal(hits[0].body, undefined, "no body field unless { body: true }");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("written memory body comes back VERBATIM, not the FTS-processed form", async () => {
  const root = fixtureRepo();
  const ctx = await indexed(root);
  const verbatim = "Auth uses JWT; verified in authMiddleware (NOT the login handler).";
  await ctx.remember("fact:auth", verbatim, { kind: "fact" });
  const hits = await ctx.recall("auth JWT middleware", { kind: "fact", body: true });
  const hit = hits.find((h) => h.path === "fact:auth");
  assert.ok(hit, "the fact is recalled");
  assert.equal(hit.body, verbatim, "verbatim text — punctuation/case preserved, path tokens not folded in");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a localized file hit returns its CHUNK, not the whole file", async () => {
  const root = fixtureRepo();
  const ctx = await indexed(root);
  const hits = await ctx.recall("computeActivation", { kind: "code", body: true });
  const hit = hits.find((h) => h.path === "src/activation.js");
  assert.ok(hit && hit.chunk, "the file hit localized to a chunk");
  assert.ok(/computeActivation/.test(String(hit.body)), "body contains the matched function");
  assert.ok(!/applyDecay/.test(String(hit.body)), "body is the chunk only — the sibling function is excluded");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a localized chunk body is drift-free — it survives the file being deleted from disk", async () => {
  const root = fixtureRepo();
  const ctx = await indexed(root);
  rmSync(join(root, "src", "activation.js")); // gone from disk; still in the index
  const hits = await ctx.recall("computeActivation", { kind: "code", body: true });
  const hit = hits.find((h) => h.path === "src/activation.js");
  assert.ok(hit && hit.chunk, "still a localized hit (index is not a file cache)");
  assert.ok(/computeActivation/.test(String(hit.body)), "chunk body served from the index, not disk");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a path-only hit (nothing localized) falls back to the whole file from disk", async () => {
  const root = fixtureRepo();
  const ctx = await indexed(root);
  const hits = await ctx.recall("zephyrwidget", { kind: "code", body: true });
  const hit = hits.find((h) => h.path === "src/zephyrwidget.js");
  assert.ok(hit, "matched by its path token");
  assert.equal(hit.chunk, null, "nothing localized — it was a path match");
  assert.ok(/function compute\(\)/.test(String(hit.body)), "body is the whole file, read fresh from disk");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a path-only hit whose file is gone from disk yields body null", async () => {
  const root = fixtureRepo();
  const ctx = await indexed(root);
  rmSync(join(root, "src", "zephyrwidget.js"));
  const hits = await ctx.recall("zephyrwidget", { kind: "code", body: true });
  const hit = hits.find((h) => h.path === "src/zephyrwidget.js");
  assert.ok(hit && hit.chunk === null);
  assert.equal(hit.body, null, "no chunk to serve from the index, file gone from disk → null");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("grouped recall attaches body across kinds", async () => {
  const root = fixtureRepo();
  const ctx = await indexed(root);
  await ctx.remember("fact:decay", "Decay subtracts log10(days) from the value.", { kind: "fact" });
  const grouped = await ctx.recall("decay value days", { kind: ["code", "fact"], body: true });
  const codeHit = grouped.code.find((h) => h.path === "src/activation.js");
  const factHit = grouped.fact.find((h) => h.path === "fact:decay");
  assert.ok(codeHit && typeof codeHit.body === "string", "code group got a body");
  assert.ok(factHit && factHit.body === "Decay subtracts log10(days) from the value.", "fact group got its verbatim body");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
