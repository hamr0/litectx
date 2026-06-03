// SQLite + FTS5 store. Slice 0: a single FTS5 table at file granularity, BM25 ranking.
// Later slices add the nodes/edges/signals tables around this; recall keeps reading FTS.

import Database from "better-sqlite3";
import { splitIdent } from "./tokenize.js";

/**
 * @typedef {Object} DocRow
 * @property {string} path   repo-relative file path
 * @property {string} kind   "code" | "doc"
 * @property {string} body   file contents
 */

/**
 * @typedef {Object} Hit
 * @property {string} path
 * @property {string} kind
 * @property {number} score  higher = more relevant
 */

export class Store {
  /** @param {string} dbPath path to the SQLite file, or ":memory:" */
  constructor(dbPath) {
    /** @type {any} */
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      // path tokens are folded into `body` (doubled) so filename matches count;
      // `path`/`kind` are stored but not full-text indexed.
      "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(path UNINDEXED, kind UNINDEXED, body)"
    );
  }

  /** Drop and recreate the index (slice 0 does full reindex; incremental is slice 1). */
  reset() {
    this.db.exec("DROP TABLE IF EXISTS docs");
    this.db.exec("CREATE VIRTUAL TABLE docs USING fts5(path UNINDEXED, kind UNINDEXED, body)");
  }

  /**
   * Insert documents. Path tokens are prepended (doubled) to the indexed body.
   * @param {DocRow[]} rows
   */
  insertMany(rows) {
    const ins = this.db.prepare("INSERT INTO docs(path, kind, body) VALUES (@path, @kind, @body)");
    const tx = this.db.transaction((/** @type {DocRow[]} */ batch) => {
      for (const r of batch) {
        const pathTok = splitIdent(r.path).join(" ");
        ins.run({ path: r.path, kind: r.kind, body: `${pathTok} ${pathTok}\n${r.body}` });
      }
    });
    tx(rows);
  }

  /** @returns {number} number of indexed documents */
  count() {
    return /** @type {{n:number}} */ (this.db.prepare("SELECT count(*) AS n FROM docs").get()).n;
  }

  /**
   * BM25 search over the FTS index.
   * @param {string} match  an FTS5 MATCH expression
   * @param {number} [limit=10]
   * @returns {Hit[]}
   */
  search(match, limit = 10) {
    const rows = this.db
      .prepare("SELECT path, kind, -bm25(docs) AS score FROM docs WHERE docs MATCH ? ORDER BY score DESC LIMIT ?")
      .all(match, limit);
    return /** @type {Hit[]} */ (rows);
  }

  close() {
    this.db.close();
  }
}
