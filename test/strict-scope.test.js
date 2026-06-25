// Fail-closed multi-tenant scope (multis M3 ask) — `null` must stop meaning "all" on a strict store.
// Behavior, not implementation. The load-bearing claims (and their NEGATIVE CONTROLS — every test must
// be able to fail): (1) under strictScope a MISSING doc scope THROWS on read AND write, never returns/
// writes every tenant's rows; (2) GLOBAL is the explicit shared-tier opt-in, distinct from "omitted";
// (3) a set tenant scope still returns `scope ∪ global` and never another tenant; (4) the memory axis
// (fact/episode) and code are untouched; (5) a scoped() view auto-fences with no per-call scope to
// forget; (6) strictScope OFF is byte-identical to the legacy behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, GLOBAL } from "../src/index.js";

function sharedDb() {
  const root = mkdtempSync(join(tmpdir(), "litectx-strict-"));
  mkdirSync(join(root, "src"), { recursive: true });
  return { root, dbPath: join(root, "strict.db") };
}
const paths = (hits) => hits.map((h) => h.path).sort();
const Q = "quarterly revenue report widgets"; // identical content across tenants → scope is the only differentiator

/** Seed three doc rows (tenant A, tenant B, global) with identical searchable content via a NON-strict writer. */
async function seed(dbPath, root) {
  const w = new LiteCtx({ root, dbPath });
  await w.remember("doc:a", "the quarterly revenue report for widgets", { kind: "doc", scope: "user:A" });
  await w.remember("doc:b", "the quarterly revenue report for widgets", { kind: "doc", scope: "user:B" });
  await w.remember("doc:g", "the quarterly revenue report for widgets", { kind: "doc", scope: GLOBAL }); // shared tier
  w.close();
}

// === read fence (recall) ========================================================================

test("strict recall on the doc axis THROWS when scope is omitted (control: non-strict returns everything)", async () => {
  const { root, dbPath } = sharedDb();
  await seed(dbPath, root);

  const strict = new LiteCtx({ root, dbPath, strictScope: true });
  await assert.rejects(strict.recall(Q, { kind: "doc" }), /strictScope/, "a forgotten scope must be a loud error, not a silent all-tenant read");

  // CONTROL: the SAME call on a non-strict store returns every tenant's rows — proving the throw is the
  // flag's doing, and proving the legacy fail-open default is exactly the footgun being closed.
  const open = new LiteCtx({ root, dbPath });
  assert.deepEqual(paths(await open.recall(Q, { kind: "doc" })), ["doc:a", "doc:b", "doc:g"], "non-strict null scope still sees ALL (back-compat)");

  strict.close(); open.close();
  rmSync(root, { recursive: true, force: true });
});

test("strict recall with a tenant scope returns scope ∪ global, never another tenant", async () => {
  const { root, dbPath } = sharedDb();
  await seed(dbPath, root);
  const strict = new LiteCtx({ root, dbPath, strictScope: true });

  assert.deepEqual(paths(await strict.recall(Q, { kind: "doc", scope: "user:A" })), ["doc:a", "doc:g"], "A sees its own + global, NOT B");
  assert.deepEqual(paths(await strict.recall(Q, { kind: "doc", scope: "user:B" })), ["doc:b", "doc:g"], "B sees its own + global, NOT A");
  assert.deepEqual(paths(await strict.recall(Q, { kind: "doc", scope: "user:Z" })), ["doc:g"], "an unknown tenant sees only global");

  strict.close();
  rmSync(root, { recursive: true, force: true });
});

test("strict recall with GLOBAL returns ONLY the shared tier (control: a tenant scope would also include its own)", async () => {
  const { root, dbPath } = sharedDb();
  await seed(dbPath, root);
  const strict = new LiteCtx({ root, dbPath, strictScope: true });

  assert.deepEqual(paths(await strict.recall(Q, { kind: "doc", scope: GLOBAL })), ["doc:g"], "GLOBAL = shared tier only, no tenant rows");
  // CONTROL: GLOBAL is genuinely narrower than a tenant read (which adds the tenant's own rows).
  assert.deepEqual(paths(await strict.recall(Q, { kind: "doc", scope: "user:A" })), ["doc:a", "doc:g"]);

  strict.close();
  rmSync(root, { recursive: true, force: true });
});

