// THROWAWAY POC — multis M3 ask R2/R3/R5: scope, byte-exact any-file store, per-row expiry.
//
// R0/R1/R4 already shipped (ingestDocument). This POC de-risks the THREE genuinely-new
// surfaces before any build, on REAL data with negative controls (prove-don't-assert: each
// claim must be able to FAIL):
//
//   R3a byte-exact store   — a binary blob (real .wasm + adversarial random bytes) round-trips
//                            byte-identical through a SQLite BLOB column.
//                            NEGATIVE CONTROL: the SAME bytes through a TEXT column must MANGLE
//                            (proves the BLOB column is load-bearing, not incidental).
//   R3b filename recall    — a blob is findable by FILENAME via the docs FTS, while its bytes are
//                            NOT in the searchable body (no leak; body never chunked).
//   R2  scope ∪ null       — a recall scoped to X returns X's rows + global(null), never Y's.
//                            NEGATIVE CONTROL: an unscoped recall returns ALL three.
//   R5  per-row expiry     — a past-expiry row is excluded from recall/get; a null-expiry row
//                            persists; purge() reclaims the row AND its blob bytes.
//
// Mirrors the real store's SQL shape (docs FTS5 + a per-row sidecar + a blob table) so a PASS
// transfers to the build. In-memory db; no writes to any real index.

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const log = (...a) => console.log(...a);
let failures = 0;
const assert = (label, cond) => { log(`  [${cond ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"}] ${label}`); if (!cond) failures++; };

// indexBody stand-in: fold the filename into searchable tokens (the real store uses tokenize.indexBody).
const filenameBody = (filename) => filename.replace(/[^a-zA-Z0-9]+/g, " ").trim();

const db = new Database(":memory:");
db.pragma("journal_mode = WAL");
// Real-shaped schema: docs FTS5 (unchanged), plus the two NEW surfaces under test.
db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, kind UNINDEXED, format UNINDEXED, source UNINDEXED, body)");
// per-row scope + expiry sidecar (R2 + R5) on direct doc/blob rows — NULL/NULL = global/never-expire.
db.exec("CREATE TABLE doc_scope(path TEXT PRIMARY KEY, scope TEXT, expires_at INTEGER)");
// byte-exact blob store (R3) — bytes live here; the docs row carries only the filename for search.
db.exec("CREATE TABLE blobs(path TEXT PRIMARY KEY, bytes BLOB NOT NULL, filename TEXT NOT NULL)");
// NEGATIVE-CONTROL table: the wrong way (TEXT) — to prove BLOB is load-bearing.
db.exec("CREATE TABLE blobs_text_wrong(path TEXT PRIMARY KEY, bytes TEXT NOT NULL)");

// ============================================================================
log("\n=== R3a: byte-exact BLOB round-trip (real .wasm + adversarial random bytes) ===");
const realBin = readFileSync(new URL("../node_modules/web-tree-sitter/tree-sitter.wasm", import.meta.url));
const randBin = randomBytes(50_000); // adversarial: dense non-UTF8, the hardest case for TEXT
const cases = [["real .wasm (188KB)", realBin], ["random 50KB", randBin]];

const insBlob = db.prepare("INSERT INTO blobs(path, bytes, filename) VALUES (?, ?, ?)");
const getBlob = db.prepare("SELECT bytes FROM blobs WHERE path = ?");
const insTextWrong = db.prepare("INSERT INTO blobs_text_wrong(path, bytes) VALUES (?, ?)");
const getTextWrong = db.prepare("SELECT bytes FROM blobs_text_wrong WHERE path = ?");

for (const [label, buf] of cases) {
  // pass a Uint8Array (R0 already learned pdfjs/Node-Buffer quirks — store as plain bytes)
  insBlob.run(`blob:${label}`, buf, `${label}.bin`);
  const got = getBlob.get(`blob:${label}`).bytes; // better-sqlite3 returns a Buffer for BLOB
  assert(`BLOB round-trip byte-identical — ${label}`, Buffer.isBuffer(got) && Buffer.from(buf).equals(got));

  // NEGATIVE CONTROL: same bytes via TEXT. better-sqlite3 refuses a raw Buffer into TEXT, so the
  // only way to force it is to decode→store→reencode (what a naive text store would do) — which
  // mangles non-UTF8. We assert the mangling so the BLOB choice is proven necessary, not lucky.
  const asText = Buffer.from(buf).toString("utf8"); // lossy for non-UTF8
  insTextWrong.run(`blob:${label}`, asText);
  const reread = Buffer.from(getTextWrong.get(`blob:${label}`).bytes, "utf8");
  assert(`TEXT control MANGLES (proves BLOB load-bearing) — ${label}`, !Buffer.from(buf).equals(reread));
}

// ============================================================================
log("\n=== R3b: blob findable by FILENAME via docs FTS; bytes NOT in searchable body ===");
const insDoc = db.prepare("INSERT INTO docs(path, kind, format, source, body) VALUES (?, ?, ?, 'direct', ?)");
// a blob row: docs body is ONLY the filename (never the bytes, never chunked)
insDoc.run("blob:q3-revenue.csv", "doc", "csv", filenameBody("q3-revenue.csv"));
insBlob.run("blob:q3-revenue.csv", Buffer.from("region,rev\nEMEA,42\n"), "q3-revenue.csv");

