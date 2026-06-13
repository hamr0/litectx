// Build A — the Isolate scope model (§4.4; gate #1 cleared 2026-06-13). Two nullable scope keys on
// written memory: `owner` (the actor — durable `fact`s) and `session` (the run — volatile `episode`s).
// Recall filters `(:me IS NULL OR owner IS NULL OR owner=:me) AND (:sid IS NULL OR session IS NULL OR
// session=:sid)`, so an unset reader sees everything (single-tenant default) and a set reader sees its
// own + global only. Behavior, not implementation. A SHARED FILE db (not :memory:, which is per-
// connection) so multiple LiteCtx instances with different identities read/write one store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

/** A throwaway shared-db root; returns { root, dbPath }. */
function sharedDb() {
  const root = mkdtempSync(join(tmpdir(), "litectx-scope-"));
  mkdirSync(join(root, "src"), { recursive: true });
  return { root, dbPath: join(root, "scope.db") };
}

/** Deterministic 2-D marker embedder (alpha/beta) — same shape the real model returns. */
function markerStub() {
  return {
    async embed(text) {
      const a = (text.match(/alpha/g) || []).length;
      const b = (text.match(/beta/g) || []).length;
      const n = Math.hypot(a, b) || 1;
      return Float32Array.from([a / n, b / n]);
    },
  };
}

const paths = (hits) => hits.map((h) => h.path).sort();

test("episode recall is scoped to its session — a run's own episodes, not other sessions'", async () => {
  const { root, dbPath } = sharedDb();
  const a = new LiteCtx({ root, dbPath, session: "run-1" });
  const b = new LiteCtx({ root, dbPath, session: "run-2" });
  // identical-matching content so the ONLY differentiator is the session key
  await a.remember("ep:s1", "Investigated the rate limiter in the auth service.", { kind: "episode" });
  await b.remember("ep:s2", "Investigated the rate limiter in the auth service.", { kind: "episode" });

  const q = "rate limiter auth service";
  assert.deepEqual(paths(await a.recall(q, { kind: "episode" })), ["ep:s1"], "run-1 sees only its own episode");
  assert.deepEqual(paths(await b.recall(q, { kind: "episode" })), ["ep:s2"], "run-2 sees only its own episode");

  // an unset-session reader (durable / unscoped) sees BOTH — backward-compatible default
  const c = new LiteCtx({ root, dbPath });
  assert.deepEqual(paths(await c.recall(q, { kind: "episode" })), ["ep:s1", "ep:s2"], "unscoped reader sees all sessions");

  a.close(); b.close(); c.close();
  rmSync(root, { recursive: true, force: true });
});

test("fact recall is scoped to its owner — own + global (NULL), never another actor's", async () => {
  const { root, dbPath } = sharedDb();
  const alice = new LiteCtx({ root, dbPath, owner: "alice" });
  const bob = new LiteCtx({ root, dbPath, owner: "bob" });
  const global = new LiteCtx({ root, dbPath }); // owner null = global

  const body = "The billing module uses Stripe for payments.";
  await alice.remember("fact:alice", body, { kind: "fact" });
  await bob.remember("fact:bob", body, { kind: "fact" });
  await global.remember("fact:global", body, { kind: "fact" });

  const q = "billing Stripe payments";
  assert.deepEqual(paths(await alice.recall(q, { kind: "fact" })), ["fact:alice", "fact:global"], "alice sees own + global");
  assert.deepEqual(paths(await bob.recall(q, { kind: "fact" })), ["fact:bob", "fact:global"], "bob sees own + global");
  assert.deepEqual(paths(await global.recall(q, { kind: "fact" })), ["fact:alice", "fact:bob", "fact:global"], "unscoped reader sees all owners");

  alice.close(); bob.close(); global.close();
  rmSync(root, { recursive: true, force: true });
});

test("facts ignore the session key — durable, visible across a same-owner actor's runs", async () => {
  const { root, dbPath } = sharedDb();
  const run1 = new LiteCtx({ root, dbPath, owner: "alice", session: "run-1" });
  await run1.remember("fact:x", "The cache TTL is five minutes.", { kind: "fact" });

  // same owner, a DIFFERENT session — the fact must still surface (facts are cross-session by design)
  const run2 = new LiteCtx({ root, dbPath, owner: "alice", session: "run-2" });
  assert.deepEqual(paths(await run2.recall("cache TTL", { kind: "fact" })), ["fact:x"]);

  run1.close(); run2.close();
  rmSync(root, { recursive: true, force: true });
});

test("unset owner/session writes & reads are unscoped — byte-identical to pre-scope behavior", async () => {
  const { root, dbPath } = sharedDb();
  // a scoped writer puts a scoped fact; an UNSET reader still sees it (:me IS NULL → all owners)
  const scoped = new LiteCtx({ root, dbPath, owner: "alice", session: "run-1" });
  await scoped.remember("fact:a", "Deployments run on Kubernetes.", { kind: "fact" });
  await scoped.remember("ep:a", "Deployments run on Kubernetes.", { kind: "episode" });

  const open = new LiteCtx({ root, dbPath }); // owner & session null
  assert.deepEqual(paths(await open.recall("Kubernetes deployments", { kind: "fact" })), ["fact:a"]);
  assert.deepEqual(paths(await open.recall("Kubernetes deployments", { kind: "episode" })), ["ep:a"]);

  scoped.close(); open.close();
  rmSync(root, { recursive: true, force: true });
});

test("the scope filter threads through the embeddings/KNN path too, not just BM25", async () => {
  const { root, dbPath } = sharedDb();
  const a = new LiteCtx({ root, dbPath, session: "run-1", embeddings: true, embedder: markerStub() });
  const b = new LiteCtx({ root, dbPath, session: "run-2", embeddings: true, embedder: markerStub() });
  await a.remember("ep:s1", "alpha alpha beta deployment", { kind: "episode" });
  await b.remember("ep:s2", "alpha alpha beta deployment", { kind: "episode" });

  // hit knnCandidates DIRECTLY (isolate the semantic path from BM25): run-1's store must nominate
  // only its own session's vector, even though both episodes embed identically.
  const qvec = await markerStub().embed("alpha beta");
  const nomA = a.store.knnCandidates("episode", qvec, 10, new Set());
  assert.deepEqual(nomA.map((h) => h.path).sort(), ["ep:s1"], "KNN nominates only run-1's episode");
  const nomB = b.store.knnCandidates("episode", qvec, 10, new Set());
  assert.deepEqual(nomB.map((h) => h.path).sort(), ["ep:s2"], "KNN nominates only run-2's episode");

  a.close(); b.close();
  rmSync(root, { recursive: true, force: true });
});

test("forget clears the scope row — a reused id does not inherit a ghost scope", async () => {
  const { root, dbPath } = sharedDb();
  const alice = new LiteCtx({ root, dbPath, owner: "alice" });
  await alice.remember("fact:reused", "The API rate limit is 100 rps.", { kind: "fact" });
  alice.forget("fact:reused");

  // re-author the SAME id from an unscoped (global) writer; it must be globally visible, not stuck
  // behind alice's old owner scope (a stale mem_scope row would hide it from bob).
  const global = new LiteCtx({ root, dbPath });
  await global.remember("fact:reused", "The API rate limit is 100 rps.", { kind: "fact" });
  const bob = new LiteCtx({ root, dbPath, owner: "bob" });
  assert.deepEqual(paths(await bob.recall("API rate limit", { kind: "fact" })), ["fact:reused"], "no ghost owner scope after forget");

  alice.close(); global.close(); bob.close();
  rmSync(root, { recursive: true, force: true });
});
