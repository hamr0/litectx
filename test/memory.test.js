// Slice 7 integration tests — the write path (remember/forget) for directly-authored memory:
// facts, episodes, and docs with no file behind them (§3.2). Behavior, not implementation, against
// a temp repo + in-memory DB. The load-bearing invariant is the reconcile seam: written memory is
// source='direct', never in file_index, so index() can never sweep it away.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

/** Build a throwaway repo on disk; returns its root. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-mem-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.js"), "function validateToken(t){ return verifySignature(t); }\n");
  writeFileSync(join(root, "README.md"), "# Demo\nThis project sends email notifications.\n");
  return root;
}

/** Deterministic 2-D marker embedder (alpha/beta), shape-compatible with the real one; counts calls. */
function markerStub() {
  return {
    calls: 0,
    /** @param {string} text */
    async embed(text) {
      this.calls++;
      const a = (text.match(/alpha/g) || []).length;
      const b = (text.match(/beta/g) || []).length;
      const n = Math.hypot(a, b) || 1;
      return Float32Array.from([a / n, b / n]);
    },
  };
}

test("remember a fact → recall finds it, with no index() ever (pure-memory mode)", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:auth-uses-jwt", "Authentication uses JWT tokens verified in middleware.", { kind: "fact", by: "human" });
  const hits = await ctx.recall("jwt authentication", { kind: "fact" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "fact:auth-uses-jwt");
  assert.equal(hits[0].kind, "fact");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("episode and doc are recallable; grouped recall spans all four kinds", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("ep:async", "recall became asynchronous on the embeddings slice.", { kind: "episode" });
  await ctx.remember("faq:refunds", "Refunds are available within thirty days of purchase.", { kind: "doc" });
  const ep = await ctx.recall("asynchronous recall", { kind: "episode" });
  assert.equal(ep[0].path, "ep:async");
  const doc = await ctx.recall("refunds available", { kind: "doc" });
  assert.equal(doc[0].path, "faq:refunds");
  const grouped = await ctx.recall("anything");
  assert.deepEqual(Object.keys(grouped).sort(), ["code", "doc", "episode", "fact"]);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("forget(id) removes one memory by key", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:x", "Spreading rides import edges only in recall.", { kind: "fact" });
  assert.equal((await ctx.recall("spreading import edges", { kind: "fact" })).length, 1);
  assert.equal(ctx.forget("fact:x"), 1);
  assert.equal((await ctx.recall("spreading import edges", { kind: "fact" })).length, 0);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("forget({ by }) bulk-invalidates by provenance, leaving human facts", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:human", "Humans assert durable truths about the system.", { kind: "fact", by: "human" });
  await ctx.remember("fact:agent1", "Agents assert tentative facts about the system.", { kind: "fact", by: "agent" });
  await ctx.remember("fact:agent2", "Agents also assert facts about the system here.", { kind: "fact", by: "agent" });
  assert.equal(ctx.forget({ by: "agent" }), 2);
  const left = await ctx.recall("assert facts about the system", { kind: "fact", n: 10 });
  assert.deepEqual(left.map((h) => h.path), ["fact:human"]);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("forget never touches indexed files (only source='direct' rows)", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const before = ctx.size();
  await ctx.remember("fact:a", "A directly written fact about tokens.", { kind: "fact" });
  // a sweeping forget-by-query must remove the fact but leave every indexed file intact.
  assert.equal(ctx.forget({ kind: "fact" }), 1);
  assert.equal(ctx.size(), before, "indexed files survived the forget");
  const code = await ctx.recall("validate token", { kind: "code" });
  assert.ok(code.some((h) => h.path === "src/auth.js"), "indexed code still recallable");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("the reconcile seam: written memory survives index() (scoped and full passes)", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:keep", "A fact that must outlive every index reconciliation.", { kind: "fact" });
  await ctx.index({ paths: ["src/"] }); // scoped pass
  assert.equal((await ctx.recall("outlive index reconciliation", { kind: "fact" })).length, 1, "survives scoped index");
  await ctx.index(); // full incremental pass — computes deletes from file_index keys
  assert.equal((await ctx.recall("outlive index reconciliation", { kind: "fact" })).length, 1, "survives full index");
  // and a file deletion + reindex (the real sweep) still leaves it alone
  rmSync(join(root, "README.md"));
  const { removed } = await ctx.index();
  assert.equal(removed, 1, "the deleted file was swept");
  assert.equal((await ctx.recall("outlive index reconciliation", { kind: "fact" })).length, 1, "fact survives a real sweep");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("written memory survives index({ force: true }) — force rebuilds files, never memory", async () => {
  const root = fixtureRepo();
  // embeddings on (stub), so the test also pins that a written row's VECTOR survives force —
  // the clear is scoped to file_index keys, and written rows are never in file_index.
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: true, embedder: markerStub() });
  await ctx.index();
  await ctx.remember("fact:survivor", "Force reindex must never destroy written memory.", { kind: "fact", by: "human" });
  await ctx.remember("faq:survivor", "Direct docs have no file behind them either.", { kind: "doc" });
  await ctx.recall("force reindex", { kind: "fact" }); // one demand row — the log must survive too
  const r = await ctx.index({ force: true });
  assert.equal(r.added, 2, "every file was re-read from scratch");
  assert.equal((await ctx.recall("force reindex destroy", { kind: "fact" }))[0]?.path, "fact:survivor");
  assert.equal(ctx.get("fact:survivor")?.text, "Force reindex must never destroy written memory.", "raw text survived");
  assert.equal(ctx.get("faq:survivor")?.source, "direct", "direct doc row survived (only source='file' rows were cleared)");
  // 2 = the pre-force row SURVIVED plus the post-force recall above (post-force alone would be 1)
  assert.equal(ctx.store.recallCount("fact:survivor"), 2, "the demand history survived (append-only)");
  const vecs = /** @type {{ n: number }} */ (
    ctx.store.db.prepare("SELECT count(*) AS n FROM file_embeddings WHERE path = 'fact:survivor'").get()
  );
  assert.equal(vecs.n, 1, "the written row's embedding survived (clear is scoped to file_index keys)");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("remember upserts by id — a second write replaces the first", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:v", "The original assertion mentions caching.", { kind: "fact" });
  await ctx.remember("fact:v", "The revised assertion mentions throttling.", { kind: "fact" });
  assert.equal((await ctx.recall("caching", { kind: "fact" })).length, 0, "old text gone");
  const now = await ctx.recall("throttling", { kind: "fact" });
  assert.equal(now.length, 1, "one row, not two");
  assert.equal(now[0].path, "fact:v");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("recall logs every hit to the audit log (recorded, not scored)", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:logged", "A fact about retrieval auditing in litectx.", { kind: "fact" });
  assert.equal(ctx.store.recallCount("fact:logged"), 0);
  await ctx.recall("retrieval auditing", { kind: "fact" });
  await ctx.recall("retrieval auditing", { kind: "fact" });
  assert.equal(ctx.store.recallCount("fact:logged"), 2, "each recall hit appended one audit row");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("remember rejects an invalid kind and an invalid provenance", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await assert.rejects(() => ctx.remember("x", "t", { kind: "code" }), /kind must be fact/);
  await assert.rejects(() => ctx.remember("x", "t", { kind: "fact", by: "robot" }), /by must be/);
  assert.throws(() => ctx.forget({}), /needs at least/);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("embeddings-on remember stores a vector and recall runs the tri-hybrid path", async () => {
  const root = fixtureRepo();
  const stub = markerStub();
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: true, embedder: stub });
  // shared FTS term "widget" so both pool; markers steer the semantic vector.
  await ctx.remember("fact:a", "widget alpha alpha", { kind: "fact" });
  await ctx.remember("fact:b", "widget beta beta", { kind: "fact" });
  assert.equal(ctx.store.db.prepare("SELECT count(*) AS n FROM file_embeddings").get().n, 2, "each remember embedded + stored a vector");
  const callsAfterWrites = stub.calls;
  const hits = await ctx.recall("widget alpha", { kind: "fact", n: 2 });
  assert.equal(callsAfterWrites, 2, "remember embedded on write (not lazily at recall)");
  assert.equal(stub.calls, 3, "recall embedded the query once on top of the two writes");
  assert.equal(hits[0].path, "fact:a", "the alpha fact ranks first via the tri-hybrid path");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("occurred_at: episode defaults to ~now, an explicit value is honored, a fact stores null", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  const t0 = Date.now();
  await ctx.remember("ep:default", "an event with no explicit time", { kind: "episode" });
  await ctx.remember("ep:explicit", "an event at a fixed time", { kind: "episode", occurredAt: 1000 });
  await ctx.remember("fact:timeless", "a durable truth", { kind: "fact", occurredAt: 9999 });
  // facts/episodes live in the stemmed `mem` table since slice 7b (§5.1)
  const at = (id) => /** @type {{ occurred_at: number|null }} */ (ctx.store.db.prepare("SELECT occurred_at FROM mem WHERE path = ?").get(id)).occurred_at;
  assert.ok(at("ep:default") >= t0, "episode with no occurredAt defaulted to ~now");
  assert.equal(at("ep:explicit"), 1000, "explicit occurredAt is stored verbatim");
  assert.equal(at("fact:timeless"), null, "a fact ignores occurredAt — no constitutive time (the 9999 is dropped)");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("forget cleans the row's embedding and recall-log alongside the doc row", async () => {
  const root = fixtureRepo();
  const stub = markerStub();
  const ctx = new LiteCtx({ root, dbPath: ":memory:", embeddings: true, embedder: stub });
  await ctx.remember("fact:gone", "widget alpha", { kind: "fact" });
  await ctx.recall("widget alpha", { kind: "fact" }); // appends a recall-log row for fact:gone
  const n = (t) => /** @type {{ n: number }} */ (ctx.store.db.prepare(`SELECT count(*) AS n FROM ${t} WHERE path = 'fact:gone'`).get()).n;
  assert.equal(n("file_embeddings"), 1, "precondition: vector present");
  assert.ok(ctx.store.recallCount("fact:gone") >= 1, "precondition: a hit was logged");
  ctx.forget("fact:gone");
  assert.equal(n("docs"), 0, "doc row removed");
  assert.equal(n("file_embeddings"), 0, "embedding removed (no orphan vector)");
  assert.equal(ctx.store.recallCount("fact:gone"), 0, "recall-log rows removed (no orphan audit trail)");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("stemmed memory recall (7b): a fact stored with 'refunds' is found by 'refund' (and episodes too)", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:returns", "Refunds are honored within thirty days of purchase.", { kind: "fact" });
  await ctx.remember("ep:rollout", "Deployed the caching layer to production.", { kind: "episode" });
  // inflectional variants — zero exact-token overlap with the stored text
  const f = await ctx.recall("refund policy", { kind: "fact" });
  assert.equal(f[0]?.path, "fact:returns", "porter stem matches refund→refunds");
  const e = await ctx.recall("deployment of caches", { kind: "episode" });
  assert.equal(e[0]?.path, "ep:rollout", "deploy/cache stems match across inflection");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("the stemming boundary (7b): doc and code recall stay keyword-exact — deliberately", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  // a direct-written doc rides the UNSTEMMED docs table (one kind = one ranking domain, §5.1):
  // the same morph query that finds the fact must NOT find the doc.
  await ctx.remember("faq:returns", "Refunds are honored within thirty days of purchase.", { kind: "doc" });
  const d = await ctx.recall("refund policy", { kind: "doc" });
  assert.ok(!d.some((h) => h.path === "faq:returns"), "doc stays keyword-exact (porter-everywhere was measured and rejected)");
  // and an exact-word query still finds it (the doc is reachable, just unstemmed)
  const d2 = await ctx.recall("refunds honored", { kind: "doc" });
  assert.equal(d2[0]?.path, "faq:returns");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("reviewCandidates surfaces only agent facts past the threshold; promotion clears them", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:hot", "alpha widget retrieval", { kind: "fact", by: "agent" });
  await ctx.remember("fact:cold", "alpha widget retrieval", { kind: "fact", by: "agent" });
  await ctx.remember("fact:human", "alpha widget retrieval", { kind: "fact", by: "human" });
  // drive only fact:hot past the threshold (recall by its unique id is the cleanest way to log hits).
  for (let i = 0; i < 3; i++) await ctx.recall("hot", { kind: "fact" });
  assert.deepEqual(ctx.reviewCandidates(3).map((c) => c.path), ["fact:hot"], "agent fact past threshold only — cold (below) and human (excluded) absent");
  // a human validates it → re-remember as human; it leaves the candidate set (provenance flipped off 'agent').
  await ctx.remember("fact:hot", "alpha widget retrieval", { kind: "fact", by: "human" });
  assert.equal(ctx.reviewCandidates(3).length, 0, "promotion removes it from the review set");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

// --- chunk pointers on written memory + the log: false demand-signal opt-out ---

test("written memory carries chunk: null — the row is the unit, there is nothing to localize", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:auth-uses-jwt", "Authentication uses JWT tokens verified in middleware.", { kind: "fact" });
  const hits = await ctx.recall("jwt authentication", { kind: "fact" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].chunk, null);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("log: false skips the audit log — the log is a demand signal, non-demand consumers opt out", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:auth-uses-jwt", "Authentication uses JWT tokens verified in middleware.", { kind: "fact" });
  await ctx.recall("jwt authentication", { kind: "fact", log: false }); // flat mode
  await ctx.recall("jwt authentication", { log: false }); // grouped mode
  assert.equal(ctx.store.recallCount("fact:auth-uses-jwt"), 0);
  await ctx.recall("jwt authentication", { kind: "fact" }); // default still logs
  assert.equal(ctx.store.recallCount("fact:auth-uses-jwt"), 1);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("the audit log records each hit's chunk symbol — the grain the edit-bind will join on", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const hits = await ctx.recall("validate the auth token", { kind: "code", n: 5 });
  assert.equal(hits[0].chunk?.symbol, "validateToken");
  const row = ctx.store.db
    .prepare("SELECT symbol FROM recall_log WHERE path = ? ORDER BY id DESC LIMIT 1")
    .get("src/auth.js");
  assert.equal(row.symbol, "validateToken");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
