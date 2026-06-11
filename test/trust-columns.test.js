// Slice 5c integration tests — written-memory grounding columns on recall hits (§15 5c). The trust
// signals (provenance / use / occurredAt) are SURFACED for the caller to decide, NEVER scored: the
// tie-break was bench-falsified (trust-tiebreak-poc + trust-facts-poc) because it can't reorder
// safely and forcing trust/popularity buries fresh or better-matching answers. So these tests assert
// two things: (1) the columns appear, correct, on written-memory hits only; (2) they have ZERO effect
// on order — a better-matching agent fact outranks a heavily-"used" human one. Behavior, not impl.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "litectx-trust-"));

test("written-memory hits surface provenance + use; a fresh fact reads use:0 (not omitted)", async () => {
  const ctx = new LiteCtx({ root: tmp(), dbPath: ":memory:" });
  await ctx.remember("fact:limit", "The API rate limit is 100 requests per minute.", { by: "agent" });
  const [h] = await ctx.recall("api rate limit per minute", { kind: "fact", log: false });
  assert.equal(h.path, "fact:limit");
  assert.equal(h.provenance, "agent");
  assert.equal(h.use, 0); // never recalled yet — surfaced as 0, a fresh-not-a-demerit signal
  assert.equal(h.occurredAt, null); // a fact, not an episode
  ctx.close();
});

test("use counts recall demand only — fetches and log:false reads don't inflate it", async () => {
  const ctx = new LiteCtx({ root: tmp(), dbPath: ":memory:" });
  await ctx.remember("fact:deploy", "Deploys run on merge to main via the trusted publisher.", { by: "agent" });
  ctx.store.logRecall([{ path: "fact:deploy", kind: "fact" }], 1); // real demand
  ctx.store.logRecall([{ path: "fact:deploy", kind: "fact" }], 2); // real demand
  ctx.store.logRecall([{ path: "fact:deploy", kind: "fact" }], 3, "fetch"); // a get() body read — the fetch-toll, excluded
  const [h] = await ctx.recall("deploy on merge to main", { kind: "fact", log: false });
  assert.equal(h.use, 2); // two recalls; the fetch does not count, and this log:false read adds nothing
  ctx.close();
});

test("provenance and use NEVER reorder — a better-matching agent fact outranks a heavily-used human one", async () => {
  const ctx = new LiteCtx({ root: tmp(), dbPath: ":memory:" });
  await ctx.remember("fact:eta", "Refund requests usually take about a week to process.", { by: "agent" });
  await ctx.remember("fact:window", "Refunds are issued within 5 business days.", { by: "human" });
  for (let i = 0; i < 20; i++) ctx.store.logRecall([{ path: "fact:window", kind: "fact" }], i + 1); // pile "use" on the human fact
  const hits = await ctx.recall("how long do refunds take to process", { kind: "fact", log: false });
  // BM25 prefers the better-worded answer (the agent fact); neither human-provenance nor 20 uses jump the queue.
  assert.equal(hits[0].path, "fact:eta");
  assert.equal(hits[0].provenance, "agent");
  const human = hits.find((h) => h.path === "fact:window");
  assert.ok(human && human.use >= 20 && human.provenance === "human"); // surfaced, just not scored
  ctx.close();
});

test("episode hits surface occurredAt; indexed code hits carry no written-memory columns", async () => {
  const root = tmp();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/tok.js"), "export function splitCamel(s){ return s.split(/(?=[A-Z])/); }\n");
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const when = Date.now() - 2 * 86_400_000;
  await ctx.remember("ep:1", "debugged the flaky auth timeout in the splitCamel test", { kind: "episode", occurredAt: when });

  const [ep] = await ctx.recall("flaky auth timeout", { kind: "episode", log: false });
  assert.equal(ep.occurredAt, when); // episode timestamp surfaced

  const [code] = await ctx.recall("split camel identifier tokens", { kind: "code", log: false });
  assert.equal(code.provenance, undefined); // a file is not a claim awaiting validation
  assert.equal(code.use, undefined);
  assert.equal(code.occurredAt, undefined);
  ctx.close();
});

test("grouped recall attaches columns to mem groups only", async () => {
  const root = tmp();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/rate.js"), "export function rateLimit(){ return 100; }\n");
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  await ctx.remember("fact:rate", "rate limit is 100 requests per minute", { by: "human" });
  const grouped = await ctx.recall("rate limit", { log: false });
  assert.equal(grouped.fact[0].provenance, "human");
  if (grouped.code?.length) assert.equal(grouped.code[0].provenance, undefined);
  ctx.close();
});
