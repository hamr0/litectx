// RT-3 #3 sealed opaque metadata — `remember({ meta })` round-trip + the seal. The flag exists so a
// consumer mounting litectx as a generic key-value memory store (bareagent's `Store`) can attach an
// arbitrary dict and get it back verbatim, WITHOUT that dict leaking into search. Load-bearing
// invariants:
//   1. round-trip — get(id).meta and a recall hit's .meta deep-equal what was written (nesting too);
//   2. SEALED — a term that appears only in meta never makes the memory recallable (meta is in no FTS
//      table, so it can't be tokenized/searched/scored);
//   3. absent cleanly — files and meta-less memory return meta:null (get) / no .meta (hit);
//   4. re-remember without meta clears any prior meta; forget removes it (no leak to a reused id).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "litectx-meta-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.js"), "function login(u){ return issueToken(u); }\n");
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  return { ctx, root };
}

test("get(id).meta round-trips the opaque dict verbatim, including nesting", async () => {
  const { ctx, root } = await fixture();
  const meta = { sessionId: "s-42", tags: ["auth", "jwt"], nested: { author: "agent-7", n: 3 } };
  await ctx.remember("fact:auth", "Auth uses JWT, verified in middleware.", { meta });
  const item = ctx.get("fact:auth");
  assert.ok(item);
  assert.deepEqual(item.meta, meta, "verbatim structured round-trip");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a recall hit carries parsed meta on written memory", async () => {
  const { ctx, root } = await fixture();
  const meta = { sessionId: "s-9", tag: "policy" };
  await ctx.remember("fact:refund", "Refunds are issued within 30 days.", { meta });
  const hits = await ctx.recall("refund policy", { kind: "fact" });
  const hit = hits.find((h) => h.path === "fact:refund");
  assert.ok(hit, "fact recalled");
  assert.deepEqual(hit.meta, meta, "hit.meta is the parsed dict");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("SEALED: a term only in meta never makes the memory recallable", async () => {
  const { ctx, root } = await fixture();
  await ctx.remember("fact:alpha", "alpha body text", { meta: { token: "zztopsecretxyz" } });
  // the term lives ONLY in meta — it must be in no FTS surface
  const byMeta = await ctx.recall("zztopsecretxyz", { kind: "fact" });
  assert.equal(byMeta.length, 0, "meta content is not searchable");
  // the body still finds it, and meta still rides along
  const byBody = await ctx.recall("alpha", { kind: "fact" });
  const hit = byBody.find((h) => h.path === "fact:alpha");
  assert.ok(hit, "recallable by its body");
  assert.equal(hit.meta?.token, "zztopsecretxyz", "and meta is returned, just never indexed");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("meta is absent cleanly — files and meta-less memory", async () => {
  const { ctx, root } = await fixture();
  await ctx.remember("fact:plain", "no meta here", {});
  const memItem = ctx.get("fact:plain");
  assert.equal(memItem?.meta, null, "meta-less memory → null");
  const fileItem = ctx.get("src/auth.js");
  assert.equal(fileItem?.meta, null, "a file has no caller metadata → null");
  const hits = await ctx.recall("no meta here", { kind: "fact" });
  const hit = hits.find((h) => h.path === "fact:plain");
  assert.ok(hit && hit.meta === undefined, "meta-less hit carries no .meta field");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("re-remember without meta clears prior meta; the latest write wins", async () => {
  const { ctx, root } = await fixture();
  await ctx.remember("fact:x", "first", { meta: { v: 1 } });
  assert.deepEqual(ctx.get("fact:x")?.meta, { v: 1 });
  await ctx.remember("fact:x", "second", {}); // no meta → clears
  assert.equal(ctx.get("fact:x")?.meta, null, "stale meta gone after a meta-less rewrite");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// A deterministic 2-D stub embedder (no model download) so the tri-hybrid / KNN-union ranking path
// runs in CI — the path none of the BM25-only tests above exercise.
function vecStub() {
  return {
    /** @param {string} t */
    async embed(t) {
      const a = (t.match(/auth/gi) || []).length;
      const j = (t.match(/jwt/gi) || []).length;
      const n = Math.hypot(a, j) || 1;
      return Float32Array.from([a / n, j / n]);
    },
  };
}

test("body + meta survive the embeddings-ON ranking path (KNN/cosine), not just BM25", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-meta-emb-"));
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: true, embedder: vecStub() });
  await ctx.remember("fact:a", "auth uses jwt tokens", { meta: { src: "handbook" } });
  await ctx.remember("fact:b", "auth via oauth flows", {}); // 2nd candidate → engages cosine fusion, not the short-circuit
  const hits = await ctx.recall("auth jwt", { kind: "fact", body: true });
  const hit = hits.find((h) => h.path === "fact:a");
  assert.equal(ctx.embeddings, true, "embeddings tier active (the tri-hybrid path)");
  assert.ok(hit, "recalled through the embeddings ranking, not BM25-only");
  assert.equal(hit.body, "auth uses jwt tokens", "body attached after tri-hybrid ranking");
  assert.deepEqual(hit.meta, { src: "handbook" }, "meta attached after tri-hybrid ranking");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("forget removes meta — a reused id does not inherit a ghost", async () => {
  const { ctx, root } = await fixture();
  await ctx.remember("fact:y", "body", { meta: { secret: true } });
  ctx.forget("fact:y");
  assert.equal(ctx.get("fact:y"), null, "forgotten");
  await ctx.remember("fact:y", "reused body", {}); // same id, no meta
  assert.equal(ctx.get("fact:y")?.meta, null, "no ghost meta from the prior life");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
