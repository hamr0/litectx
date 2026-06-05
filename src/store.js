// SQLite + FTS5 store. Slice 1: an FTS5 table (file granularity, BM25 ranking) plus a
// `file_index` table that tracks content-hash + mtime per file so re-indexing is incremental
// (§6). `kind`/`format` are first-class columns from day one (§3.1). Later slices add the
// nodes/edges/signals tables around this; recall keeps reading FTS.

import Database from "better-sqlite3";
import { indexBody } from "./tokenize.js";

/**
 * @typedef {Object} DocRow
 * @property {string} path    repo-relative file path
 * @property {string} kind    "code" | "doc"
 * @property {string} format  source/doc format tag: "ts" | "js" | "py" | "md" | ...
 * @property {string} body    file contents
 */

/**
 * @typedef {DocRow & { hash: string, mtime: number, size: number, nodes?: import("./chunker.js").Chunk[], imports?: string[], edges?: string[] }} Upsert
 * `imports` are raw specifiers from the chunker; `edges` are those resolved to intra-repo dst paths (edges.js).
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
    this.db.exec("DROP TABLE IF EXISTS nodes");
    this.db.exec("DROP TABLE IF EXISTS edges");
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
    const delNodes = this.db.prepare("DELETE FROM nodes WHERE path = ?");
    const insNode = this.db.prepare(
      "INSERT INTO nodes(path, kind, format, symbol, node_type, start_line, end_line, body) " +
        "VALUES (@path, @kind, @format, @symbol, @node_type, @start_line, @end_line, @body)"
    );
    // import edges are owned by their source file: refreshed when the importer is re-indexed,
    // and on delete dropped from BOTH ends so no edge dangles to a removed file.
    const delEdgesOf = this.db.prepare("DELETE FROM edges WHERE src_path = ? OR dst_path = ?");
    const delEdgesSrc = this.db.prepare("DELETE FROM edges WHERE type = 'import' AND src_path = ?");
    const insEdge = this.db.prepare("INSERT INTO edges(type, src_path, dst_path) VALUES ('import', @src, @dst)");

    const tx = this.db.transaction(() => {
      for (const p of deletes) {
        delDoc.run(p);
        delIdx.run(p);
        delNodes.run(p);
        delEdgesOf.run(p, p);
      }
      for (const u of upserts) {
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
        }
        for (const dst of u.edges ?? []) insEdge.run({ src: u.path, dst });
      }
      for (const t of touch) touchIdx.run({ path: t.path, mtime: t.mtime });
    });
    tx();
  }

  /** @returns {number} number of indexed documents */
  count() {
    return /** @type {{ n: number }} */ (this.db.prepare("SELECT count(*) AS n FROM docs").get()).n;
  }

  /** @returns {number} number of symbol/section chunks across all files */
  nodeCount() {
    return /** @type {{ n: number }} */ (this.db.prepare("SELECT count(*) AS n FROM nodes").get()).n;
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
    // Pull a pool wider than `limit` so spreading can pull a graph-adjacent file up into the
    // top results. 200 covers the validated bench depth; bounded so the neighbour query's
    // bind-parameter count stays well under SQLite's limit.
    const pool = spreadWeight > 0 ? Math.min(Math.max(limit, 200), 400) : limit;
    const rows = /** @type {Hit[]} */ (
      this.db
        .prepare("SELECT path, kind, format, -bm25(docs) AS score FROM docs WHERE docs MATCH ? AND kind = ? ORDER BY score DESC LIMIT ?")
        .all(match, kind, pool)
    );
    if (spreadWeight <= 0 || rows.length < 2) return rows.slice(0, limit);

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
    return blended.slice(0, limit);
  }

  /** @returns {number} number of import edges (slice 4 — for tests/introspection) */
  edgeCount() {
    return /** @type {{ n: number }} */ (this.db.prepare("SELECT count(*) AS n FROM edges WHERE type = 'import'").get()).n;
  }

  close() {
    this.db.close();
  }
}
