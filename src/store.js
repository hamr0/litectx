// SQLite + FTS5 store. Slice 1: an FTS5 table (file granularity, BM25 ranking) plus a
// `file_index` table that tracks content-hash + mtime per file so re-indexing is incremental
// (§6). `kind`/`format` are first-class columns from day one (§3.1). Later slices add the
// nodes/edges/signals tables around this; recall keeps reading FTS.

import Database from "better-sqlite3";
import { indexBody, splitIdent } from "./tokenize.js";
import { cosine } from "./embedder.js"; // pure math — the ML dep stays lazy inside Embedder

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
 * @property {string|null} [provenance]  written memory only (slice 5c): "human" | "agent" — the
 *                            VALIDATION status (signed-off vs the agent's own assertion), NOT a quality
 *                            signal and NEVER scored: an agent fact may be perfectly true, awaiting HITL.
 *                            Surfaced for the caller to decide; absent on indexed files (not a claim).
 * @property {number} [use]   written memory only (slice 5c): recall-demand count ('recall' rows only —
 *                            fetches excluded, the fetch-toll). Surfaced, NEVER ranked — a fresh effective
 *                            memory has use 0, so ranking on it would be a popularity prior (§14 #4).
 * @property {number|null} [occurredAt]  written memory only (slice 5c): episode timestamp (epoch ms);
 *                            null for facts; absent on indexed files.
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
];

/** Memory kinds stored in the stemmed `mem` table; everything else rides `docs`. */
export const MEM_KINDS = new Set(["fact", "episode"]);

export class Store {
  /** @param {string} dbPath path to the SQLite file, or ":memory:" */
  constructor(dbPath) {
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
    const chunkKey = (/** @type {string|null} */ symbol, /** @type {string} */ body) => `${symbol ?? ""} ${body}`;
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
   * @param {{ id: string, text: string, kind: string, format: string, provenance: string|null, occurredAt: number|null, embedding?: Float32Array }} m
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
      } else {
        this.db.prepare("DELETE FROM docs WHERE path = ? AND source = 'direct'").run(m.id);
        this.db
          .prepare(
            "INSERT INTO docs(path, kind, format, source, provenance, occurred_at, body) " +
              "VALUES (@path, @kind, @format, 'direct', @provenance, @occurred_at, @body)"
          )
          .run({ path: m.id, kind: m.kind, format: m.format, provenance: m.provenance, occurred_at: m.occurredAt, body: indexBody({ path: m.id, body: m.text }) });
      }
      // raw text alongside the searchable surface (slice 9): the FTS body is processed
      // (indexBody) and there is no file behind a written row, so this is the only copy
      // `getItem` can hand back verbatim.
      this.db
        .prepare("INSERT INTO mem_text(path, text) VALUES (@path, @text) ON CONFLICT(path) DO UPDATE SET text = excluded.text")
        .run({ path: m.id, text: m.text });
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
   * Forget directly-written memory — by `id`, or by query (`kind` and/or `provenance`) for bulk human
   * invalidation (§3.2). **Only ever removes `source='direct'` rows**, so an indexed file is never
   * touched. Cleans the row's raw text, embedding + recall-log alongside it. Returns rows removed.
   * @param {{ id?: string, kind?: string, provenance?: string }} sel
   * @returns {number}
   */
  forgetMemory(sel) {
    /** @type {string[]} */
    const clauses = [];
    /** @type {Record<string, string>} */
    const params = {};
    if (sel.id != null) (clauses.push("path = @id"), (params.id = sel.id));
    if (sel.kind != null) (clauses.push("kind = @kind"), (params.kind = sel.kind));
    if (sel.provenance != null) (clauses.push("provenance = @provenance"), (params.provenance = sel.provenance));
    // both written-memory homes (§5.1): the stemmed `mem` table (facts/episodes — all direct by
    // construction) and `docs` rows guarded by source='direct' (directly-written docs only).
    const docsCond = ["source = 'direct'", ...clauses].join(" AND ");
    const memCond = clauses.length ? clauses.join(" AND ") : "1=1";
    const tx = this.db.transaction(() => {
      const paths = [
        .../** @type {{ path: string }[]} */ (this.db.prepare(`SELECT path FROM docs WHERE ${docsCond}`).all(params)),
        .../** @type {{ path: string }[]} */ (this.db.prepare(`SELECT path FROM mem WHERE ${memCond}`).all(params)),
      ].map((r) => r.path);
      const removed =
        this.db.prepare(`DELETE FROM docs WHERE ${docsCond}`).run(params).changes +
        this.db.prepare(`DELETE FROM mem WHERE ${memCond}`).run(params).changes;
      const delText = this.db.prepare("DELETE FROM mem_text WHERE path = ?");
      const delEmb = this.db.prepare("DELETE FROM file_embeddings WHERE path = ?");
      const delLog = this.db.prepare("DELETE FROM recall_log WHERE path = ?");
      for (const p of paths) (delText.run(p), delEmb.run(p), delLog.run(p));
      return removed;
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
      const delEmb = this.db.prepare("DELETE FROM file_embeddings WHERE path = ?");
      const delLog = this.db.prepare("DELETE FROM recall_log WHERE path = ?");
      for (const p of paths) (delText.run(p), delEmb.run(p), delLog.run(p));
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
   * @param {string} id
   * @returns {{ path: string, kind: string, format: string, source: string, provenance: string|null, occurred_at: number|null, text: string|null } | null}
   */
  getItem(id) {
    const row = /** @type {{ path: string, kind: string, format: string, source: string, provenance: string|null, occurred_at: number|null, body: string } | undefined} */ (
      this.db.prepare("SELECT path, kind, format, 'direct' AS source, provenance, occurred_at, body FROM mem WHERE path = ?").get(id) ??
        this.db
          .prepare("SELECT path, kind, format, source, provenance, occurred_at, body FROM docs WHERE path = ? ORDER BY (source = 'direct') DESC LIMIT 1")
          .get(id)
    );
    if (!row) return null;
    let text = null;
    if (row.source === "direct") {
      const raw = /** @type {{ text: string } | undefined} */ (this.db.prepare("SELECT text FROM mem_text WHERE path = ?").get(id));
      text = raw ? raw.text : row.body;
    }
    return { path: row.path, kind: row.kind, format: row.format, source: row.source, provenance: row.provenance, occurred_at: row.occurred_at, text };
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
   * @param {string} match  an FTS5 MATCH expression
   * @param {string} kind   the memory kind to scope to ("code" | "doc" | ...)
   * @param {number} [limit=10]
   * @param {number} [spreadWeight=0]  0 = pure BM25; ~0.4 = v1 default (set by the caller)
   * @returns {Hit[]}
   */
  search(match, kind, limit = 10, spreadWeight = 0) {
    // written-memory kinds route to the stemmed `mem` table (§5.1) — their own ranking domain
    // (kinds never share a ranking, so no BM25 score ever merges across the two tables). No
    // spreading: facts/episodes have no edges. Shape matches `docs` hits (`git` → null).
    if (MEM_KINDS.has(kind)) {
      const rows = /** @type {Hit[]} */ (
        this.db
          .prepare("SELECT path, kind, format, -bm25(mem) AS score FROM mem WHERE mem MATCH ? AND kind = ? ORDER BY score DESC LIMIT ?")
          .all(match, kind, limit)
      );
      return this.attachGit(rows);
    }
    // Pull a pool wider than `limit` so spreading can pull a graph-adjacent file up into the
    // top results. 200 covers the validated bench depth; bounded so the neighbour query's
    // bind-parameter count stays well under SQLite's limit.
    const pool = spreadWeight > 0 ? Math.min(Math.max(limit, 200), 400) : limit;
    const rows = /** @type {Hit[]} */ (
      this.db
        .prepare("SELECT path, kind, format, -bm25(docs) AS score FROM docs WHERE docs MATCH ? AND kind = ? ORDER BY score DESC LIMIT ?")
        .all(match, kind, pool)
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
    for (const r of rows) {
      const u8 = Uint8Array.from(r.vec); // copy out of SQLite's buffer, guarantees 4-byte alignment
      m.set(r.path, new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4));
    }
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
    const rows = /** @type {{ path: string, kind: string, format: string }[]} */ (
      this.db
        .prepare("SELECT m.path, m.kind, m.format FROM mem m JOIN file_embeddings e ON e.path = m.path WHERE m.kind = ?")
        .all(kind)
    );
    const cands = rows.filter((r) => !exclude.has(r.path));
    if (!cands.length) return [];
    const vecs = this.getEmbeddings(cands.map((r) => r.path));
    return cands
      .map((r) => ({ r, cos: cosine(qvec, vecs.get(r.path)) }))
      .filter((c) => c.cos > 0)
      .sort((a, b) => b.cos - a.cos)
      .slice(0, k)
      .map(({ r }) => ({ path: r.path, kind: r.kind, format: r.format, score: 0, git: null }));
  }

  close() {
    this.db.close();
  }
}
