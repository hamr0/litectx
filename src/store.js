// SQLite + FTS5 store. Slice 1: an FTS5 table (file granularity, BM25 ranking) plus a
// `file_index` table that tracks content-hash + mtime per file so re-indexing is incremental
// (§6). `kind`/`format` are first-class columns from day one (§3.1). Later slices add the
// nodes/edges/signals tables around this; recall keeps reading FTS.

import Database from "better-sqlite3";
import { indexBody, splitIdent } from "./tokenize.js";
import { cosine } from "./embedder.js"; // pure math — the ML dep stays lazy inside Embedder

// R-I3 peek: a fixed head+tail preview budget, in characters. Head+tail (not head-only) because for the
// payloads stash holds — logs, traces, tool results — the conclusion lives at the END (the failing frame,
// the exit code, the closing structure). The win is a BOUNDED RESULT: the caller gets ~head+tail bytes,
// never the whole blob, so the payload stays out of its context/token budget. NOTE it is *not* a DB-time
// win — SQLite materializes the column to run substr/length, so peek's local compute scales with payload
// (measured: ~comparable to getItem, slower past a few MB). A true O(1) peek would need the byte length
// stored at write time (deferred column). NOT the R-C7 anomaly-keep (full scan → stays in C7).
const STASH_HEAD = 160;
const STASH_TAIL = 80;

/**
 * @typedef {Object} DocRow
 * @property {string} path    repo-relative file path
 * @property {string} kind    "code" | "doc"
 * @property {string} format  source/doc format tag: "ts" | "js" | "py" | "md" | ...
 * @property {string} body    file contents
 */

/**
 * @typedef {DocRow & { hash: string, mtime: number, size: number, nodes?: import("./chunker.js").Chunk[], imports?: string[], edges?: string[], git?: import("./gitsig.js").GitSig, embedding?: Float32Array }} Upsert
 * `imports` are raw specifiers from the chunker; `edges` are those resolved to intra-repo dst paths
 * (edges.js); `git` is file-level activity metadata (gitsig.js); `embedding` is the file's float32
 * vector when the embeddings tier is on (slice 6), absent otherwise.
 */

/**
 * @typedef {Object} Changes
 * @property {Upsert[]} upserts   files to (re)index
 * @property {{ path: string, mtime: number }[]} touch  unchanged content, advanced mtime
 * @property {string[]} deletes   paths to drop from the index
 */

/**
 * @typedef {Object} ChunkRef
 * @property {string|null} symbol   function/class name, or the md heading; null for anonymous/file chunks
 * @property {string} nodeType      tree-sitter node type, "section" (md), or "file" (fallback chunk)
 * @property {number} startLine     0-based, inclusive
 * @property {number} endLine       0-based, inclusive
 */

/**
 * @typedef {Object} Hit
 * @property {string} path
 * @property {string} kind
 * @property {string} format
 * @property {number} score   higher = more relevant
 * @property {import("./gitsig.js").GitSig | null} [git]  file-level git activity (grounding, not scored)
 * @property {ChunkRef | null} [chunk]  the best-matching chunk inside the hit (function pointer >
 *                            file pointer); null when nothing localizes — written memory has no
 *                            chunks (the row IS the unit), and a path-only match names none
 * @property {string | null} [body]  present ONLY when recall is called with `{ body: true }` (RT-3
 *                            inline-body): the hit's content inlined. VERBATIM stored text for written
 *                            memory; the localized chunk's indexed body for a file hit; the whole file
 *                            (read fresh from disk) when nothing localized; null when the file is gone
 *                            or the id is unknown. Off by default — recall returns pointers, not payloads.
 * @property {string|null} [provenance]  written memory only (slice 5c): "human" | "agent" — the
 *                            VALIDATION status (signed-off vs the agent's own assertion), NOT a quality
 *                            signal and NEVER scored: an agent fact may be perfectly true, awaiting HITL.
 *                            Surfaced for the caller to decide; absent on indexed files (not a claim).
 * @property {number} [use]   written memory only (slice 5c): recall-demand count ('recall' rows only —
 *                            fetches excluded, the fetch-toll). Surfaced, NEVER ranked — a fresh effective
 *                            memory has use 0, so ranking on it would be a popularity prior (§14 #4).
 * @property {number|null} [occurredAt]  written memory only (slice 5c): episode timestamp (epoch ms);
 *                            null for facts; absent on indexed files.
 * @property {Record<string, unknown>} [meta]  written memory only (RT-3 #3): the opaque caller
 *                            metadata supplied to `remember`, parsed back from its sealed JSON store
 *                            and returned VERBATIM. Absent when the memory carries none and on every
 *                            indexed file (a file has no caller metadata). Never tokenized/ranked.
 */

/**
 * A graph node's STRUCTURE (what `getNode` returns) — distinct from its body (`get`). Kind-agnostic:
 * an indexed file carries its chunks + import-edge counts; written memory is a zero-chunk, zero-edge node.
 * @typedef {Object} GraphNode
 * @property {string} id                     repo-relative path (file) or written-memory id
 * @property {string} kind
 * @property {string} format
 * @property {"file"|"direct"} source
 * @property {string|null} [provenance]      written memory only: "human" | "agent"
 * @property {import("./gitsig.js").GitSig | null} git  file activity (grounding, not scored); null for written memory
 * @property {ChunkRef[]} chunks             the symbols inside a file node; [] for written memory
 * @property {{ imports: number, importedBy: number }} edges  persisted `import`-edge counts (EXACT; calls are impact()'s job)
 */

/**
 * One neighbour returned by `related` — a node reached by walking persisted edges from the seed.
 * @typedef {Object} RelatedNode
 * @property {string} id
 * @property {string|null} kind    null when the neighbour isn't an indexed node (e.g. an import to a file outside scope)
 * @property {string|null} format
 * @property {number} hops         BFS distance from the seed (nearest-hop-wins)
 * @property {"out"|"in"} via      "out" = the seed imports it; "in" = it imports the seed
 */