test("strict grouped recall (kind omitted → touches the doc axis) THROWS without a scope", async () => {
  const { root, dbPath } = sharedDb();
  await seed(dbPath, root);
  const strict = new LiteCtx({ root, dbPath, strictScope: true });
  await assert.rejects(strict.recall(Q), /strictScope/, "an all-kinds recall includes 'doc', so a missing scope must throw");
  // but an explicit scope makes the same grouped recall fine
  const g = await strict.recall(Q, { scope: "user:A" });
  assert.deepEqual(paths(g.doc), ["doc:a", "doc:g"], "scoped grouped recall fences the doc group");
  strict.close();
  rmSync(root, { recursive: true, force: true });
});

test("strictScope NOW fences the MEMORY axis too (multis M4) — a bare fact/episode recall THROWS; code is still repo-global", async () => {
  const { root, dbPath } = sharedDb();
  const w = new LiteCtx({ root, dbPath });
  await w.remember("fact:1", "the auth service uses JWT bearer tokens", { kind: "fact", scope: "user:A" });
  w.close();

  const strict = new LiteCtx({ root, dbPath, strictScope: true });
  // M4: a memory recall with NO scope fails closed (was the 0.18.0 "untouched" carve-out; revised here so
  // a shared instance can't silently see every tenant's facts) — pass a tenant scope or GLOBAL.
  await assert.rejects(strict.recall("auth JWT tokens", { kind: "fact" }), /strictScope/, "bare fact recall throws under strictScope");
  await assert.rejects(strict.recall("auth JWT tokens", { kind: "episode" }), /strictScope/, "bare episode recall throws under strictScope");
  // a SCOPED memory recall resolves (tenant ∪ global)
  assert.deepEqual(paths(await strict.recall("auth JWT tokens", { kind: "fact", scope: "user:A" })), ["fact:1"], "scoped fact recall works under strictScope");
  // code recall with NO scope is STILL fine (repo-global, never tenant-fenced)
  await assert.doesNotReject(strict.recall("anything", { kind: "code" }), "code recall is untouched by strictScope");
  strict.close();
  rmSync(root, { recursive: true, force: true });
});

// === read fence (get) ===========================================================================

test("strict get THROWS on a bare get(id); GLOBAL/tenant scope fetch, foreign scope reads as absent", async () => {
  const { root, dbPath } = sharedDb();
  await seed(dbPath, root);
  const strict = new LiteCtx({ root, dbPath, strictScope: true });

  // a guessable id can't be fetched without declaring a scope (the R2 get-fence, fail-closed)
  assert.throws(() => strict.get("doc:a"), /strictScope/, "bare get(id) must throw under strictScope");

  // tenant scope: own row resolves, another tenant's reads as absent (not an error — just null)
  assert.equal(strict.get("doc:a", { scope: "user:A" })?.id, "doc:a", "A fetches its own doc");
  assert.equal(strict.get("doc:b", { scope: "user:A" }), null, "A cannot fetch B's doc even by exact id");

  // GLOBAL fetch: the shared-tier row only; a tenant row reads as absent
  assert.equal(strict.get("doc:g", { scope: GLOBAL })?.id, "doc:g", "GLOBAL fetches the shared-tier doc");
  assert.equal(strict.get("doc:a", { scope: GLOBAL }), null, "GLOBAL must NOT fetch a tenant-scoped doc");

  strict.close();
  rmSync(root, { recursive: true, force: true });
});

