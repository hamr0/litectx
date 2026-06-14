// contextgraph (src/contextgraph.js) — the CE-pipeline observability primitive, over the SHIPPED surface.
// Proves: observe() records real verb calls live with their primitive; trace:true is the same wrap via
// config (and keeps instanceof); tap() folds in a free-function verb; the taxonomy is grounded; and a
// bare instance (no trace) is untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LiteCtx, observe, ContextGraph, assemble, PRIMITIVE, PRIMITIVES, VERBS_BY_PRIMITIVE } from "../src/index.js";

const fresh = (cfg = {}) => new LiteCtx({ root: process.cwd(), dbPath: ":memory:", ...cfg });

test("observe() records each CE verb call with its primitive, in order", async () => {
  const ctx = observe(fresh());
  await ctx.remember("fact:t", "hello world", { kind: "fact", by: "human" });
  await ctx.recall("hello", { kind: "fact" });
  const verbs = ctx.trace.nodes.map((n) => `${n.verb}:${n.primitive}`);
  assert.deepEqual(verbs, ["remember:Write", "recall:Select"]);
  assert.equal(ctx.trace.edges.length, 1); // one handoff remember → recall
  assert.match(ctx.trace.mermaid(), /flowchart LR[\s\S]*remember[\s\S]*recall/);
});

test("recorded stats carry the real args + result of each call", async () => {
  const ctx = observe(fresh());
  await ctx.remember("fact:a", "x", { kind: "fact" });
  const hits = await ctx.recall("x", { kind: "fact" });
  const recall = ctx.trace.nodes.find((n) => n.verb === "recall");
  assert.equal(recall.detail, `${hits.length} hits`);
  assert.ok(Array.isArray(recall.stats.args));
});

test("new LiteCtx({ trace: true }) is the same wrap via config, and stays a LiteCtx", async () => {
  const ctx = fresh({ trace: true });
  assert.ok(ctx instanceof LiteCtx, "trace:true must not break instanceof");
  await ctx.remember("fact:c", "y", { kind: "fact" });
  assert.deepEqual(ctx.trace.nodes.map((n) => n.verb), ["remember"]);
});

test("tap() folds a free-function verb (assemble) into the same trace", async () => {
  const ctx = observe(fresh());
  const tracedAssemble = ctx.tap("assemble", assemble);
  await ctx.remember("fact:d", "z", { kind: "fact" });
  await tracedAssemble([{ id: "u", role: "user", content: "z".repeat(40) }], { budget: 5 });
  assert.deepEqual(ctx.trace.nodes.map((n) => n.verb), ["remember", "assemble"]);
  assert.equal(ctx.trace.nodes.find((n) => n.verb === "assemble").primitive, "Compress");
});

test("a bare instance (no trace) is untouched — no proxy, no .trace", async () => {
  const ctx = fresh();
  assert.equal(ctx.trace, undefined);
  await ctx.remember("fact:e", "w", { kind: "fact" }); // still a normal write
  assert.equal(ctx.get("fact:e").text, "w");
});

test("taxonomy is the W/S/C/I trunk, grounded", () => {
  assert.deepEqual(PRIMITIVES, ["Write", "Select", "Compress", "Isolate"]);
  assert.equal(PRIMITIVE.assemble, "Compress");
  assert.equal(PRIMITIVE.recall, "Select");
  assert.ok(VERBS_BY_PRIMITIVE.Write.includes("remember"));
});

test("ContextGraph can be built directly (json + mermaid)", () => {
  const g = new ContextGraph();
  const a = g.node({ verb: "recall", primitive: "Select", detail: "3 hits" });
  const b = g.node({ verb: "assemble", primitive: "Compress", detail: "2 kept" });
  g.edge(a, b, "3 units");
  const j = g.json();
  assert.equal(j.nodes.length, 2);
  assert.equal(j.edges[0].label, "3 units");
  assert.match(g.mermaid(), /recall[\s\S]*assemble/);
});