const SCHEMA = [
  // path tokens are folded into `body` (doubled) so filename matches count;
  // path/kind/format and the slice-7 write-path metadata are stored but not full-text indexed.
  //   source     — 'file' (indexed from disk) | 'direct' (written via remember). The recall gate
  //                rides `docs` for ALL kinds; written memory is never in `file_index`, so the
  //                incremental sweep (deletes = file_index keys) structurally can't touch it —
  //                `source` makes that invariant explicit and powers forget-by-query / HITL.
  //   provenance — 'human' | 'agent' (written memory only; NULL for indexed files). The trust axis.
  //   occurred_at— episode timestamp (epoch ms; NULL for facts/docs/code). Stored, not yet scored.
  "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, kind UNINDEXED, format UNINDEXED, source UNINDEXED, provenance UNINDEXED, occurred_at UNINDEXED, body)",
  // change detection (§6): (mtime, size) is the fast skip, content_hash the arbiter.
  // size guards the case where an edit lands within one filesystem mtime tick of the last
  // index (mtime unchanged but length moved); `index({ force: true })` covers the rest.
  "CREATE TABLE IF NOT EXISTS file_index(path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, indexed_at INTEGER NOT NULL)",
  // symbol-level chunks (slice 2): the structural substrate. Recall still gates on `docs`
  // (file-granularity) — these line-ranged nodes carry file-level git metadata (slice 4) and
  // anchor call edges (slice 5). `symbol` is nullable (anonymous arrows, preambles); rows are
  // owned by `path`.
  "CREATE TABLE IF NOT EXISTS nodes(id INTEGER PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, format TEXT NOT NULL, symbol TEXT, node_type TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, body TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS nodes_path ON nodes(path)",
  // directed graph edges (slice 4): `type` discriminates 'import' (recall spreading, shipped
  // now) from 'call' (impact view, slice 5) so both ride one table. File-granularity src→dst;
  // owned by `src_path` (refreshed when the importer is re-indexed). Indexed both ways so
  // recall can read neighbours and the impact view can read callers/callees off the same rows.
  "CREATE TABLE IF NOT EXISTS edges(id INTEGER PRIMARY KEY, type TEXT NOT NULL, src_path TEXT NOT NULL, dst_path TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS edges_src ON edges(type, src_path)",
  "CREATE INDEX IF NOT EXISTS edges_dst ON edges(type, dst_path)",
  // file-level git activity (slice 4): commit count + last-commit time, attached to hits as
  // displayed grounding — NOT scored (§4.1). 1:1 with `path`, refreshed when a file is re-indexed.
  "CREATE TABLE IF NOT EXISTS git_sig(path TEXT PRIMARY KEY, commits INTEGER NOT NULL, last_commit INTEGER)",
  // file-level embeddings (slice 6, opt-in tier): one float32 vector per file, stored as a BLOB in
  // the SAME db (no sqlite-vec — recall is BM25-gated, so cosine only ever runs over the candidate
  // pool, never the corpus; brute-force is sub-ms regardless of repo size, POC-validated). Only
  // populated when the embeddings tier is on; 1:1 with `path`, refreshed/dropped with the file.
  "CREATE TABLE IF NOT EXISTS file_embeddings(path TEXT PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL)",
  // recall audit log (slice 7): one row per recall hit — the genuine access log §4's base-level
  // tier will later score (written memory produces real access events, not git's proxy). v1 records
  // it but does not rank on it. Also feeds HITL promotion (§3.2): an agent fact whose hit count
  // crosses the review threshold becomes a human-review candidate. Append-only; many rows per path.
  // `symbol` = the hit's best-matching chunk (chunk-granular recall) so the future edit-bind can
  // join "recalled" and "edited" at the same grain (§14 #4); NULL for written memory / unlocalized.
  // `action` tags the row's signal type (slice 9): 'recall' = real demand (ranked retrieval);
  // 'fetch' = a get(id) body read — mechanically coupled to the recall that produced the id, so
  // counting it would double-count demand (the fetch-toll, §14 #4). Demand readers (recallCount,
  // reviewCandidates) filter to 'recall'; 'fetch' is recorded as a tagged weak signal only, and
  // earns weight (if any) at the action-signal bench — never before.
  "CREATE TABLE IF NOT EXISTS recall_log(id INTEGER PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, symbol TEXT, action TEXT NOT NULL DEFAULT 'recall', ts INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS recall_log_path ON recall_log(path)",
  // raw text of direct-written memory (slice 9): the FTS body is the *searchable surface*
  // (indexBody folds path tokens + camel parts), and unlike an indexed file there is no file on
  // disk to re-read — so `get(id)` needs the original text stored verbatim. One row per written
  // id, upserted by `writeMemory`, dropped by `forgetMemory`. Indexed files never get a row.
  "CREATE TABLE IF NOT EXISTS mem_text(path TEXT PRIMARY KEY, text TEXT NOT NULL)",
  // opaque caller metadata for direct-written memory (RT-3 #3): a sealed JSON passthrough so a
  // consumer mounting litectx as a generic key-value memory store (bareagent's `Store`) can attach an
  // arbitrary dict ({sessionId, tag, author, …}) and get it back VERBATIM. DELIBERATELY a plain
  // sibling table, not an `mem`/`docs` column: it lives in NO fts5 table, so it is sealed by
  // construction — never tokenized, never searched, never scored (litectx stores the bytes, never
  // reads their meaning). One row per written id when meta is supplied; upserted/cleared by
  // `writeMemory`, dropped by `forgetMemory`. A new `CREATE TABLE IF NOT EXISTS` = the most additive
  // migration possible (old dbs gain an empty table, no backfill). Guidance: small structured tags,
  // not payloads — a big blob inflates every hit; park those in `stash`.
  "CREATE TABLE IF NOT EXISTS mem_meta(path TEXT PRIMARY KEY, meta TEXT NOT NULL)",
  // scope keys for written memory (§4.4 Isolate; gate #1 cleared 2026-06-13): two nullable dims —
  // `owner` (NULL = global / not-actor-bound) and `session` (NULL = durable / not-run-bound) — that
  // filter recall so a run's volatile context isn't buried by other sessions, and a shared store
  // isolates per actor. Kind-aware at write (`writeMemory`): `fact` = owner-scoped (durable,
  // cross-session); `episode` = owner + session (volatile, own-run). A SIBLING table, not columns on
  // `mem`: the `mem` FTS5 table takes no `ALTER ADD COLUMN`, so this mirrors `mem_meta` — a
  // `CREATE TABLE IF NOT EXISTS` (old DBs gain an empty table, no backfill; a missing row LEFT-JOINs to
  // NULL/NULL = global/durable = visible, so the filter is byte-identical to today when unset). The
  // read filter (`search`/`knnCandidates`) is `(:me IS NULL OR owner IS NULL OR owner=:me) AND
  // (:sid IS NULL OR session IS NULL OR session=:sid)` — an unset reader (`owner`/`session` = NULL on
  // the Store) sees everything (single-tenant default). One row per scoped written id; refreshed on
  // re-write, dropped by `forgetMemory`. `code`/`doc` are the per-worktree FS index, never scoped here.
  "CREATE TABLE IF NOT EXISTS mem_scope(path TEXT PRIMARY KEY, owner TEXT, session TEXT)",
  // per-upload scope + expiry for DIRECT doc/blob rows (multis M3 R2 + R5). Distinct from `mem_scope`:
  //   - `mem_scope` is instance IDENTITY (owner/session, derived from the Store) on fact/episode rows.
  //   - `doc_scope` is per-upload CONTENT TAGS (scope/expires_at, passed at ingest) on direct docs/blobs.
  // Both NULL = global / never-expire. A SIBLING table (the `docs` FTS5 table takes no ALTER ADD COLUMN),
  // mirroring `mem_scope`/`mem_meta`: a `CREATE TABLE IF NOT EXISTS` is the most additive migration (old
  // DBs gain an empty table; a missing row LEFT-JOINs to NULL/NULL = global/forever = byte-identical to
  // pre-R2 recall). `scope` fences one customer's uploads from another's (recall filter = `scope ∪ NULL`,
  // so the global kb stays visible from any chat); `expires_at` (epoch ms) excludes expired rows from
  // recall/get and is reclaimed by `purge()`. File-indexed (`source='file'`) rows never get a row here —
  // they are always global/forever, which is exactly the LEFT-JOIN-NULL default.
  "CREATE TABLE IF NOT EXISTS doc_scope(path TEXT PRIMARY KEY, scope TEXT, expires_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS doc_scope_expires ON doc_scope(expires_at)",
  // written-memory FTS (slice 7b, §5.1): facts/episodes live in their OWN porter-stemmed table, so
  // "refund policy" finds a fact saying "refunds…" (short prose has no redundancy to absorb FTS5's
  // lack of stemming — measured morph MRR 0.000 → 0.722 with porter, exact unchanged). code/doc stay
  // on the unstemmed `docs` table — porter-everywhere was measured and REJECTED (in code, word-forms
  // are distinct symbols; aurora gate broke, gitdone P@1 collapsed). Kinds never share a ranking, so
  // a kind routes to exactly one table and BM25 scores never merge across the two. Direct-written
  // `doc` rows stay in `docs` (one kind = one ranking domain).
  "CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(path UNINDEXED, kind UNINDEXED, format UNINDEXED, provenance UNINDEXED, occurred_at UNINDEXED, body, tokenize='porter unicode61')",
  // chunk-level edit history (slice 5a, §14 #4 view #3): one row each time index() OBSERVES a chunk's
  // body change — added or modified vs the previously-stored `nodes.body`. This is litectx's own
  // witnessed edit stream (the edit-bind POC validated next-use prediction off it, AUC 0.75–0.98).
  // It powers recentActivity() — "what was I working on" — and NOTHING else: the edit→recall re-rank
  // ships at zero (falsified repo-dependent, §14 #4 view #1), so this never touches search ranking.
  // A cold build records nothing (a first/`force` index is not editing). Append-only, many rows per
  // chunk; read recency-windowed. `symbol` nullable (same chunk identity as `nodes`).
  "CREATE TABLE IF NOT EXISTS chunk_edits(id INTEGER PRIMARY KEY, path TEXT NOT NULL, symbol TEXT, kind TEXT NOT NULL, ts INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS chunk_edits_ts ON chunk_edits(ts)",
  // keyed agent-context store (R-C4 restorable compression): parked payloads the agent drops from its
  // window and rehydrates by exact id. DELIBERATELY a plain table, not fts5 — a stash is never searched
  // (so it can't pollute recall, on ANY kind) and never pruned (so restore always works); it is reached
  // only by id via getItem and lives until an explicit forget. First citizen of the "agent context"
  // domain (keyed working-set), kept separate from the searchable memory core (mem/docs). Future R-W3
  // (session state) / R-W4 (notes) get their OWN tables; R-I3 summary / R-I1 scope are a cheap nullable
  // ALTER on this plain table if/when built — not reserved here (we don't speculate; AGENT_RULES).
  "CREATE TABLE IF NOT EXISTS stash(path TEXT PRIMARY KEY, text TEXT NOT NULL, created_at INTEGER NOT NULL)",
  // byte-exact store for non-chunkable uploads (multis M3 R3): csv/xlsx/xml/code/binary that the consumer
  // wants kept and retrievable but NOT body-searched. The bytes live here as a BLOB (POC-proven byte-exact
  // round-trip; a TEXT column mangles non-UTF8 — the column type is load-bearing). Each blob ALSO gets a
  // direct `docs` row whose FTS `body` is ONLY the filename, so recall finds it by name without parsing the
  // bytes; `get(id)` returns the original bytes from here. 1:1 with the `docs` row by `path`; dropped by
  // `forgetMemory`/`purge` alongside it. Distinct from `stash` (parked agent payloads, reached only by id,
  // never recallable): a blob IS recallable by filename and carries scope/expiry like any uploaded doc.
  "CREATE TABLE IF NOT EXISTS blobs(path TEXT PRIMARY KEY, bytes BLOB NOT NULL, filename TEXT NOT NULL)",
];

/** Memory kinds stored in the stemmed `mem` table; everything else rides `docs`. */
export const MEM_KINDS = new Set(["fact", "episode"]);

/**
 * Reconstruct a stored embedding BLOB into a copied, 4-byte-aligned Float32Array — the copy means it
 * never aliases SQLite's internal buffer.
 * @param {Buffer} buf
 * @returns {Float32Array}
 */
function blobToVec(buf) {
  const u8 = Uint8Array.from(buf);
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
}

export class Store {
  /**
   * @param {string} dbPath path to the SQLite file, or ":memory:"
   * @param {{ owner?: string|null, session?: string|null }} [scope]  this instance's identity (§4.4):
   *   `owner` = the actor (NULL = unscoped → sees all owners); `session` = the run (NULL = durable →
   *   sees all sessions). Drives both the write-time scope of new memory and the recall read filter.
   */
  constructor(dbPath, scope = {}) {
    /** @type {string|null} */
    this.owner = scope.owner ?? null;
    /** @type {string|null} */
    this.session = scope.session ?? null;
    /** @type {any} */
    this.db = new Database(dbPath);
    // Write/throughput pragmas (aurora-borrowed; ledger §12). The index is rebuildable, so
    // synchronous=NORMAL (durable under WAL, loses at most the last txn on power loss) is the
    // right trade. No-ops on :memory:, harmless there.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("cache_size = -8000"); // ~8 MB page cache (negative = KiB)
    this.db.pragma("mmap_size = 268435456"); // 256 MB memory-mapped reads
    this.db.pragma("temp_store = MEMORY");
    for (const stmt of SCHEMA) this.db.exec(stmt);
    // self-heal pre-release schemas (CREATE IF NOT EXISTS leaves stale tables in place, and the
    // first INSERT would crash). The rule: an upgrade that can preserve data does; one that can't
    // only ever drops re-indexable data. A `docs` table without `source` predates the write path
    // (≤ 0.1.0) — it cannot contain written memory, only files `index()` rebuilds → reset. A
    // `recall_log` without `symbol` (pre-slice-8) or `action` (pre-slice-9) is column-additive →
    // ALTER, log preserved (pre-existing rows are all real recalls, so 'recall' is the true default).
    const docsCols = /** @type {{ name: string }[]} */ (this.db.pragma("table_info(docs)"));
    if (!docsCols.some((c) => c.name === "source")) this.reset();
    else {
      const logCols = /** @type {{ name: string }[]} */ (this.db.pragma("table_info(recall_log)"));
      if (!logCols.some((c) => c.name === "symbol")) this.db.exec("ALTER TABLE recall_log ADD COLUMN symbol TEXT");
      if (!logCols.some((c) => c.name === "action")) this.db.exec("ALTER TABLE recall_log ADD COLUMN action TEXT NOT NULL DEFAULT 'recall'");
    }
  }

