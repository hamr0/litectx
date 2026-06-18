// Document-store integration tests — the multis M3 ask R2 (scope), R3 (byte-exact any-file store),
// R5 (per-row expiry), plus the md-buffer branch of the unified ingest(). Behavior, not implementation:
// real fixtures (sales.csv/sales.xlsx/logo.png/notes.md under fixtures/doc-ingest), a temp repo +
// in-memory DB, embeddings OFF. The load-bearing claims here are the acceptance criteria in the ask:
// a blob round-trips byte-identical, a scoped recall returns `scope ∪ null-global` and nothing else,
// and an expired row is invisible to recall/get and reclaimed (bytes and all) by purge().

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LiteCtx } from "../src/index.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "doc-ingest");
const bytes = (name) => readFileSync(join(FIX, name));

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-docstore-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.js"), "export function boot(){ return 'ok'; }\n");
  return root;
}
const newCtx = () => new LiteCtx({ root: fixtureRepo(), dbPath: ":memory:" });
const md = (s) => Buffer.from(s, "utf8");

// === R3: store any file BYTE-EXACT, findable by filename, body never chunked ====================

test("R3 — xlsx blob round-trips BYTE-EXACT via get(); recall finds it by filename, not by content", async () => {
  const ctx = newCtx();
  const original = bytes("sales.xlsx"); // a real binary spreadsheet
  const res = await ctx.ingest(original, { filename: "sales.xlsx" });
  assert.equal(res.mode, "blob");
  assert.equal(res.format, "xlsx");
  assert.equal(res.chunks, 0, "a blob is not chunked");

  // (AC#2) get(id) returns the ORIGINAL bytes, round-trip identical
  const item = await ctx.get(res.id);
  assert.ok(Buffer.isBuffer(item.bytes), "blob get returns Buffer bytes");
  assert.ok(item.bytes.equals(Buffer.from(original)), "bytes must be byte-for-byte identical");
  assert.equal(item.text, null, "a blob has no text body — bytes are the payload");
  assert.equal(item.kind, "doc");

  // findable by FILENAME
  const byName = await ctx.recall("sales", { kind: "doc" });
  assert.ok(byName.some((h) => h.path === res.id), "blob must surface on a filename query");
  // NOT findable by its binary content, and body never leaks (not chunked)
  const byContent = await ctx.recall("EMEA APAC revenue", { kind: "doc", body: true });
  assert.ok(!byContent.some((h) => h.path === res.id), "blob body is not searchable (never parsed)");
});

test("R3 — png blob (pure binary) round-trips byte-exact", async () => {
  const ctx = newCtx();
  const original = bytes("logo.png");
  const res = await ctx.ingest(original, { filename: "logo.png" });
  assert.equal(res.format, "png");
  const item = await ctx.get(res.id);
  assert.ok(item.bytes.equals(Buffer.from(original)), "png bytes survive the round-trip exactly");
  assert.equal(item.bytes.subarray(0, 4).toString("latin1"), "\x89PNG", "the PNG magic header is intact");
});

test("R3 — csv blob: text, but stored as a blob (not chunked) and round-trips exactly", async () => {
  const ctx = newCtx();
  const original = bytes("sales.csv");
  const res = await ctx.ingest(original, { filename: "sales.csv", id: "blob:sales" });
  assert.equal(res.id, "blob:sales");
  assert.equal(res.mode, "blob");
  const item = await ctx.get("blob:sales");
  assert.ok(item.bytes.equals(Buffer.from(original)));
  // its rows are NOT individually recallable — the csv content is not indexed
  assert.equal((await ctx.recall("AMER", { kind: "doc" })).length, 0);
});

test("R3 — re-ingesting a blob id upserts the bytes (no orphan, no duplicate row)", async () => {
  const ctx = newCtx();
  await ctx.ingest(bytes("sales.csv"), { filename: "sales.csv", id: "blob:x" });
  await ctx.ingest(bytes("logo.png"), { filename: "logo.png", id: "blob:x" }); // replace
  const item = await ctx.get("blob:x");
  assert.ok(item.bytes.equals(Buffer.from(bytes("logo.png"))), "re-ingest replaced the bytes");
  assert.equal((await ctx.recall("sales", { kind: "doc" })).length, 0, "old filename token is gone");
});

