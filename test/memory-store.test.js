// RT-3 — liteCtxAsStore integration: litectx mounted as a host `Store` ({store, search, get, delete}).
// Behavior against a :memory: db, exercising the contract a host (bareagent's Memory) depends on. No
// index() — this is the pure written-memory path (the store-as-backend use case), proving litectx
// works as a key-value memory store with ranked search, not just a repo index. Invariants:
//   - store() mints a namespaced id and returns it; get/search project to {id, content, metadata(,score)};
//   - the host's arbitrary metadata dict round-trips verbatim (kind/by reassembled, the rest passed through);
//   - search is RANKED (real scores) and single-kind (comparable), default kind = fact, kind override works;
//   - delete removes; the opaque metadata never leaks into search (the seal, through the adapter).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx, liteCtxAsStore } from "../src/index.js";

// A bare LiteCtx (no repo indexed) + its Store adapter. `root` is required by the constructor but
// never read on the pure-memory path (no file hits) — a throwaway dir suffices.
function backend() {
  const root = mkdtempSync(join(tmpdir(), "litectx-store-"));
  const lc = new LiteCtx({ root, dbPath: ":memory:" });
  return { lc, mem: liteCtxAsStore(lc) };
}

test("exposes the four-method Store shape", () => {
  const { lc, mem } = backend();
  for (const m of ["store", "search", "get", "delete"]) assert.equal(typeof mem[m], "function", `${m} present`);
  lc.close();
});

test("store() mints an id; get() returns {id, content, metadata}", async () => {
  const { lc, mem } = backend();
  const id = await mem.store("Auth uses JWT, verified in middleware.");
  assert.match(id, /^fact:/, "id is namespaced by the default kind");
  const rec = mem.get(id);
  assert.ok(rec);
  assert.equal(rec.id, id);
  assert.equal(rec.content, "Auth uses JWT, verified in middleware.", "content is the verbatim text");
  assert.equal(rec.metadata.kind, "fact", "default kind reassembled into metadata");
  assert.equal(rec.metadata.by, "agent", "default provenance reassembled into metadata");
  lc.close();
});

test("an arbitrary metadata dict round-trips verbatim through get and search", async () => {
  const { lc, mem } = backend();
  const id = await mem.store("Refunds are issued within 30 days.", { sessionId: "s-7", tags: ["policy", "refund"], by: "human" });
  const got = mem.get(id);
  assert.equal(got?.metadata.sessionId, "s-7");
  assert.deepEqual(got?.metadata.tags, ["policy", "refund"]);
  assert.equal(got?.metadata.by, "human", "reserved 'by' consumed on write, reassembled on read");
  assert.equal(got?.metadata.kind, "fact");
  const hits = await mem.search("refund policy");
  const hit = hits.find((h) => h.id === id);
  assert.ok(hit);
  assert.equal(hit.metadata.sessionId, "s-7", "opaque passthrough also on search results");
  assert.deepEqual(hit.metadata.tags, ["policy", "refund"]);
  lc.close();
});

test("search is ranked with real scores, content inlined", async () => {
  const { lc, mem } = backend();
  await mem.store("The login endpoint issues a JWT access token.");
  await mem.store("Cats are small domesticated mammals.");
  const hits = await mem.search("JWT token authentication");
  assert.ok(hits.length >= 1, "the relevant fact is found");
  assert.match(String(hits[0].content), /JWT/, "content is inlined (body flag)");
  assert.equal(typeof hits[0].score, "number");
  assert.ok(Number.isFinite(hits[0].score), "a real relevance score, not a constant");
  assert.ok(!hits.some((h) => /Cats/.test(String(h.content))), "the irrelevant fact does not match");
  lc.close();
});

test("default kind is fact; metadata.kind overrides; search honors options.kind", async () => {
  const { lc, mem } = backend();
  const factId = await mem.store("a plain durable fact");
  const epId = await mem.store("an episode happened", { kind: "episode" });
  assert.match(factId, /^fact:/);
  assert.match(epId, /^episode:/, "metadata.kind drives the write");
  // default search targets fact only — the episode is a different ranking domain
  const facts = await mem.search("plain durable", {});
  assert.ok(facts.some((h) => h.id === factId));
  assert.ok(!facts.some((h) => h.id === epId), "episode not in a fact search (single-kind, comparable scores)");
  const eps = await mem.search("episode happened", { kind: "episode" });
  assert.ok(eps.some((h) => h.id === epId), "options.kind reaches the episode");
  lc.close();
});

test("delete removes the record", async () => {
  const { lc, mem } = backend();
  const id = await mem.store("ephemeral");
  assert.ok(mem.get(id));
  mem.delete(id);
  assert.equal(mem.get(id), null, "gone after delete");
  lc.close();
});

test("SEALED through the adapter: opaque metadata is never searchable", async () => {
  const { lc, mem } = backend();
  const id = await mem.store("body words only", { secret: "qxzsentinel" });
  const byMeta = await mem.search("qxzsentinel");
  assert.ok(!byMeta.some((h) => h.id === id), "a term only in metadata does not match");
  const byBody = await mem.search("body words");
  assert.equal(byBody.find((h) => h.id === id)?.metadata.secret, "qxzsentinel", "but metadata still rides back");
  lc.close();
});

test("get() returns null for an unknown id", () => {
  const { lc, mem } = backend();
  assert.equal(mem.get("fact:nope"), null);
  lc.close();
});