test("control: with strictScope OFF, a bare get(id) is unfenced (legacy by-id model intact)", async () => {
  const { root, dbPath } = sharedDb();
  await seed(dbPath, root);
  const open = new LiteCtx({ root, dbPath });
  assert.equal(open.get("doc:a")?.id, "doc:a", "non-strict bare get returns the row");
  assert.equal(open.get("doc:b")?.id, "doc:b", "non-strict get is unfenced across tenants (the documented default)");
  open.close();
  rmSync(root, { recursive: true, force: true });
});

test("strict get of a non-doc row (fact) works via GLOBAL — facts have no doc_scope row, so they pass any fence", async () => {
  const { root, dbPath } = sharedDb();
  const w = new LiteCtx({ root, dbPath });
  await w.remember("fact:1", "JWT bearer tokens", { kind: "fact" });
  w.close();
  const strict = new LiteCtx({ root, dbPath, strictScope: true });
  assert.equal(strict.get("fact:1", { scope: GLOBAL })?.id, "fact:1", "a fact is fetchable under strict by opting into a scope");
  assert.throws(() => strict.get("fact:1"), /strictScope/, "but a bare get still throws — the policy is on the call, not the row");
  strict.close();
  rmSync(root, { recursive: true, force: true });
});

// === write fence (ingest / remember) ============================================================

test("strict ingest THROWS without a scope and writes NOTHING (the persistent-leak half of the ask)", async () => {
  const { root, dbPath } = sharedDb();
  const strict = new LiteCtx({ root, dbPath, strictScope: true });
  const before = strict.size();

  await assert.rejects(strict.ingest(Buffer.from("# notes\n\nthe quarterly revenue report", "utf8"), { filename: "notes.md" }), /strictScope/, "an un-scoped ingest must throw, not publish to everyone");
  assert.equal(strict.size(), before, "a thrown ingest writes NOTHING — the index is left intact");

  // fail-fast: the scope throw beats any parse/size work — a deliberately oversized buffer with no scope
  // still throws the SCOPE error, not a size error (resolution happens before the bounds check).
  await assert.rejects(strict.ingest(Buffer.alloc(50_000_000), { filename: "huge.bin" }), /strictScope/, "scope is checked before the maxSize bound (fail-fast)");

  strict.close();
  rmSync(root, { recursive: true, force: true });
});

test("strict ingest with a tenant scope / GLOBAL writes to exactly that tier", async () => {
  const { root, dbPath } = sharedDb();
  const strict = new LiteCtx({ root, dbPath, strictScope: true });

  await strict.ingest(Buffer.from("# memo\n\nwidget revenue planning notes", "utf8"), { filename: "a.md", id: "up:a", scope: "user:A" });
  await strict.ingest(Buffer.from("# memo\n\nwidget revenue planning notes", "utf8"), { filename: "g.md", id: "up:g", scope: GLOBAL });

  // A's view sees A's upload + the global upload, never anything else
  assert.deepEqual(paths(await strict.recall("widget revenue planning", { kind: "doc", scope: "user:A" })).map((p) => p.split("#")[0]).filter((v, i, a) => a.indexOf(v) === i).sort(), ["up:a", "up:g"], "A sees its own + the global upload");
  // a different tenant sees only the global upload
  const bHits = await strict.recall("widget revenue planning", { kind: "doc", scope: "user:B" });
  assert.ok(bHits.every((h) => h.path.startsWith("up:g")), "B sees only the GLOBAL upload, never A's");

  strict.close();
  rmSync(root, { recursive: true, force: true });
});