const ftsHit = db.prepare("SELECT path FROM docs WHERE docs MATCH ? AND kind = 'doc'");
const byName = ftsHit.all("revenue").map((r) => r.path);
assert("recall('revenue') surfaces the csv blob by filename", byName.includes("blob:q3-revenue.csv"));

// the bytes must NOT be searchable — a query on the csv CONTENT ('EMEA') must miss (body not chunked)
const byContent = ftsHit.all("EMEA").map((r) => r.path);
assert("recall('EMEA' = csv content) does NOT surface the blob (body not chunked)", !byContent.includes("blob:q3-revenue.csv"));
// and the stored docs body holds no payload bytes
const bodyRow = db.prepare("SELECT body FROM docs WHERE path = ?").get("blob:q3-revenue.csv");
assert("docs body contains filename tokens, not csv content", bodyRow.body.includes("revenue") && !bodyRow.body.includes("EMEA"));

// ============================================================================
log("\n=== R2: scope ∪ null recall (scoped sees own + global, never another scope) ===");
const insScoped = db.prepare("INSERT INTO doc_scope(path, scope, expires_at) VALUES (?, ?, NULL)");
insDoc.run("doc:chatA-note", "doc", "md", "shared quarterly budget figures");
insScoped.run("doc:chatA-note", "chatA");
insDoc.run("doc:chatB-note", "doc", "md", "shared quarterly budget figures");
insScoped.run("doc:chatB-note", "chatB");
insDoc.run("doc:kb-global", "doc", "md", "shared quarterly budget figures"); // no doc_scope row → global

// scope ∪ null filter (mirrors the planned search() WHERE clause): LEFT JOIN, NULL = global = visible.
const scopedQ = db.prepare(
  "SELECT d.path FROM docs d LEFT JOIN doc_scope s ON s.path = d.path " +
    "WHERE docs MATCH :m AND d.kind = 'doc' AND d.source = 'direct' " +
    "AND (:scope IS NULL OR s.scope IS NULL OR s.scope = :scope) ORDER BY d.path"
);
const scopedA = scopedQ.all({ m: "budget", scope: "chatA" }).map((r) => r.path);
assert("scope=chatA returns chatA + global", scopedA.includes("doc:chatA-note") && scopedA.includes("doc:kb-global"));
assert("scope=chatA EXCLUDES chatB (cross-customer fenced)", !scopedA.includes("doc:chatB-note"));
// NEGATIVE CONTROL: unscoped (null) sees everything
const unscoped = scopedQ.all({ m: "budget", scope: null }).map((r) => r.path);
assert("unscoped recall sees ALL three scopes", ["doc:chatA-note", "doc:chatB-note", "doc:kb-global"].every((p) => unscoped.includes(p)));

// ============================================================================
log("\n=== R5: per-row expiry exclusion + purge reclaims blob bytes ===");
const NOW = 1_750_000_000_000; // fixed clock (Date.now() banned in workflows; explicit here too)
const insExp = db.prepare("INSERT INTO doc_scope(path, scope, expires_at) VALUES (?, NULL, ?)");
insDoc.run("doc:expired", "doc", "md", "ephemeral budget upload");
insExp.run("doc:expired", NOW - 1000); // already expired
insBlob.run("doc:expired", Buffer.from("transient bytes"), "expired.bin"); // a blob to reclaim
insDoc.run("doc:lives", "doc", "md", "ephemeral budget upload");
insExp.run("doc:lives", null); // null = keep forever

// live-recall exclusion: expires_at IS NULL OR expires_at > now
const liveQ = db.prepare(
  "SELECT d.path FROM docs d LEFT JOIN doc_scope s ON s.path = d.path " +
    "WHERE docs MATCH :m AND d.kind='doc' AND d.source='direct' " +
    "AND (s.expires_at IS NULL OR s.expires_at > :now) ORDER BY d.path"
);
const live = liveQ.all({ m: "ephemeral", now: NOW }).map((r) => r.path);
assert("recall excludes the expired row", !live.includes("doc:expired"));
assert("recall keeps the null-expiry row", live.includes("doc:lives"));

// purge: delete expired rows across docs + sidecar + blobs, reclaim bytes (single store, no orphans)
const purge = db.transaction((now) => {
  const dead = db.prepare("SELECT path FROM doc_scope WHERE expires_at IS NOT NULL AND expires_at <= ?").all(now).map((r) => r.path);
  for (const p of dead) {
    db.prepare("DELETE FROM docs WHERE path = ?").run(p);
    db.prepare("DELETE FROM doc_scope WHERE path = ?").run(p);
    db.prepare("DELETE FROM blobs WHERE path = ?").run(p);
  }
  return dead.length;
});
const reclaimedBefore = getBlob.get("doc:expired");
const n = purge(NOW);
assert("purge removed exactly the 1 expired row", n === 1);
assert("purge reclaimed the expired blob bytes (no orphan)", reclaimedBefore != null && getBlob.get("doc:expired") === undefined);
assert("purge left the null-expiry row intact", db.prepare("SELECT 1 FROM docs WHERE path='doc:lives'").get() != null);

db.close();
log(`\n${failures === 0 ? "\x1b[32mALL PASS\x1b[0m" : `\x1b[31m${failures} FAILED\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