  /**
   * Clear all FILE-sourced data, preserving written memory and the audit log (slice 9 validation
   * fix; used by `index({ force: true })`). A force pass re-reads every file from disk — so file
   * rows, chunks, edges, git metadata, and file embeddings are all re-derivable and dropped. What
   * is NOT re-derivable is never touched: written memory (`mem`, `mem_text`, direct `docs` rows,
   * their embeddings — no file behind them) and `recall_log` (append-only demand history). This is
   * the "survives every index() pass" contract (§3.2) extended to its last gap: `force: true` used
   * to call `reset()` and silently destroy every fact. Written embeddings survive because the
   * subquery scopes the delete to `file_index` keys — written rows are never in `file_index`.
   */
  clearIndexed() {
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM file_embeddings WHERE path IN (SELECT path FROM file_index)"); // before file_index is cleared
      this.db.exec("DELETE FROM docs WHERE source = 'file'");
      this.db.exec("DELETE FROM file_index");
      this.db.exec("DELETE FROM nodes");
      this.db.exec("DELETE FROM edges");
      this.db.exec("DELETE FROM git_sig");
    });
    tx();
  }

  /** Drop and recreate everything (the ≤0.1.0 self-heal rebuild — such a db predates the write path, so nothing unrecoverable exists). */
  reset() {
    this.db.exec("DROP TABLE IF EXISTS docs");
    this.db.exec("DROP TABLE IF EXISTS file_index");
    this.db.exec("DROP TABLE IF EXISTS nodes");
    this.db.exec("DROP TABLE IF EXISTS edges");
    this.db.exec("DROP TABLE IF EXISTS git_sig");
    this.db.exec("DROP TABLE IF EXISTS file_embeddings");
    this.db.exec("DROP TABLE IF EXISTS recall_log");
    this.db.exec("DROP TABLE IF EXISTS mem");
    this.db.exec("DROP TABLE IF EXISTS mem_text");
    this.db.exec("DROP TABLE IF EXISTS doc_scope");
    this.db.exec("DROP TABLE IF EXISTS blobs");
    for (const stmt of SCHEMA) this.db.exec(stmt);
  }

  /**
   * The previously-indexed state, for incremental diffing.
   * @returns {Map<string, { hash: string, mtime: number, size: number }>}
   */
  loadIndex() {
    /** @type {Map<string, { hash: string, mtime: number, size: number }>} */
    const map = new Map();
    const rows = /** @type {{ path: string, content_hash: string, mtime: number, size: number }[]} */ (
      this.db.prepare("SELECT path, content_hash, mtime, size FROM file_index").all()
    );
    for (const r of rows) map.set(r.path, { hash: r.content_hash, mtime: r.mtime, size: r.size });
    return map;
  }

  /**
   * Apply an incremental change set atomically: drop deleted files, (re)insert changed
   * ones, and refresh mtimes for files whose content was unchanged.
   * @param {Changes} changes
   * @param {number} indexedAt  epoch millis to stamp on touched rows
   * @param {boolean} [recordEdits=false]  log per-chunk body changes to `chunk_edits` (slice 5a). Off
   *   for a cold/`force` build (mass insert isn't editing); on for incremental passes — see index().
   */
  applyChanges({ upserts, touch, deletes }, indexedAt, recordEdits = false) {
    const delDoc = this.db.prepare("DELETE FROM docs WHERE path = ?");
    const delIdx = this.db.prepare("DELETE FROM file_index WHERE path = ?");
    // indexed files are always source='file' with no provenance/occurred_at (those are write-path
    // metadata — slice 7 §3.2). Written memory uses a separate insert path (`writeMemory`).
    const insDoc = this.db.prepare(
      "INSERT INTO docs(path, kind, format, source, provenance, occurred_at, body) " +
        "VALUES (@path, @kind, @format, 'file', NULL, NULL, @body)"
    );
    const upIdx = this.db.prepare(
      "INSERT INTO file_index(path, content_hash, mtime, size, indexed_at) VALUES (@path, @hash, @mtime, @size, @indexed_at) " +
        "ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, mtime = excluded.mtime, size = excluded.size, indexed_at = excluded.indexed_at"
    );
    const touchIdx = this.db.prepare("UPDATE file_index SET mtime = @mtime WHERE path = @path");
    const delNodes = this.db.prepare("DELETE FROM nodes WHERE path = ?");
    const insNode = this.db.prepare(
      "INSERT INTO nodes(path, kind, format, symbol, node_type, start_line, end_line, body) " +
        "VALUES (@path, @kind, @format, @symbol, @node_type, @start_line, @end_line, @body)"
    );
    // slice 5a: a chunk is "edited" when its (symbol, body) is not among the file's prior nodes —
    // covers both a modified body and a newly-added chunk. `prevNodes` is read BEFORE delNodes drops
    // them (below). `chunkKey` collapses null symbols to "" so identity matches the stored row.
    const prevNodes = this.db.prepare("SELECT symbol, body FROM nodes WHERE path = ?");
    const insEdit = this.db.prepare("INSERT INTO chunk_edits(path, symbol, kind, ts) VALUES (@path, @symbol, @kind, @ts)");
    const chunkKey = (/** @type {string|null} */ symbol, /** @type {string} */ body) => `${symbol ?? ""}\0${body}`;
    // import edges are owned by their source file: refreshed when the importer is re-indexed,
    // and on delete dropped from BOTH ends so no edge dangles to a removed file.
    const delEdgesOf = this.db.prepare("DELETE FROM edges WHERE src_path = ? OR dst_path = ?");
    const delEdgesSrc = this.db.prepare("DELETE FROM edges WHERE type = 'import' AND src_path = ?");
    const insEdge = this.db.prepare("INSERT INTO edges(type, src_path, dst_path) VALUES ('import', @src, @dst)");
    const delGit = this.db.prepare("DELETE FROM git_sig WHERE path = ?");
    const upGit = this.db.prepare(
      "INSERT INTO git_sig(path, commits, last_commit) VALUES (@path, @commits, @last) " +
        "ON CONFLICT(path) DO UPDATE SET commits = excluded.commits, last_commit = excluded.last_commit"
    );
    const delEmb = this.db.prepare("DELETE FROM file_embeddings WHERE path = ?");
    const upEmb = this.db.prepare(
      "INSERT INTO file_embeddings(path, dim, vec) VALUES (@path, @dim, @vec) " +
        "ON CONFLICT(path) DO UPDATE SET dim = excluded.dim, vec = excluded.vec"
    );

    const tx = this.db.transaction(() => {
      for (const p of deletes) {
        delDoc.run(p);
        delIdx.run(p);
        delNodes.run(p);
        delEdgesOf.run(p, p);
        delGit.run(p);
        delEmb.run(p);
      }
      for (const u of upserts) {
        // slice 5a: snapshot prior chunk identities before they're dropped, so the node insert below
        // can tell which chunks are new/modified this pass. Only when recording (incremental passes).
        const prevKeys = recordEdits
          ? new Set(
              /** @type {{ symbol: string|null, body: string }[]} */ (prevNodes.all(u.path)).map((r) => chunkKey(r.symbol, r.body))
            )
          : null;
        delDoc.run(u.path); // replace any prior row for this path
        delNodes.run(u.path);
        delEdgesSrc.run(u.path); // this file's outgoing import edges are about to be re-derived
        // code-aware FTS body (§5 mechanism 3): identifier-split + path + symbol names folded
        // in by `indexBody`. Symbol names (already in body) repeated as `extra` so a file's own
        // declarations get a small term-frequency lift over names it merely references.
        const extra = /** @type {string[]} */ ((u.nodes ?? []).map((c) => c.symbol).filter(Boolean));
        insDoc.run({ path: u.path, kind: u.kind, format: u.format, body: indexBody({ path: u.path, body: u.body, extra }) });
        upIdx.run({ path: u.path, hash: u.hash, mtime: u.mtime, size: u.size, indexed_at: indexedAt });
        for (const c of u.nodes ?? []) {
          insNode.run({ path: u.path, kind: u.kind, format: u.format, symbol: c.symbol, node_type: c.nodeType, start_line: c.startLine, end_line: c.endLine, body: c.text });
          // slice 5a: a chunk whose (symbol, body) wasn't in the prior set is new or modified — record it.
          if (prevKeys && !prevKeys.has(chunkKey(c.symbol, c.text))) {
            insEdit.run({ path: u.path, symbol: c.symbol, kind: u.kind, ts: indexedAt });
          }
        }
        for (const dst of u.edges ?? []) insEdge.run({ src: u.path, dst });
        // git activity grounding (gitsig.js). Store a row only when the file has commit history;
        // no history (non-git tree, or a tracked-but-uncommitted file) → no row → recall `git: null`.
        if (u.git) upGit.run({ path: u.path, commits: u.git.commits, last: u.git.lastCommit });
        else delGit.run(u.path);
        // embeddings tier (slice 6): store the file's float32 vector as a BLOB when present. Computed
        // only for changed files (incremental) — unchanged files keep their stored vector untouched.
        if (u.embedding) upEmb.run({ path: u.path, dim: u.embedding.length, vec: Buffer.from(u.embedding.buffer, u.embedding.byteOffset, u.embedding.byteLength) });
        else delEmb.run(u.path);
      }
      for (const t of touch) touchIdx.run({ path: t.path, mtime: t.mtime });
    });
    tx();
  }

  /**
   * Write one directly-authored memory — a fact/episode/doc with no file behind it (slice 7, §3.2).
   * Upsert by `id` (the row's `path`/key): replaces any prior **direct** row with the same id, and
   * **never** clobbers an indexed (`source='file'`) row. Always `source='direct'`, so the incremental
   * index sweep — whose `deletes` come only from `file_index` keys — structurally can't touch it.
   * Stored **whole** (no chunking); the FTS body is identifier-split like any other (`indexBody`).
   * `meta` (RT-3 #3) is an opaque JSON string stored verbatim in the sealed `mem_meta` table and
   * never indexed; `null`/omitted clears any prior meta (the row reflects the latest write, like
   * `mem_text`). `scope`/`expiresAt` (multis M3 R2/R5) tag a DIRECT `doc` row in the `doc_scope`
   * sidecar — both NULL = global/forever; ignored for `fact`/`episode` (those scope via `mem_scope`).
   * @param {{ id: string, text: string, kind: string, format: string, provenance: string|null, occurredAt: number|null, meta?: string|null, embedding?: Float32Array, scope?: string|null, expiresAt?: number|null }} m
   */
  writeMemory(m) {
    const tx = this.db.transaction(() => {
      // route by kind (§5.1): fact/episode → the stemmed `mem` table; direct `doc` → `docs`
      // (one kind = one ranking domain, so a direct FAQ ranks against file docs, unstemmed).
      if (MEM_KINDS.has(m.kind)) {
        this.db.prepare("DELETE FROM mem WHERE path = ?").run(m.id);
        this.db
          .prepare("INSERT INTO mem(path, kind, format, provenance, occurred_at, body) VALUES (@path, @kind, @format, @provenance, @occurred_at, @body)")
          .run({ path: m.id, kind: m.kind, format: m.format, provenance: m.provenance, occurred_at: m.occurredAt, body: indexBody({ path: m.id, body: m.text }) });
        // scope (§4.4): scope is runtime IDENTITY (who wrote it, in which run), not caller content — so
        // it comes from THIS Store instance, not `m`. `fact` is owner-scoped (durable, cross-session);
        // `episode` adds the session (volatile, own-run). Refresh by delete-then-insert (mirrors meta);
        // a row only when actually scoped — NULL/NULL is identical to absent under the recall LEFT JOIN.
        const sSession = m.kind === "episode" ? this.session : null;
        this.db.prepare("DELETE FROM mem_scope WHERE path = ?").run(m.id);
        if (this.owner != null || sSession != null) {
          this.db
            .prepare("INSERT INTO mem_scope(path, owner, session) VALUES (?, ?, ?)")
            .run(m.id, this.owner, sSession);
        }
      } else {
        this.db.prepare("DELETE FROM docs WHERE path = ? AND source = 'direct'").run(m.id);
        this.db
          .prepare(
            "INSERT INTO docs(path, kind, format, source, provenance, occurred_at, body) " +
              "VALUES (@path, @kind, @format, 'direct', @provenance, @occurred_at, @body)"
          )
          .run({ path: m.id, kind: m.kind, format: m.format, provenance: m.provenance, occurred_at: m.occurredAt, body: indexBody({ path: m.id, body: m.text }) });
        // R2/R5 per-upload sidecar: refresh by delete-then-insert (mirrors mem_scope); a row only when
        // actually scoped/expiring — NULL/NULL is identical to absent under the recall LEFT JOIN.
        this.setDocScope(m.id, m.scope ?? null, m.expiresAt ?? null);
      }
      // raw text alongside the searchable surface (slice 9): the FTS body is processed
      // (indexBody) and there is no file behind a written row, so this is the only copy
      // `getItem` can hand back verbatim.
      this.db
        .prepare("INSERT INTO mem_text(path, text) VALUES (@path, @text) ON CONFLICT(path) DO UPDATE SET text = excluded.text")
        .run({ path: m.id, text: m.text });
      // sealed opaque metadata (RT-3 #3): upsert when supplied, else clear any prior — the row tracks
      // the latest write. Stored verbatim, read by no FTS/ranking path.
      if (m.meta != null) {
        this.db
          .prepare("INSERT INTO mem_meta(path, meta) VALUES (@path, @meta) ON CONFLICT(path) DO UPDATE SET meta = excluded.meta")
          .run({ path: m.id, meta: m.meta });
      } else {
        this.db.prepare("DELETE FROM mem_meta WHERE path = ?").run(m.id);
      }
      if (m.embedding) {
        this.db
          .prepare("INSERT INTO file_embeddings(path, dim, vec) VALUES (@path, @dim, @vec) ON CONFLICT(path) DO UPDATE SET dim = excluded.dim, vec = excluded.vec")
          .run({ path: m.id, dim: m.embedding.length, vec: Buffer.from(m.embedding.buffer, m.embedding.byteOffset, m.embedding.byteLength) });
      } else {
        this.db.prepare("DELETE FROM file_embeddings WHERE path = ?").run(m.id);
      }
    });
    tx();
  }

  /**
   * Set (or clear) the per-upload scope/expiry of a direct doc/blob row (multis M3 R2/R5). Refresh by
   * delete-then-insert; a row is written ONLY when actually scoped or expiring, so NULL/NULL leaves no
   * row — identical to absent under the recall LEFT JOIN (byte-identical to pre-R2 behavior when unset).
   * @param {string} id @param {string|null} scope @param {number|null} expiresAt
   */
  setDocScope(id, scope, expiresAt) {
    this.db.prepare("DELETE FROM doc_scope WHERE path = ?").run(id);
    if (scope != null || expiresAt != null) {
      this.db.prepare("INSERT INTO doc_scope(path, scope, expires_at) VALUES (?, ?, ?)").run(id, scope, expiresAt);
    }
  }

  /**
   * Store an uploaded file BYTE-EXACT (multis M3 R3) — the non-chunkable ingest path. The bytes go to
   * the `blobs` BLOB column verbatim (POC-proven round-trip; TEXT would mangle non-UTF8); a direct
   * `docs` row carries ONLY the filename as its FTS body, so recall finds the file by NAME without ever
   * parsing or chunking the bytes. `get(id)` returns the original bytes. Upsert by `id` (drops any prior
   * direct row + blob for that id first). Scope/expiry ride the same `doc_scope` sidecar as docs; `meta`
   * is the sealed `mem_meta` passthrough (small tags only). Never embedded (bytes aren't meaning-searchable).
   * @param {{ id: string, bytes: Uint8Array, filename: string, format: string, meta?: string|null, scope?: string|null, expiresAt?: number|null }} b
   */
  writeBlob(b) {
    const bytes = Buffer.isBuffer(b.bytes) ? b.bytes : Buffer.from(b.bytes);
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM docs WHERE path = ? AND source = 'direct'").run(b.id);
      // FTS body = the FILENAME only (folded through indexBody like any other body); never the bytes.
      this.db
        .prepare(
          "INSERT INTO docs(path, kind, format, source, provenance, occurred_at, body) " +
            "VALUES (@path, 'doc', @format, 'direct', NULL, NULL, @body)"
        )
        .run({ path: b.id, format: b.format, body: indexBody({ path: b.id, body: b.filename }) });
      this.db
        .prepare("INSERT INTO blobs(path, bytes, filename) VALUES (@path, @bytes, @filename) ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes, filename = excluded.filename")
        .run({ path: b.id, bytes, filename: b.filename });
      this.setDocScope(b.id, b.scope ?? null, b.expiresAt ?? null);
      if (b.meta != null) {
        this.db.prepare("INSERT INTO mem_meta(path, meta) VALUES (@path, @meta) ON CONFLICT(path) DO UPDATE SET meta = excluded.meta").run({ path: b.id, meta: b.meta });
      } else {
        this.db.prepare("DELETE FROM mem_meta WHERE path = ?").run(b.id);
      }
    });
    tx();
  }

  /**
   * Park a payload in the keyed agent-context store (R-C4 restorable compression). Unlike written
   * memory, a stash is NEVER indexed — it goes into no FTS table, so recall can't surface it on any
   * kind — and NEVER pruned; it is addressable only by exact `id` (via {@link getItem}) and lives
   * until an explicit {@link forgetMemory}. The durable half of "drop the payload, keep a handle":
   * the agent clears a large tool result from its window and rehydrates it by id on demand. Upsert
   * by `id`. Deletion is {@link evictStash} (NOT `forgetMemory`, which is memory-only).
   * @param {{ id: string, text: string, createdAt: number }} s
   */
  writeStash(s) {
    this.db
      .prepare("INSERT INTO stash(path, text, created_at) VALUES (@path, @text, @created_at) ON CONFLICT(path) DO UPDATE SET text = excluded.text, created_at = excluded.created_at")
      .run({ path: s.id, text: s.text, created_at: s.createdAt });
  }

  /**
   * Peek a stashed payload (R-I3 handle / lazy-load): a lightweight head+tail preview of a parked blob
   * WITHOUT rehydrating it. Returns the `head` (first {@link STASH_HEAD} chars), the `tail` (last
   * {@link STASH_TAIL} chars — empty unless the middle is actually elided), the true byte `bytes`, and
   * the parked-at timestamp — all computed in SQL via first-N / last-N `substr` + `length(CAST(text AS
   * BLOB))`. The win is the BOUNDED RESULT: only ~head+tail bytes cross back to the caller, so the
   * payload stays out of its context/token budget (the point of a lazy-load handle). It is *not* a
   * DB-time win — SQLite reads the full column to slice it, so peek's compute scales with payload size.
   * Head+tail because a payload's conclusion (exit code, failing frame, closing structure) lives at the
   * end. `bytes` is the OCTET length, not `length(text)` (chars — wrong for multibyte). `truncated`
   * flags that the preview omits a middle span; the full body is one {@link getItem} away. Stash-only —
   * recall owns ranked retrieval over memory. Null for an unknown id.
   * @param {string} id
   * @returns {{ id: string, bytes: number, head: string, tail: string, createdAt: number, truncated: boolean } | null}
   */
  peekStash(id) {
    const r = /** @type {{ bytes: number, chars: number, head: string, tail: string, created_at: number } | undefined} */ (
      this.db
        .prepare("SELECT length(CAST(text AS BLOB)) AS bytes, length(text) AS chars, substr(text, 1, ?) AS head, substr(text, ?) AS tail, created_at FROM stash WHERE path = ?")
        .get(STASH_HEAD, -STASH_TAIL, id)
    );
    if (!r) return null;
    // tail only when a genuine middle gap exists — otherwise head already holds the whole payload and a
    // tail would just duplicate its end. truncated = the head alone misses content (chars beyond HEAD).
    const gapped = r.chars > STASH_HEAD + STASH_TAIL;
    return { id, bytes: r.bytes, head: r.head, tail: gapped ? r.tail : "", createdAt: r.created_at, truncated: r.chars > STASH_HEAD };
  }

  /**
   * Evict parked stash payloads (R-C4 housekeeping) — the stash deleter, split from {@link forgetMemory}
   * so a bulk age/size sweep can NEVER reach durable written memory: **only the `stash` table is touched.**
   * Exactly one selector per call: `{ id }` (one payload), `{ olderThan }` (epoch-ms floor — drop anything
   * parked before it, via `created_at <`), or `{ maxCount }` (keep the newest N by `created_at`, evict the
   * rest). Also cleans any `fetch` recall_log rows a {@link getItem} left on an evicted id (parity with the
   * old forget cascade). Returns rows removed. (Ties on `created_at` under `maxCount` keep an arbitrary
   * member of the tie — the *count* held is exact, which is all a janitor needs.)
   * @param {{ id?: string, olderThan?: number, maxCount?: number }} sel
   * @returns {number}
   */
  evictStash(sel) {
    /** @type {string} */ let where;
    /** @type {(string | number)[]} */ let params;
    if (sel.id != null) (where = "WHERE path = ?"), (params = [sel.id]);
    else if (sel.olderThan != null) (where = "WHERE created_at < ?"), (params = [sel.olderThan]);
    else if (sel.maxCount != null) (where = "WHERE path IN (SELECT path FROM stash ORDER BY created_at DESC LIMIT -1 OFFSET ?)"), (params = [sel.maxCount]);
    else throw new Error("evictStash: a selector is required (id, olderThan, or maxCount)");
    const tx = this.db.transaction(() => {
      const paths = /** @type {{ path: string }[]} */ (this.db.prepare(`SELECT path FROM stash ${where}`).all(...params)).map((r) => r.path);
      const removed = this.db.prepare(`DELETE FROM stash ${where}`).run(...params).changes;
      const delLog = this.db.prepare("DELETE FROM recall_log WHERE path = ?");
      for (const p of paths) delLog.run(p);
      return removed;
    });
    return tx();
  }

  /**
   * Forget directly-written memory — by `id`, or by query (`kind` and/or `provenance`) for bulk human
   * invalidation (§3.2). **Only ever removes `source='direct'` rows**, so an indexed file is never
   * touched. Cleans the row's raw text, embedding + recall-log alongside it. Returns rows removed.
   * @param {{ id?: string, idPrefix?: string, kind?: string, provenance?: string }} sel
   *   `idPrefix` matches a base id and all `<base>#<n>` rows under it — the clean-re-ingest handle
   *   for a multi-segment document ({@link LiteCtx#ingest}); still direct-rows-only.
   * @returns {number}
   */
  forgetMemory(sel) {
    /** @type {string[]} */
    const clauses = [];
    /** @type {Record<string, string>} */
    const params = {};
    if (sel.id != null) (clauses.push("path = @id"), (params.id = sel.id));
    if (sel.idPrefix != null) {
      // the base id itself OR any `<base>#<segment>` row. Escape LIKE metacharacters in the base.
      clauses.push("(path = @idExact OR path LIKE @idLike ESCAPE '\\')");
      params.idExact = sel.idPrefix;
      params.idLike = sel.idPrefix.replace(/[\\%_]/g, "\\$&") + "#%";
    }
    if (sel.kind != null) (clauses.push("kind = @kind"), (params.kind = sel.kind));
    if (sel.provenance != null) (clauses.push("provenance = @provenance"), (params.provenance = sel.provenance));
    // Refuse an empty selector. With no clause the `mem` condition would degrade to `1=1` and wipe
    // ALL written memory — a destructive default no caller should be able to ask for by omission.
    // The public `forget()` wrapper already guards this; enforcing it here too means a bare selector
    // is unexpressible at the store layer (defense in depth — the only "delete everything" is the
    // explicit `reset()`).
    if (clauses.length === 0) {
      throw new Error("forgetMemory: a selector is required (id, kind, and/or provenance) — refusing to delete all memory");
    }
    // both written-memory homes (§5.1): the stemmed `mem` table (facts/episodes — all direct by
    // construction) and `docs` rows guarded by source='direct' (directly-written docs only).
    const docsCond = ["source = 'direct'", ...clauses].join(" AND ");
    const memCond = clauses.join(" AND ");
    const tx = this.db.transaction(() => {
      const paths = [
        .../** @type {{ path: string }[]} */ (this.db.prepare(`SELECT path FROM docs WHERE ${docsCond}`).all(params)),
        .../** @type {{ path: string }[]} */ (this.db.prepare(`SELECT path FROM mem WHERE ${memCond}`).all(params)),
      ].map((r) => r.path);
      const removed =
        this.db.prepare(`DELETE FROM docs WHERE ${docsCond}`).run(params).changes +
        this.db.prepare(`DELETE FROM mem WHERE ${memCond}`).run(params).changes;
      // NB: `forget` is MEMORY-ONLY. Stash deletion lives in {@link evictStash} (R-C4 housekeeping),
      // split out so a bulk age/size sweep can never reach a durable fact — see §10.5 / CE-PRD R-G7.
      const delText = this.db.prepare("DELETE FROM mem_text WHERE path = ?");
      const delMeta = this.db.prepare("DELETE FROM mem_meta WHERE path = ?");
      const delScope = this.db.prepare("DELETE FROM mem_scope WHERE path = ?");
      const delDocScope = this.db.prepare("DELETE FROM doc_scope WHERE path = ?"); // R2/R5 sidecar
      const delBlob = this.db.prepare("DELETE FROM blobs WHERE path = ?"); // R3 bytes (forget reclaims them)
      const delEmb = this.db.prepare("DELETE FROM file_embeddings WHERE path = ?");
      const delLog = this.db.prepare("DELETE FROM recall_log WHERE path = ?");
      for (const p of paths) (delText.run(p), delMeta.run(p), delScope.run(p), delDocScope.run(p), delBlob.run(p), delEmb.run(p), delLog.run(p));
      return removed;
    });
    return tx();
  }

  /**
   * Reclaim expired direct doc/blob rows (multis M3 R5) — the retention sweep's mechanism (the consumer
   * owns the schedule; litectx owns the delete). Drops every row whose `doc_scope.expires_at <= now`
   * across `docs` + `doc_scope` + `blobs` + `mem_text`/`mem_meta` + embeddings + `recall_log`, so a
   * single store leaves NO orphaned bytes. Recall/get already EXCLUDE expired rows live (so a row is
   * invisible the instant it expires, before any purge); `purge` is what actually frees the storage.
   * Touches only rows with a non-NULL `expires_at` that has passed — `null`-expiry (keep-forever) and
   * file-indexed rows are never reached. Returns rows removed.
   * @param {number} now  epoch ms — the cutoff; rows with `expires_at <= now` are reclaimed
   * @returns {number}
   */
  purge(now) {
    const tx = this.db.transaction(() => {
      const dead = /** @type {{ path: string }[]} */ (
        this.db.prepare("SELECT path FROM doc_scope WHERE expires_at IS NOT NULL AND expires_at <= ?").all(now)
      ).map((r) => r.path);
      if (!dead.length) return 0;
      const delDoc = this.db.prepare("DELETE FROM docs WHERE path = ? AND source = 'direct'");
      const delDocScope = this.db.prepare("DELETE FROM doc_scope WHERE path = ?");
      const delBlob = this.db.prepare("DELETE FROM blobs WHERE path = ?");
      const delText = this.db.prepare("DELETE FROM mem_text WHERE path = ?");
      const delMeta = this.db.prepare("DELETE FROM mem_meta WHERE path = ?");
      const delEmb = this.db.prepare("DELETE FROM file_embeddings WHERE path = ?");
      const delLog = this.db.prepare("DELETE FROM recall_log WHERE path = ?");
      for (const p of dead) (delDoc.run(p), delDocScope.run(p), delBlob.run(p), delText.run(p), delMeta.run(p), delEmb.run(p), delLog.run(p));
      return dead.length;
    });
    return tx();
  }

  /**
   * Append recall hits to the audit log (slice 7, §3.2) — the genuine access log §4's base-level tier
   * will later score. v1 records, does not rank. One row per hit. `action` tags the signal type:
   * 'recall' = ranked retrieval (real demand); 'fetch' = a get(id) body read (tagged weak signal —
   * excluded from demand reads, see the schema comment).
   * @param {{ path: string, kind: string, chunk?: ChunkRef | null }[]} hits
   * @param {number} ts  epoch ms
   * @param {string} [action='recall']
   */
  logRecall(hits, ts, action = "recall") {
    if (!hits.length) return;
    const ins = this.db.prepare("INSERT INTO recall_log(path, kind, symbol, action, ts) VALUES (@path, @kind, @symbol, @action, @ts)");
    const tx = this.db.transaction(() => {
      for (const h of hits) ins.run({ path: h.path, kind: h.kind, symbol: h.chunk?.symbol ?? null, action, ts });
    });
    tx();
  }

  /** @returns {number} total stored items — indexed documents + written memory (both FTS tables) */
  count() {
    return (
      /** @type {{ n: number }} */ (this.db.prepare("SELECT count(*) AS n FROM docs").get()).n +
      /** @type {{ n: number }} */ (this.db.prepare("SELECT count(*) AS n FROM mem").get()).n
    );
  }

  /** @returns {number} number of symbol/section chunks across all files */
  nodeCount() {
    return /** @type {{ n: number }} */ (this.db.prepare("SELECT count(*) AS n FROM nodes").get()).n;
  }

  /**
   * How many times `path` has been recalled (slice 7 audit log, §3.2). Feeds HITL review: an
   * agent-asserted fact whose count crosses the review threshold is a promotion candidate.
   * Counts `action='recall'` rows only — a fetch is not demand (the fetch-toll, slice 9).
   * @param {string} path
   * @returns {number}
   */
  recallCount(path) {
    return /** @type {{ n: number }} */ (
      this.db.prepare("SELECT count(*) AS n FROM recall_log WHERE path = ? AND action = 'recall'").get(path)
    ).n;
  }

  /**
   * HITL review candidates (§3.2): agent-asserted facts whose recall-hit count has crossed
   * `threshold` — the set a human is asked to validate (→ re-`remember` as `by:'human'`) or
   * invalidate (→ `forget`). A plain query over provenance + the recall log. Acting on a candidate
   * removes it from the set (promotion flips provenance off `'agent'`; forget deletes the row), so no
   * separate "reviewed" flag is needed. The count gates REVIEW, not ranking — not a feedback loop.
   * @param {number} [threshold=5]
   * @returns {{ path: string, hits: number }[]}
   */
  reviewCandidates(threshold = 5) {
    // facts live in the stemmed `mem` table (§5.1); all mem rows are direct-written by construction.
    // recall rows only: fetches must not push a fact toward review (the fetch-toll, slice 9).
    return /** @type {{ path: string, hits: number }[]} */ (
      this.db
        .prepare(
          "SELECT m.path AS path, count(r.id) AS hits FROM mem m JOIN recall_log r ON r.path = m.path " +
            "WHERE m.kind = 'fact' AND m.provenance = 'agent' AND r.action = 'recall' " +
            "GROUP BY m.path HAVING hits >= ? ORDER BY hits DESC, m.path"
        )
        .all(threshold)
    );
  }

  /**
   * Episode promotion candidates (slice 5b, §14 #4 view #4): agent-written `episode`s recalled at
   * least `threshold` times whose `occurred_at` falls in the rolling active window `[since, now]`
   * (older episodes have decayed out of the active set). Mirrors {@link reviewCandidates} exactly —
   * same `recall_log` demand join, `'recall'`-only, same `{ path, hits }` shape — with two deltas:
   * `kind='episode'` (not `'fact'`) and the `occurred_at >= since` window gate. The count gates
   * DISTILLATION, never ranking (promotion changes an episode's downstream kind/trust, never its
   * recall score — §14 #4). Threshold runs higher than facts' review (10 vs 5): episodes are noisier
   * and more numerous.
   * @param {{ threshold: number, since: number }} opts  `threshold` = min recall hits; `since` =
   *   `occurred_at` floor (epoch ms) — the rolling-window cutoff.
   * @returns {{ path: string, hits: number }[]}
   */
  promotionCandidates({ threshold, since }) {
    return /** @type {{ path: string, hits: number }[]} */ (
      this.db
        .prepare(
          "SELECT m.path AS path, count(r.id) AS hits FROM mem m JOIN recall_log r ON r.path = m.path " +
            "WHERE m.kind = 'episode' AND m.provenance = 'agent' AND m.occurred_at >= @since AND r.action = 'recall' " +
            "GROUP BY m.path HAVING hits >= @threshold ORDER BY hits DESC, m.path"
        )
        .all({ since, threshold })
    );
  }

  /**
   * Drop episodes older than `before` (slice 5b ephemerality, §14 #4 view #4) — the agent scratchpad
   * is bounded by a rolling window: an episode that mattered was distilled into a durable `fact`
   * (never pruned), so deleting the raw episode past the window loses nothing earned. Cascades to
   * `mem_text` / embeddings / `recall_log` like {@link forgetMemory}. Called on each episode write
   * (self-bounding — only episode writes grow the set, so that is where it's trimmed; no cron). Only
   * ever touches `kind='episode'` rows. Returns rows removed.
   * @param {number} before  `occurred_at` floor (epoch ms); episodes strictly older are deleted
   * @returns {number}
   */
  pruneStaleEpisodes(before) {
    const tx = this.db.transaction(() => {
      const paths = /** @type {{ path: string }[]} */ (
        this.db.prepare("SELECT path FROM mem WHERE kind = 'episode' AND occurred_at < ?").all(before)
      ).map((r) => r.path);
      if (!paths.length) return 0;
      const removed = this.db.prepare("DELETE FROM mem WHERE kind = 'episode' AND occurred_at < ?").run(before).changes;
      const delText = this.db.prepare("DELETE FROM mem_text WHERE path = ?");
      const delMeta = this.db.prepare("DELETE FROM mem_meta WHERE path = ?");
      const delScope = this.db.prepare("DELETE FROM mem_scope WHERE path = ?");
      const delEmb = this.db.prepare("DELETE FROM file_embeddings WHERE path = ?");
      const delLog = this.db.prepare("DELETE FROM recall_log WHERE path = ?");
      for (const p of paths) (delText.run(p), delMeta.run(p), delScope.run(p), delEmb.run(p), delLog.run(p));
      return removed;
    });
    return tx();
  }

  /**
   * "What was I working on" (slice 5a, §14 #4 view #3): the chunks litectx witnessed edited most
   * recently, newest first, within `[since, now]`. Grouped per chunk (path + symbol): `lastEditedAt`
   * is the most recent edit, `edits` the number of distinct index passes (sessions) that changed it.
   * `edits` counts DISTINCT timestamps, not rows: a file's anonymous chunks (null symbol) collapse to
   * one per-file row, and counting passes — not chunks — keeps that row's count honest (one busy pass
   * = 1, not "however many nameless chunks moved"). Pure recency order (`edits` only breaks ties) — NO
   * activation, NO recall coupling: reads `chunk_edits`, never the ranking path (edit→recall re-rank
   * ships at zero, §14 #4).
   * @param {{ since: number, limit: number }} opts  `since` epoch ms (window floor); `limit` row cap
   * @returns {{ id: string, symbol: string|null, kind: string, lastEditedAt: number, edits: number }[]}
   */
  recentActivity({ since, limit }) {
    return /** @type {{ id: string, symbol: string|null, kind: string, lastEditedAt: number, edits: number }[]} */ (
      this.db
        .prepare(
          "SELECT path AS id, symbol, kind, max(ts) AS lastEditedAt, count(DISTINCT ts) AS edits FROM chunk_edits " +
            "WHERE ts >= ? GROUP BY path, symbol ORDER BY lastEditedAt DESC, edits DESC, path LIMIT ?"
        )
        .all(since, limit)
    );
  }

  /**
   * One stored item's full record by id — any id (slice 9): a written-memory id or an indexed
   * file's repo-relative path. Written rows carry their raw text (`mem_text`); file rows carry
   * `text: null` here — the caller reads the file from disk (the index is not a file cache).
   * Lookup order: `mem` (facts/episodes) → direct `docs` rows → file rows, so on the pathological
   * collision of a written id with a file path the written row wins (it has no other home; ids are
   * namespaced by convention). A pre-slice-9 written row with no `mem_text` falls back to its
   * stored FTS body — degraded (path tokens folded in) but preserved.
   *
   * A **blob** row (multis M3 R3) returns its original BYTES in `bytes` with `text: null` — the bytes,
   * never the filename, are the deliverable. Everything else returns `bytes: null`. When `now` (epoch
   * ms) is passed, an **expired** direct row (R5) returns `null` — fetch honors expiry exactly like recall.
   *
   * `scope` (multis M3 R2) fences the **direct handle** the same way `recall({scope})` fences discovery:
   * when set, a row tagged with a *different* scope returns `null` (a NULL-scope global row stays visible
   * to every scope; a fact/episode/file has no `doc_scope` row, so it is unaffected). This is what makes
   * "one customer never sees another's" hold for a *known/guessed* id, not only for search — bare
   * `getItem(id)` (no scope) is unchanged, so the existing `owner`/`session` fetch-by-id model is untouched.
   * `globalOnly` (multis M3 fail-closed) fetches the shared tier ONLY: a row with a non-null `doc_scope.scope`
   * returns null even though `scope` is null. It is how the facade serves a {@link GLOBAL} `get` — distinct
   * from a bare `getItem(id)` (scope null, globalOnly false), which stays unfenced (the legacy by-id model).
   * @param {string} id
   * @param {number} [now]  epoch ms; when set, a row whose `expires_at <= now` returns null (R5)
   * @param {string|null} [scope]  when set, a row whose `doc_scope.scope` is non-null and ≠ `scope` returns null (R2)
   * @param {boolean} [globalOnly]  when true, a row whose `doc_scope.scope` is non-null returns null (GLOBAL-only fetch)
   * @returns {{ path: string, kind: string, format: string, source: string, provenance: string|null, occurred_at: number|null, text: string|null, bytes: Buffer|null, meta: string|null } | null}
   */
  getItem(id, now, scope, globalOnly) {
    const row = /** @type {{ path: string, kind: string, format: string, source: string, provenance: string|null, occurred_at: number|null, body: string } | undefined} */ (
      this.db.prepare("SELECT path, kind, format, 'direct' AS source, provenance, occurred_at, body FROM mem WHERE path = ?").get(id) ??
        this.db
          .prepare("SELECT path, kind, format, source, provenance, occurred_at, body FROM docs WHERE path = ? ORDER BY (source = 'direct') DESC LIMIT 1")
          .get(id)
    );
    if (!row) {
      // stash fallback (R-C4): a parked payload lives in no FTS table, so the mem/docs lookups miss
      // it — rehydrate it by id from the keyed agent-context store. kind='stash' is the discriminator
      // only; it is absent from KINDS/MEM_KINDS, so recall never reaches it.
      const s = /** @type {{ text: string } | undefined} */ (this.db.prepare("SELECT text FROM stash WHERE path = ?").get(id));
      if (!s) return null;
      return { path: id, kind: "stash", format: "text", source: "direct", provenance: null, occurred_at: null, text: s.text, bytes: null, meta: null };
    }
    // R5 expiry + R2 scope-fenced fetch: one doc_scope lookup gates both (a fact/file has no row → neither
    // applies). expires_at <= now → gone (purge reclaims later); a non-null scope ≠ the reader's → not yours
    // (a NULL/global scope stays visible to all). Only runs when a caller actually asks (now/scope set).
    if (now != null || scope != null || globalOnly) {
      const ds = /** @type {{ scope: string|null, expires_at: number|null } | undefined} */ (
        this.db.prepare("SELECT scope, expires_at FROM doc_scope WHERE path = ?").get(id)
      );
      if (ds) {
        if (now != null && ds.expires_at != null && ds.expires_at <= now) return null;
        // GLOBAL fetch: only the shared tier (any tenant-scoped row is hidden). Tenant fetch: hide a
        // row tagged with a DIFFERENT non-null scope. A bare get (scope null, globalOnly false) is unfenced.
        if (globalOnly) {
          if (ds.scope != null) return null;
        } else if (scope != null && ds.scope != null && ds.scope !== scope) return null;
      }
    }
    let text = null;
    /** @type {Buffer|null} */
    let bytes = null;
    let meta = null;
    if (row.source === "direct") {
      // a blob: bytes are the deliverable, the docs body is only the filename → never return it as text.
      const blob = /** @type {{ bytes: Buffer } | undefined} */ (this.db.prepare("SELECT bytes FROM blobs WHERE path = ?").get(id));
      if (blob) bytes = blob.bytes;
      else {
        const raw = /** @type {{ text: string } | undefined} */ (this.db.prepare("SELECT text FROM mem_text WHERE path = ?").get(id));
        text = raw ? raw.text : row.body;
      }
      const mrow = /** @type {{ meta: string } | undefined} */ (this.db.prepare("SELECT meta FROM mem_meta WHERE path = ?").get(id));
      meta = mrow ? mrow.meta : null;
    }
    return { path: row.path, kind: row.kind, format: row.format, source: row.source, provenance: row.provenance, occurred_at: row.occurred_at, text, bytes, meta };
  }

  /**
   * Chunks for one file, in id order (insertion order).
   * @param {string} path
   * @returns {{ symbol: string|null, node_type: string, start_line: number, end_line: number }[]}
   */
  nodesForPath(path) {
    return /** @type {any} */ (
      this.db.prepare("SELECT symbol, node_type, start_line, end_line FROM nodes WHERE path = ? ORDER BY id").all(path)
    );
  }

  /**
   * The stored body of the chunk at (path, startLine, endLine) — the exact text that was indexed and
   * ranked, powering `recall({ body: true })` for a localized file hit. Reads the index, not the
   * current disk, so it is drift-free and matches what scored. `null` if no such chunk row exists.
   * @param {string} path
   * @param {number} startLine  0-based, inclusive (matches {@link ChunkRef})
   * @param {number} endLine    0-based, inclusive
   * @returns {string | null}
   */
  chunkBodyAt(path, startLine, endLine) {
    const row = /** @type {{ body: string } | undefined} */ (
      this.db.prepare("SELECT body FROM nodes WHERE path = ? AND start_line = ? AND end_line = ? ORDER BY id LIMIT 1").get(path, startLine, endLine)
    );
    return row ? row.body : null;
  }

  /**
   * Every node defining symbol `name` (over-count: a name defined in N files returns N rows). The
   * def's `body` powers callee/complexity analysis (impact, slice 5); `format` routes the parser.
   * @param {string} name
   * @returns {{ path: string, format: string, start_line: number, end_line: number, body: string }[]}
   */
  symbolDefs(name) {
    return /** @type {any} */ (
      this.db.prepare("SELECT path, format, start_line, end_line, body FROM nodes WHERE symbol = ? ORDER BY path, start_line").all(name)
    );
  }

  /**
   * The set of all symbol names defined anywhere in the index — used to resolve a call's callee to
   * an intra-repo definition (a callee not in this set is external: stdlib/3rd-party, dropped).
   * @returns {Set<string>}
   */
  allSymbolNames() {
    const rows = /** @type {{ symbol: string }[]} */ (
      this.db.prepare("SELECT DISTINCT symbol FROM nodes WHERE symbol IS NOT NULL").all()
    );
    return new Set(rows.map((r) => r.symbol));
  }

  /**
   * Describe one graph node by id (the substrate accessor). `getNode` returns STRUCTURE; `getItem`/
   * `get` return the body. Kind-agnostic: an indexed file resolves to a file node carrying its chunks
   * (the symbols inside) plus exact per-type edge counts; a written-memory id resolves to a zero-chunk,
   * zero-edge node. Edge counts cover the persisted `import` graph only — call relationships are
   * impact()'s on-demand job and are never persisted as edges. Returns null for an unknown id.
   * @param {string} id  an indexed file's repo-relative path, or a written-memory id
   * @returns {GraphNode | null}
   */
  getNode(id) {
    const chunks = this.nodesForPath(id);
    if (chunks.length) {
      const meta = /** @type {{ kind: string, format: string }} */ (
        this.db.prepare("SELECT kind, format FROM nodes WHERE path = ? LIMIT 1").get(id)
      );
      const git = /** @type {import("./gitsig.js").GitSig | undefined} */ (
        this.db.prepare("SELECT commits, last_commit AS lastCommit FROM git_sig WHERE path = ?").get(id)
      );
      const imports = /** @type {{ c: number }} */ (this.db.prepare("SELECT COUNT(*) c FROM edges WHERE type = 'import' AND src_path = ?").get(id)).c;
      const importedBy = /** @type {{ c: number }} */ (this.db.prepare("SELECT COUNT(*) c FROM edges WHERE type = 'import' AND dst_path = ?").get(id)).c;
      return {
        id, kind: meta.kind, format: meta.format, source: "file", git: git ?? null,
        chunks: chunks.map((c) => ({ symbol: c.symbol, nodeType: c.node_type, startLine: c.start_line, endLine: c.end_line })),
        edges: { imports, importedBy },
      };
    }
    const mem = /** @type {{ kind: string, format: string, provenance: string|null } | undefined} */ (
      this.db.prepare("SELECT kind, format, provenance FROM mem WHERE path = ?").get(id)
    );
    if (mem) return { id, kind: mem.kind, format: mem.format, source: "direct", provenance: mem.provenance, git: null, chunks: [], edges: { imports: 0, importedBy: 0 } };
    return null;
  }

  /**
   * Walk the persisted edge graph from `id` (the substrate navigator). BFS over edges of `edge` type
   * ('import' is the only persisted type today — `call` relationships are impact()'s on-demand job).
   * `dir` picks direction: "out" = what `id` imports, "in" = what imports `id`, "both" = the
   * neighbourhood. `hops` is the BFS depth, hard-capped at 3 (navigation, not ranking — multi-hop is
   * legitimate; the cap stops a walk returning half the repo, and `truncated` flags when it bit).
   * Deduped, nearest-hop-wins, never includes the seed. `edge` is a generic type so future non-code
   * edges (e.g. `derived_from`) slot in unchanged once a producer emits them.
   * @param {string} id
   * @param {{ edge?: string, dir?: "out"|"in"|"both", hops?: number }} [opts]
   * @returns {{ items: RelatedNode[], truncated: boolean }}
   */
  related(id, opts = {}) {
    const MAX_HOPS = 3;
    const edge = opts.edge ?? "import";
    const dir = opts.dir ?? "both";
    const requested = opts.hops ?? 1;
    const depth = Math.min(requested, MAX_HOPS);
    const outQ = this.db.prepare("SELECT dst_path AS p FROM edges WHERE type = ? AND src_path = ?");
    const inQ = this.db.prepare("SELECT src_path AS p FROM edges WHERE type = ? AND dst_path = ?");
    const metaQ = this.db.prepare("SELECT kind, format FROM nodes WHERE path = ? LIMIT 1");
    const seen = new Set([id]);
    /** @type {RelatedNode[]} */
    const items = [];
    let frontier = [id];
    for (let h = 1; h <= depth; h++) {
      const next = [];
      for (const node of frontier) {
        /** @type {[string, "out"|"in"][]} */
        const neigh = [];
        if (dir === "out" || dir === "both") for (const r of /** @type {{ p: string }[]} */ (outQ.all(edge, node))) neigh.push([r.p, "out"]);
        if (dir === "in" || dir === "both") for (const r of /** @type {{ p: string }[]} */ (inQ.all(edge, node))) neigh.push([r.p, "in"]);
        for (const [p, via] of neigh) {
          if (seen.has(p)) continue;
          seen.add(p);
          const meta = /** @type {{ kind: string, format: string } | undefined} */ (metaQ.get(p));
          items.push({ id: p, kind: meta?.kind ?? null, format: meta?.format ?? null, hops: h, via });
          next.push(p);
        }
      }
      frontier = next;
    }
    return { items, truncated: requested > MAX_HOPS };
  }

  /**
   * Ranked search over the FTS index, scoped to a single kind. Kinds never share a ranking
   * (§5) — the caller runs one `search` per kind and keeps the lists separate, so high-volume
   * prose can never out-rank code. The `kind = ?` filter rides the UNINDEXED `kind` column.
   *
   * Ranking is BM25 plus optional 1-hop import-spreading (`spreadWeight > 0`): the v1 signal
   * model. Each candidate's score is its own normalised BM25 PLUS `spreadWeight ×` the best
   * normalised BM25 among its import-neighbours in the pool — an ADDITIVE boost, so a file that
   * imports/is-imported-by a strong hit is lifted, but a strong hit with weak neighbours is never
   * taxed (the convex blend `(1-w)·own + w·spread` demoted well-ranked files whose neighbours
   * were mediocre; additive holds-or-beats it on every bench repo with fewer regressions). Spreading
   * re-ranks a wider pool than `limit` and is a no-op for kinds without edges (`doc`): order unchanged.
   * `filter` (multis M3 R2/R5) narrows direct doc/blob rows via the `doc_scope` sidecar. It is a
   * **resolved** read filter (the strict-scope policy lives in the facade, not here — see
   * `LiteCtx._resolveReadScope`); this method only executes the three modes it encodes:
   *   - `seeAll: true`  → no scope predicate (every row, incl. all tenants) — the single-tenant /
   *     admin / legacy-`null` default. This is the fail-OPEN mode the facade gates behind strictScope.
   *   - `seeAll: false, scope: null` → the shared/global tier ONLY (`ds.scope IS NULL`) — the GLOBAL view.
   *   - `seeAll: false, scope: "user:42"` → `scope ∪ NULL-global` (own uploads + the global kb, never
   *     another tenant). This is the R2 union.
   * `now` (epoch ms) drops rows whose `expires_at <= now`. All are no-ops on file-indexed rows (no
   * `doc_scope` row → always global/forever) and ignored entirely by `fact`/`episode` (the mem branch,
   * scoped by instance owner/session). `seeAll` defaults to "`scope == null`" so a direct caller passing
   * only `{scope}` (or `{}`) keeps the pre-strict behaviour byte-identical.
   * @param {string} match  an FTS5 MATCH expression
   * @param {string} kind   the memory kind to scope to ("code" | "doc" | ...)
   * @param {number} [limit=10]
   * @param {number} [spreadWeight=0]  0 = pure BM25; ~0.4 = v1 default (set by the caller)
   * @param {{ scope?: string|null, seeAll?: boolean, now?: number|null }} [filter]  resolved R2 scope + R5 expiry
   * @returns {Hit[]}
   */
  search(match, kind, limit = 10, spreadWeight = 0, filter = {}) {
    const scope = filter.scope ?? null;
    // seeAll defaults to the legacy meaning of a null scope ("see everything") so any direct caller
    // (tests, the MCP/CLI bins) is byte-identical pre-strict; the facade passes it explicitly.
    const seeAll = (filter.seeAll ?? scope == null) ? 1 : 0;
    const now = filter.now ?? null;
    // written-memory kinds route to the stemmed `mem` table (§5.1) — their own ranking domain
    // (kinds never share a ranking, so no BM25 score ever merges across the two tables). No
    // spreading: facts/episodes have no edges. Shape matches `docs` hits (`git` → null).
    if (MEM_KINDS.has(kind)) {
      // scope filter (§4.4): LEFT JOIN the sidecar so an unscoped row (no `mem_scope` row → NULL/NULL)
      // stays visible. An unset reader (`owner`/`session` = NULL on the Store) sees everything; a set
      // reader sees its own + global (NULL) only. Named params throughout (SQLite forbids mixing `?`).
      const rows = /** @type {Hit[]} */ (
        this.db
          .prepare(
            // No alias on `mem`: fts5's bm25()/MATCH take the real table name, not an alias.
            "SELECT mem.path AS path, mem.kind AS kind, mem.format AS format, -bm25(mem) AS score " +
              "FROM mem LEFT JOIN mem_scope s ON s.path = mem.path " +
              "WHERE mem MATCH :match AND mem.kind = :kind " +
              "AND (:me IS NULL OR s.owner IS NULL OR s.owner = :me) " +
              "AND (:sid IS NULL OR s.session IS NULL OR s.session = :sid) " +
              "ORDER BY score DESC LIMIT :limit"
          )
          .all({ match, kind, me: this.owner, sid: this.session, limit })
      );
      return this.attachGit(rows);
    }
    // Pull a pool wider than `limit` so spreading can pull a graph-adjacent file up into the
    // top results. 200 covers the validated bench depth; bounded so the neighbour query's
    // bind-parameter count stays well under SQLite's limit.
    const pool = spreadWeight > 0 ? Math.min(Math.max(limit, 200), 400) : limit;
    // LEFT JOIN doc_scope so file rows (no sidecar row) stay visible (NULL = global/forever). bm25(docs)
    // + `docs MATCH` take the real table name, not an alias — so `docs` is unaliased and doc_scope is `ds`.
    const rows = /** @type {Hit[]} */ (
      this.db
        .prepare(
          "SELECT docs.path AS path, docs.kind AS kind, docs.format AS format, -bm25(docs) AS score " +
            "FROM docs LEFT JOIN doc_scope ds ON ds.path = docs.path " +
            "WHERE docs MATCH :match AND docs.kind = :kind " +
            // tri-state fence (multis M3 fail-closed): seeAll=1 → every row; else global rows always,
            // plus the reader's own tenant when a scope is set. seeAll=0 + scope NULL = global-only (GLOBAL).
            "AND (:seeAll = 1 OR ds.scope IS NULL OR (:scope IS NOT NULL AND ds.scope = :scope)) " +
            "AND (:now IS NULL OR ds.expires_at IS NULL OR ds.expires_at > :now) " +
            "ORDER BY score DESC LIMIT :limit"
        )
        .all({ match, kind, scope, seeAll, now, limit: pool })
    );
    if (spreadWeight <= 0 || rows.length < 2) return this.attachGit(rows.slice(0, limit));

    // min–max normalise BM25 across the pool so it composes with the [0,1] spread term.
    const scores = rows.map((r) => r.score);
    const lo = Math.min(...scores);
    const hi = Math.max(...scores);
    /** @type {Map<string, number>} */
    const norm = new Map(rows.map((r) => [r.path, hi > lo ? (r.score - lo) / (hi - lo) : 1]));

    // undirected adjacency restricted to the pool — every intra-pool edge has its src in the
    // pool, so filtering on src_path captures them all (one bind set, not two).
    const ph = rows.map(() => "?").join(",");
    const erows = /** @type {{src_path: string, dst_path: string}[]} */ (
      this.db.prepare(`SELECT src_path, dst_path FROM edges WHERE type = 'import' AND src_path IN (${ph})`).all(...rows.map((r) => r.path))
    );
    /** @type {Map<string, Set<string>>} */
    const adj = new Map();
    const link = (a, b) => {
      const s = adj.get(a);
      if (s) s.add(b);
      else adj.set(a, new Set([b]));
    };
    for (const e of erows) {
      if (!norm.has(e.dst_path)) continue; // neighbour outside the pool — irrelevant to re-rank
      link(e.src_path, e.dst_path);
      link(e.dst_path, e.src_path);
    }

    const w = spreadWeight;
    const blended = rows.map((r) => {
      let spread = 0;
      const ns = adj.get(r.path);
      if (ns) for (const nb of ns) spread = Math.max(spread, norm.get(nb) ?? 0);
      return { ...r, score: (norm.get(r.path) ?? 0) + w * spread }; // additive boost, never a tax
    });
    blended.sort((a, b) => b.score - a.score);
    return this.attachGit(blended.slice(0, limit));
  }

  /**
   * Attach the best-matching chunk pointer to each hit, in place (chunk-granular recall). File-level
   * ranking is untouched — the benches gate on hit order and this never reorders; it localizes WHICH
   * function/section inside an already-ranked file carried the query terms (a function pointer beats
   * a file pointer). Scoring is structural, no weights: both sides identifier-split the same way
   * (`splitIdent`, the indexing convention) and score = distinct query terms present in the chunk.
   * The one non-obvious rule: **the winner may not strictly contain another scoring chunk.** Chunks
   * nest (file/preamble ⊃ class ⊃ method ⊃ arrow), so a container's term set is a superset of its
   * children's and would *always* out-count them — a class chunk that wins only by aggregating a
   * method's match is the file-pointer problem again at class scale. A container still wins when the
   * match genuinely lives in container-level code (no scoring descendant). Ties: named beats
   * anonymous, then smaller span, then first-in-file; an anonymous winner (arrow/lambda) is labeled
   * with its nearest named container. Runs only over the final returned hits (≤ n per kind), never
   * the pool. `chunk: null` when nothing localizes: written memory has no nodes rows (the row IS
   * the unit), and a match carried only by path/filename tokens names no chunk.
   * @param {Hit[]} hits
   * @param {string[]} terms  identifier-split query keywords (`keywords(query)`)
   * @returns {Hit[]}
   */
  attachChunks(hits, terms) {
    const sel = this.db.prepare("SELECT symbol, node_type, start_line, end_line, body FROM nodes WHERE path = ? ORDER BY id");
    /** @type {(a: {start_line:number,end_line:number}, b: {start_line:number,end_line:number}) => boolean} */
    const contains = (a, b) =>
      a.start_line <= b.start_line && a.end_line >= b.end_line && a.end_line - a.start_line > b.end_line - b.start_line;
    /** @type {(r: {start_line:number,end_line:number}) => number} */
    const span = (r) => r.end_line - r.start_line;
    for (const h of hits) {
      h.chunk = null;
      if (!terms.length) continue;
      const rows = /** @type {{ symbol: string|null, node_type: string, start_line: number, end_line: number, body: string }[]} */ (sel.all(h.path));
      const scored = [];
      for (const r of rows) {
        const toks = new Set(splitIdent(`${r.symbol ?? ""} ${r.body}`));
        let s = 0;
        for (const t of terms) if (toks.has(t)) s++;
        if (s > 0) scored.push({ r, s });
      }
      if (!scored.length) continue;
      // disqualify aggregators; if every scoring chunk aggregates (degenerate), keep them all
      const leaf = scored.filter((x) => !scored.some((o) => o !== x && contains(x.r, o.r)));
      const pool = leaf.length ? leaf : scored;
      let best = pool[0];
      for (const x of pool) {
        if (
          x.s > best.s ||
          (x.s === best.s && x.r.symbol != null && best.r.symbol == null) ||
          (x.s === best.s && (x.r.symbol != null) === (best.r.symbol != null) && span(x.r) < span(best.r))
        )
          best = x;
      }
      // an anonymous winner is labeled with its nearest (smallest) named container
      let c = best.r;
      if (c.symbol == null) {
        let named = null;
        for (const o of rows) if (o.symbol != null && contains(o, c) && (!named || span(o) < span(named))) named = o;
        if (named) c = named;
      }
      h.chunk = { symbol: c.symbol, nodeType: c.node_type, startLine: c.start_line, endLine: c.end_line };
    }
    return hits;
  }

  /**
   * Attach file-level git activity metadata (gitsig) to a result set, in place. One lookup for the
   * whole set; a path with no stored row gets `git: null` (uncommitted / no git). Grounding only —
   * never reorders the hits.
   * @param {Hit[]} hits
   * @returns {Hit[]}
   */
  attachGit(hits) {
    if (!hits.length) return hits;
    const ph = hits.map(() => "?").join(",");
    const rows = /** @type {{ path: string, commits: number, last_commit: number|null }[]} */ (
      this.db.prepare(`SELECT path, commits, last_commit FROM git_sig WHERE path IN (${ph})`).all(...hits.map((h) => h.path))
    );
    const m = new Map(rows.map((r) => [r.path, { commits: r.commits, lastCommit: r.last_commit }]));
    for (const h of hits) h.git = m.get(h.path) ?? null;
    return hits;
  }

  /**
   * Attach written-memory grounding columns to a result set, in place (slice 5c, §15): `provenance`
   * (human/agent VALIDATION status), `use` (recall-demand count — 'recall' rows only, the fetch-toll),
   * and `occurredAt` (episode timestamp). The written-memory analog of {@link attachGit}: metadata the
   * caller reads to DECIDE, never a ranking input. Ranking stays pure relevance — the trust/use
   * tie-break was bench-falsified (it can't safely reorder, and forcing trust/popularity buries fresh
   * or better-matching answers; §14 #4 / §15 5c). Only `mem`-table rows (facts/episodes) match; file
   * and doc-from-disk hits are left untouched (a file is not a claim awaiting validation). One batched
   * query (mem LEFT JOIN recall_log) over the hit paths.
   * @param {Hit[]} hits
   * @returns {Hit[]}
   */
  attachMemMeta(hits) {
    if (!hits.length) return hits;
    const ph = hits.map(() => "?").join(",");
    const rows = /** @type {{ path: string, provenance: string|null, occurred_at: number|null, use: number }[]} */ (
      this.db
        .prepare(
          "SELECT m.path, m.provenance, m.occurred_at, count(r.id) AS use FROM mem m " +
            "LEFT JOIN recall_log r ON r.path = m.path AND r.action = 'recall' " +
            `WHERE m.path IN (${ph}) GROUP BY m.path`
        )
        .all(...hits.map((h) => h.path))
    );
    const meta = new Map(rows.map((r) => [r.path, r]));
    for (const h of hits) {
      const m = meta.get(h.path);
      if (m) (h.provenance = m.provenance), (h.use = m.use), (h.occurredAt = m.occurred_at);
    }
    return hits;
  }

  /**
   * Batched lookup of the sealed opaque `meta` (RT-3 #3) for a set of written-memory paths — the raw
   * JSON strings as stored, for the facade to parse and attach to recall hits / `get`. Returns a Map
   * keyed by path; a path with no metadata is simply absent. Reads the `mem_meta` passthrough table
   * only — never an FTS/ranking surface.
   * @param {string[]} paths
   * @returns {Map<string, string>}
   */
  metaFor(paths) {
    if (!paths.length) return new Map();
    const ph = paths.map(() => "?").join(",");
    const rows = /** @type {{ path: string, meta: string }[]} */ (
      this.db.prepare(`SELECT path, meta FROM mem_meta WHERE path IN (${ph})`).all(...paths)
    );
    return new Map(rows.map((r) => [r.path, r.meta]));
  }

  /** @returns {number} number of import edges (slice 4 — for tests/introspection) */
  edgeCount() {
    return /** @type {{ n: number }} */ (this.db.prepare("SELECT count(*) AS n FROM edges WHERE type = 'import'").get()).n;
  }

  /**
   * Stored embedding vectors for the given paths (slice 6). Reads only the requested rows — at
   * search time that's the BM25-gated pool, never the whole corpus — so cosine stays O(pool).
   * Reconstructs each BLOB into its own Float32Array (copied, so it never aliases SQLite's buffer).
   * @param {string[]} paths
   * @returns {Map<string, Float32Array>}
   */
  getEmbeddings(paths) {
    /** @type {Map<string, Float32Array>} */
    const m = new Map();
    if (!paths.length) return m;
    const ph = paths.map(() => "?").join(",");
    const rows = /** @type {{ path: string, vec: Buffer }[]} */ (
      this.db.prepare(`SELECT path, vec FROM file_embeddings WHERE path IN (${ph})`).all(...paths)
    );
    for (const r of rows) m.set(r.path, blobToVec(r.vec));
    return m;
  }

  /** @returns {number} number of stored file embeddings (slice 6 — for tests/introspection) */
  embeddingCount() {
    return /** @type {{ n: number }} */ (this.db.prepare("SELECT count(*) AS n FROM file_embeddings").get()).n;
  }

  /**
   * Semantic nominees for written-kind recall — the KNN side of the slice-11 union. Every stored
   * vector for `kind` (mem-table rows that have one) is scored by cosine against the query vector;
   * the top `k` not already in the lexical pool come back as Hit-shaped rows with `score: 0` (they
   * have no lexical score — the caller's fusion ranks them on semantics alone). Written kinds only:
   * non-mem kinds return `[]` (code/doc queries virtually always share an identifier with their
   * answer, and their corpora are where a full scan would start to cost). **No admission
   * threshold by design** — POC-swept (poc/knn-union-poc.mjs): true-paraphrase cosines run low
   * (T=0.25 already halves para MRR), and the k-cap + fusion keep weak nominees down. The one
   * exception is exactly zero: no measured similarity is no evidence, so orthogonal vectors never
   * nominate (real model vectors are dense — this excludes nothing in practice). Linear scan
   * by design: written memory is dozens-to-hundreds at lite scale (`sqlite-vec` is the named
   * escalation if a corpus ever justifies it). Rows written while the tier was off have no vector
   * and simply never nominate.
   * @param {string} kind  the memory kind ("fact" | "episode"); anything else → []
   * @param {Float32Array} qvec  the embedded query
   * @param {number} k  max nominees
   * @param {Set<string>} exclude  paths already in the lexical pool (never nominated twice)
   * @returns {Hit[]}
   */
  knnCandidates(kind, qvec, k, exclude) {
    if (!MEM_KINDS.has(kind)) return [];
    const rows = /** @type {{ path: string, kind: string, format: string, vec: Buffer }[]} */ (
      this.db
        .prepare(
          "SELECT m.path, m.kind, m.format, e.vec FROM mem m JOIN file_embeddings e ON e.path = m.path " +
            "LEFT JOIN mem_scope s ON s.path = m.path WHERE m.kind = :kind " +
            "AND (:me IS NULL OR s.owner IS NULL OR s.owner = :me) " +
            "AND (:sid IS NULL OR s.session IS NULL OR s.session = :sid)"
        )
        .all({ kind, me: this.owner, sid: this.session })
    );
    return rows
      .filter((r) => !exclude.has(r.path))
      .map((r) => ({ r, cos: cosine(qvec, blobToVec(r.vec)) }))
      .filter((c) => c.cos > 0)
      .sort((a, b) => b.cos - a.cos)
      .slice(0, k)
      .map(({ r }) => ({ path: r.path, kind: r.kind, format: r.format, score: 0, git: null }));
  }

  close() {
    this.db.close();
  }
}