test("strict remember THROWS without a scope on BOTH the doc axis and the memory axis (multis M4)", async () => {
  const { root, dbPath } = sharedDb();
  const strict = new LiteCtx({ root, dbPath, strictScope: true });
  await assert.rejects(strict.remember("d:1", "a doc body", { kind: "doc" }), /strictScope/, "a doc-row write needs an explicit scope");
  // M4: a fact/episode write now fails closed too (was the 0.18.0 carve-out) — so a tenant write can't
  // silently land in the shared tier. A tenant scope or GLOBAL satisfies it.
  await assert.rejects(strict.remember("f:1", "a fact body", { kind: "fact" }), /strictScope/, "a bare fact write throws under strictScope");
  await assert.rejects(strict.remember("e:1", "an episode body", { kind: "episode" }), /strictScope/, "a bare episode write throws under strictScope");
  await assert.doesNotReject(strict.remember("f:1", "a fact body", { kind: "fact", scope: "user:A" }), "a scoped fact write is allowed");
  await assert.doesNotReject(strict.remember("g:1", "a shared fact", { kind: "fact", scope: GLOBAL }), "a GLOBAL fact write is allowed");
  strict.close();
  rmSync(root, { recursive: true, force: true });
});

// === scoped() view ==============================================================================

test("scoped(scope) view auto-fences recall/ingest/get — no per-call scope to forget", async () => {
  const { root, dbPath } = sharedDb();
  await seed(dbPath, root);
  const strict = new LiteCtx({ root, dbPath, strictScope: true });
  const a = strict.scoped("user:A");

  // recall via the view carries the scope automatically — no scope arg in sight
  assert.deepEqual(paths(await a.recall(Q, { kind: "doc" })), ["doc:a", "doc:g"], "view.recall is auto-fenced to A ∪ global");
  // get via the view is fenced too
  assert.equal(a.get("doc:a")?.id, "doc:a", "view.get fetches A's own row");
  assert.equal(a.get("doc:b"), null, "view.get cannot reach B");
  // ingest via the view writes bound to A
  await a.ingest(Buffer.from("# v\n\nwidget revenue from the view", "utf8"), { filename: "v.md", id: "vw:a" });
  const bView = strict.scoped("user:B");
  assert.ok(!(await bView.recall("widget revenue from the view", { kind: "doc" })).some((h) => h.path.startsWith("vw:a")), "B's view never sees A's view-written upload");

  strict.close();
  rmSync(root, { recursive: true, force: true });
});

test("scoped(GLOBAL) view binds the shared tier; a bound view ignores a scope sneaked into opts", async () => {
  const { root, dbPath } = sharedDb();
  await seed(dbPath, root);
  const strict = new LiteCtx({ root, dbPath, strictScope: true });

  const g = strict.scoped(GLOBAL);
  assert.deepEqual(paths(await g.recall(Q, { kind: "doc" })), ["doc:g"], "GLOBAL view = shared tier only");

  // the bound scope is FINAL — a scope passed in opts (e.g. from a sloppy caller) must not override it.
  const a = strict.scoped("user:A");
  assert.deepEqual(paths(await a.recall(Q, { kind: "doc", scope: "user:B" })), ["doc:a", "doc:g"], "the view's bound scope wins over an opts.scope");

  strict.close();
  rmSync(root, { recursive: true, force: true });
});

test("scoped() with no/empty scope THROWS at creation (control: a real scope does not)", async () => {
  const { root, dbPath } = sharedDb();
  const ctx = new LiteCtx({ root, dbPath }); // even NON-strict: a scope-bound view with no scope is meaningless
  assert.throws(() => ctx.scoped(), /scoped/, "binding a view with no scope is the footgun this closes");
  assert.throws(() => ctx.scoped(null), /scoped/);
  assert.doesNotThrow(() => ctx.scoped("user:A"), "a real scope binds fine");
  assert.doesNotThrow(() => ctx.scoped(GLOBAL), "GLOBAL binds fine");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
});

test("the view works independently of strictScope (it makes the safe path the only path either way)", async () => {
  const { root, dbPath } = sharedDb();
  await seed(dbPath, root);
  const open = new LiteCtx({ root, dbPath }); // strict OFF
  const a = open.scoped("user:A");
  assert.deepEqual(paths(await a.recall(Q, { kind: "doc" })), ["doc:a", "doc:g"], "a scoped view fences even on a non-strict store");
  open.close();
  rmSync(root, { recursive: true, force: true });
});