// === md-buffer branch (user's "md buffers too, cheap") ==========================================

test("md buffer → chunked into recallable doc segments (reuses the markdown segmenter)", async () => {
  const ctx = newCtx();
  const res = await ctx.ingest(bytes("notes.md"), { filename: "notes.md" });
  assert.equal(res.mode, "chunked");
  assert.equal(res.format, "md");
  assert.ok(res.chunks > 1, `notes.md has 3 headings → >1 segment, got ${res.chunks}`);
  const hits = await ctx.recall("rotate database credentials secrets", { kind: "doc", body: true });
  assert.ok(hits.length && /credentials/i.test(hits[0].body), "the Security section is recallable");
});

// === R2: scope on every row + recall scope filter (scope ∪ null-global) =========================

test("R2 — a scoped recall returns its own scope + global, never another scope; unscoped sees all", async () => {
  const ctx = newCtx();
  // three docs that all match the same query — the ONLY differentiator is scope.
  await ctx.ingest(md("# Memo\nquarterly synergy targets for the team"), { filename: "a.md", id: "doc:a", scope: "chatA" });
  await ctx.ingest(md("# Memo\nquarterly synergy targets for the team"), { filename: "b.md", id: "doc:b", scope: "chatB" });
  await ctx.ingest(md("# Memo\nquarterly synergy targets for the team"), { filename: "kb.md", id: "doc:kb" }); // no scope = global

  const ids = (hits) => new Set(hits.map((h) => h.path.replace(/#\d+$/, "")));

  const a = ids(await ctx.recall("synergy targets", { kind: "doc", scope: "chatA" }));
  assert.ok(a.has("doc:a"), "scoped recall sees its own scope");
  assert.ok(a.has("doc:kb"), "scoped recall ALSO sees the global (null-scope) kb");
  assert.ok(!a.has("doc:b"), "scoped recall NEVER sees another scope (cross-customer fenced)");

  const all = ids(await ctx.recall("synergy targets", { kind: "doc" }));
  assert.ok(["doc:a", "doc:b", "doc:kb"].every((id) => all.has(id)), "an unscoped recall sees every scope");
});

test("R2 — scope fences blobs too", async () => {
  const ctx = newCtx();
  await ctx.ingest(bytes("sales.csv"), { filename: "alpha-sales.csv", id: "blob:a", scope: "chatA" });
  await ctx.ingest(bytes("sales.csv"), { filename: "beta-sales.csv", id: "blob:b", scope: "chatB" });
  const a = await ctx.recall("sales", { kind: "doc", scope: "chatA" });
  assert.deepEqual(a.map((h) => h.path), ["blob:a"], "scoped blob recall is fenced to its scope");
});

// === R5: per-record expiry — excluded from recall/get, reclaimed by purge =======================

test("R5 — an expired row is excluded from recall AND get; a null-expiry row persists", async () => {
  const ctx = newCtx();
  const now = Date.now();
  await ctx.ingest(md("# Old\nephemeral budget upload alpha"), { filename: "old.md", id: "doc:old", expiresAt: now - 1000 });
  await ctx.ingest(md("# New\nephemeral budget upload beta"), { filename: "new.md", id: "doc:new" }); // null = forever

  const hits = await ctx.recall("ephemeral budget upload", { kind: "doc" });
  const roots = new Set(hits.map((h) => h.path.replace(/#\d+$/, "")));
  assert.ok(!roots.has("doc:old"), "recall excludes the expired row");
  assert.ok(roots.has("doc:new"), "recall keeps the live row");
  assert.equal(await ctx.get("doc:old#0"), null, "get on an expired row returns null");
  assert.ok((await ctx.get("doc:new#0")) !== null, "get on a live row works");
});

test("R5 — purge() reclaims expired rows + their blob bytes; live rows survive", async () => {
  const ctx = newCtx();
  const now = Date.now();
  await ctx.ingest(bytes("logo.png"), { filename: "old.png", id: "blob:old", expiresAt: now - 1 });
  await ctx.ingest(bytes("sales.csv"), { filename: "keep.csv", id: "blob:keep" }); // forever

  const n = ctx.purge();
  assert.equal(n, 1, "purge reclaimed exactly the one expired row");
  // the blob bytes are gone from the store (no orphan) — size reflects only the survivor
  assert.equal(ctx.size(), 1, "only the live blob row remains");
  assert.ok((await ctx.get("blob:keep")) !== null, "the null-expiry blob survives purge");
  assert.equal(await ctx.get("blob:old"), null, "the expired blob is gone after purge");
});

test("R5 — purge with an explicit cutoff only reclaims rows past that time", async () => {
  const ctx = newCtx();
  const base = Date.now();
  await ctx.ingest(bytes("sales.csv"), { filename: "a.csv", id: "blob:t1", expiresAt: base + 1000 });
  await ctx.ingest(bytes("sales.csv"), { filename: "b.csv", id: "blob:t2", expiresAt: base + 100000 });
  assert.equal(ctx.purge({ now: base + 5000 }), 1, "only the row past the cutoff is reclaimed");
  assert.ok((await ctx.get("blob:t2")) !== null, "the not-yet-expired row remains");
});

test("R2 — get(id, {scope}) fences the direct handle (recall fencing alone isn't enough)", async () => {
  const ctx = newCtx();
  await ctx.ingest(bytes("sales.csv"), { filename: "a.csv", id: "blob:a", scope: "chatA" });
  await ctx.ingest(bytes("logo.png"), { filename: "kb.png", id: "blob:global" }); // no scope = global

  // matching scope → returned; another scope → null (the load-bearing isolation for a guessed id)
  assert.ok((await ctx.get("blob:a", { scope: "chatA" })) !== null, "owner scope can fetch its own doc");
  assert.equal(await ctx.get("blob:a", { scope: "chatB" }), null, "another scope CANNOT fetch by a guessed id");
  // a global (null-scope) row stays visible to every scope
  assert.ok((await ctx.get("blob:global", { scope: "chatB" })) !== null, "global doc is visible to any scope");
  // bare get(id) is unchanged — unfenced by id (backward-compatible; owner/session model untouched)
  assert.ok((await ctx.get("blob:a")) !== null, "bare get(id) stays unfenced");
});

test("R2 — get scope-fencing does not touch fact/episode (those scope via owner/session)", async () => {
  const ctx = newCtx();
  await ctx.remember("fact:policy", "refunds are processed within 30 days", { kind: "fact" });
  // a fact has no doc_scope row → a scoped get still returns it (the doc-scope axis doesn't apply)
  assert.ok((await ctx.get("fact:policy", { scope: "chatA" })) !== null, "fact get is unaffected by doc scope");
});

// === R4 extended: a blob is bounded by maxSize and writes nothing on rejection ==================

test("R4 — an oversized blob is rejected before storage; index left intact", async () => {
  const ctx = newCtx();
  await assert.rejects(() => ctx.ingest(bytes("sales.xlsx"), { filename: "big.xlsx", maxSize: 100 }), /maxSize/);
  assert.equal((await ctx.recall("big", { kind: "doc" })).length, 0, "a rejected blob writes nothing");
});

// === forget reclaims a blob (memory-only delete still drops the bytes) ===========================

test("forget(id) on a blob drops the row and reclaims its bytes", async () => {
  const ctx = newCtx();
  await ctx.ingest(bytes("logo.png"), { filename: "logo.png", id: "blob:gone" });
  assert.equal(ctx.forget("blob:gone"), 1);
  assert.equal(await ctx.get("blob:gone"), null, "blob is gone after forget");
});
