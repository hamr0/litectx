// SQLite + FTS5 store. Slice 1: an FTS5 table (file granularity, BM25 ranking) plus a
// `file_index` table that tracks content-hash + mtime per file so re-indexing is incremental
// (§6). `kind`/`format` are first-class columns from day one (§3.1). Later slices add the
// nodes/edges/signals tables around this; recall keeps reading FTS.

import Database from "better-sqlite3";
import { splitIdent } from "./tokenize.js";

/**
 * @typedef {Object} DocRow
 * @property {string} path    repo-relative file path
 * @property {string} kind    "code" | "doc"
 * @property {string} format  source/doc format tag: "ts" | "js" | "py" | "md" | ...
 * @property {string} body    file contents
 */

/**
 * @typedef {DocRow & { hash: string, mtime: number, size: number }} Upsert
 */

/**
 * @typedef {Object} Changes
 * @property {Upsert[]} upserts   files to (re)index
 * @property {{ path: string, mtime: number }[]} touch  unchanged content, advanced mtime
 * @property {string[]} deletes   paths to drop from the index
 */

/**
 * @typedef {Object} Hit
 * @property {string} path
 * @property {string} kind
 * @property {string} format
 * @property {number} score   higher = more relevant
 */

const SCHEMA = [
  // path tokens are folded into `body` (doubled) so filename matches count;
  // path/kind/format are stored but not full-text indexed.
  "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, kind UNINDEXED, format UNINDEXED, body)",
  // change detection (§6): (mtime, size) is the fast skip, content_hash the arbiter.
  // size guards the case where an edit lands within one filesystem mtime tick of the last
  // index (mtime unchanged but length moved); `index({ force: true })` covers the rest.
  "CREATE TABLE IF NOT EXISTS file_index(path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER NOT NULL, indexed_at INTEGER NOT NULL)",
];

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
  }

  /** Drop and recreate everything (full reindex; used by `index({ force: true })`). */
  reset() {
    this.db.exec("DROP TABLE IF EXISTS docs");
    this.db.exec("DROP TABLE IF EXISTS file_index");
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
   */
  applyChanges({ upserts, touch, deletes }, indexedAt) {
    const delDoc = this.db.prepare("DELETE FROM docs WHERE path = ?");
    const delIdx = this.db.prepare("DELETE FROM file_index WHERE path = ?");
    const insDoc = this.db.prepare("INSERT INTO docs(path, kind, format, body) VALUES (@path, @kind, @format, @body)");
    const upIdx = this.db.prepare(
      "INSERT INTO file_index(path, content_hash, mtime, size, indexed_at) VALUES (@path, @hash, @mtime, @size, @indexed_at) " +
        "ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, mtime = excluded.mtime, size = excluded.size, indexed_at = excluded.indexed_at"
    );
    const touchIdx = this.db.prepare("UPDATE file_index SET mtime = @mtime WHERE path = @path");

    const tx = this.db.transaction(() => {
      for (const p of deletes) {
        delDoc.run(p);
        delIdx.run(p);
      }
      for (const u of upserts) {
        delDoc.run(u.path); // replace any prior row for this path
        const pathTok = splitIdent(u.path).join(" ");
        insDoc.run({ path: u.path, kind: u.kind, format: u.format, body: `${pathTok} ${pathTok}\n${u.body}` });
        upIdx.run({ path: u.path, hash: u.hash, mtime: u.mtime, size: u.size, indexed_at: indexedAt });
      }
      for (const t of touch) touchIdx.run({ path: t.path, mtime: t.mtime });
    });
    tx();
  }

  /** @returns {number} number of indexed documents */
  count() {
    return /** @type {{ n: number }} */ (this.db.prepare("SELECT count(*) AS n FROM docs").get()).n;
  }

  /**
   * BM25 search over the FTS index.
   * @param {string} match  an FTS5 MATCH expression
   * @param {number} [limit=10]
   * @returns {Hit[]}
   */
  search(match, limit = 10) {
    const rows = this.db
      .prepare(
        "SELECT path, kind, format, -bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score DESC LIMIT ?"
      )
      .all(match, limit);
    return /** @type {Hit[]} */ (rows);
  }

  close() {
    this.db.close();
  }
}
