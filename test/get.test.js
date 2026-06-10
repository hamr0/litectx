// Slice 9 integration tests — get(id) body access + fetch logging. Behavior, not implementation,
// against a temp repo + in-memory DB. The load-bearing invariants: written memory comes back
// VERBATIM (the FTS body is a processed searchable surface, never the deliverable); file bodies
// are read fresh from disk (the index is not a file cache); and a fetch is a tagged weak signal
// that never pollutes the recall demand signal (the fetch-toll).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

/** Build a throwaway repo on disk; returns its root. */
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-get-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "auth.js"), "function validateToken(t){ return verifySignature(t); }\n");
  writeFileSync(join(root, "README.md"), "# Demo\nThis project sends email notifications.\n");
  return root;
}

test("get(fact-id) returns the text verbatim as remembered — not the processed FTS body", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  const text = "Authentication uses JWT tokens verified in middleware.";
  await ctx.remember("fact:auth-uses-jwt", text, { kind: "fact", by: "human" });
  const item = ctx.get("fact:auth-uses-jwt");
  assert.ok(item);
  assert.equal(item.text, text, "verbatim — no folded path tokens, no camel supplement");
  assert.equal(item.id, "fact:auth-uses-jwt");
  assert.equal(item.kind, "fact");
  assert.equal(item.source, "direct");
  assert.equal(item.provenance, "human");
  assert.equal(item.occurredAt, null);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("get spans every written kind: episode carries occurredAt, a direct doc comes back whole", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("ep:rollout", "Deployed the caching layer to production.", { kind: "episode", occurredAt: 1000 });
  await ctx.remember("faq:refunds", "Refunds are available within thirty days of purchase.", { kind: "doc" });
  const ep = ctx.get("ep:rollout");
  assert.equal(ep?.kind, "episode");
  assert.equal(ep?.occurredAt, 1000);
  assert.equal(ep?.text, "Deployed the caching layer to production.");
  const doc = ctx.get("faq:refunds");
  assert.equal(doc?.kind, "doc");
  assert.equal(doc?.source, "direct");
  assert.equal(doc?.text, "Refunds are available within thirty days of purchase.");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("get(file-path) reads the body fresh from disk — the index is not a file cache", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const item = ctx.get("src/auth.js");
  assert.equal(item?.source, "file");
  assert.equal(item?.kind, "code");
  assert.equal(item?.provenance, null);
  assert.equal(item?.text, readFileSync(join(root, "src", "auth.js"), "utf8"));
  // an edit after indexing is visible immediately — get reads disk, not the stored surface
  writeFileSync(join(root, "src", "auth.js"), "function validateToken(t){ return t.length > 0; }\n");
  assert.match(ctx.get("src/auth.js")?.text ?? "", /t\.length > 0/);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("get on an indexed file that vanished from disk returns the row with text: null", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  rmSync(join(root, "README.md"));
  const item = ctx.get("README.md");
  assert.ok(item, "the index row survives until the next index() sweeps it");
  assert.equal(item.text, null);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("get(unknown-id) returns null", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  assert.equal(ctx.get("fact:never-written"), null);
  assert.equal(ctx.get("src/nope.js"), null);
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a fetch is logged as action='fetch' and never counts as recall demand (the fetch-toll)", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:logged", "A fact about retrieval auditing in litectx.", { kind: "fact" });
  await ctx.recall("retrieval auditing", { kind: "fact" }); // 1 real demand row
  for (let i = 0; i < 5; i++) ctx.get("fact:logged"); // 5 fetches — recorded, not demand
  const rows = /** @type {{ action: string, n: number }[]} */ (
    ctx.store.db.prepare("SELECT action, count(*) AS n FROM recall_log WHERE path = 'fact:logged' GROUP BY action").all()
  );
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.action, r.n])),
    { recall: 1, fetch: 5 },
    "both signals recorded, each under its own tag"
  );
  assert.equal(ctx.store.recallCount("fact:logged"), 1, "recallCount reads demand only — fetches excluded");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("fetches never push an agent fact toward HITL review — reviewCandidates reads recalls only", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:fetched", "alpha widget retrieval", { kind: "fact", by: "agent" });
  for (let i = 0; i < 10; i++) ctx.get("fact:fetched");
  assert.equal(ctx.reviewCandidates(3).length, 0, "10 fetches, 0 recalls → not a candidate");
  for (let i = 0; i < 3; i++) await ctx.recall("widget retrieval", { kind: "fact" });
  assert.deepEqual(ctx.reviewCandidates(3).map((c) => c.path), ["fact:fetched"], "3 real recalls → candidate");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("get(id, { log: false }) skips the audit log — same opt-out contract as recall", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:quiet", "A fact read by a dashboard.", { kind: "fact" });
  ctx.get("fact:quiet", { log: false });
  const n = /** @type {{ n: number }} */ (ctx.store.db.prepare("SELECT count(*) AS n FROM recall_log").get()).n;
  assert.equal(n, 0, "no audit row of any action");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("remember upserts the raw text too — get returns the revision; forget leaves no orphan text", async () => {
  const root = fixtureRepo();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.remember("fact:v", "The original assertion mentions caching.", { kind: "fact" });
  await ctx.remember("fact:v", "The revised assertion mentions throttling.", { kind: "fact" });
  assert.equal(ctx.get("fact:v")?.text, "The revised assertion mentions throttling.");
  ctx.forget("fact:v");
  assert.equal(ctx.get("fact:v"), null);
  const n = /** @type {{ n: number }} */ (ctx.store.db.prepare("SELECT count(*) AS n FROM mem_text").get()).n;
  assert.equal(n, 0, "raw text removed alongside the row");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("a pre-slice-9 db self-heals: recall_log gains `action` (rows preserved as demand), written rows degrade to the stored body", async () => {
  const root = fixtureRepo();
  const dbPath = join(root, "stale.db");
  // fabricate the slice-8 schema: write path present, but no `action` column and no mem_text table
  const { default: Database } = await import("better-sqlite3");
  const old = new Database(dbPath);
  old.exec(
    "CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, kind UNINDEXED, format UNINDEXED, source UNINDEXED, provenance UNINDEXED, occurred_at UNINDEXED, body)"
  );
  old.exec("CREATE TABLE recall_log(id INTEGER PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, symbol TEXT, ts INTEGER NOT NULL)");
  old.exec("CREATE VIRTUAL TABLE mem USING fts5(path UNINDEXED, kind UNINDEXED, format UNINDEXED, provenance UNINDEXED, occurred_at UNINDEXED, body, tokenize='porter unicode61')");
  old.prepare("INSERT INTO mem(path, kind, format, provenance, occurred_at, body) VALUES ('fact:old','fact','text','human',NULL,'fact old fact old\nJWT verification lives in middleware.')").run();
  old.prepare("INSERT INTO recall_log(path, kind, symbol, ts) VALUES ('fact:old','fact',NULL,1)").run();
  old.close();
  const ctx = new LiteCtx({ root, dbPath });
  assert.equal(ctx.store.recallCount("fact:old"), 1, "pre-upgrade log rows were all real recalls — preserved as demand");
  const item = ctx.get("fact:old");
  assert.equal(item?.provenance, "human", "the written row itself is preserved");
  assert.match(item?.text ?? "", /JWT verification/, "no mem_text row → degrades to the stored FTS body, never null");
  ctx.get("fact:old"); // and the healed schema accepts tagged fetch rows
  const fetches = /** @type {{ n: number }} */ (
    ctx.store.db.prepare("SELECT count(*) AS n FROM recall_log WHERE action = 'fetch'").get()
  ).n;
  assert.equal(fetches, 2, "post-heal fetch logging works");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});
