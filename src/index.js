// litectx public API.
//
// index files into SQLite/FTS5 and rank recall by BM25, at file granularity. The API shape
// is the one later slices grow into — symbol-level chunking, activation, and the impact view
// slot in behind `index()` and `recall()` without changing these signatures.
//
// Slice 1: `index()` is incremental and git-aware — it re-reads only files whose content
// changed and drops files that disappeared (§6).

import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { Store } from "./store.js";
import { collectFiles, diffFiles } from "./indexer.js";
import { ftsMatch } from "./tokenize.js";

const DEFAULT_INCLUDE = [".ts", ".js", ".mjs", ".cjs", ".py", ".md"];

/**
 * @typedef {Object} LiteCtxConfig
 * @property {string} root                 repo root to index
 * @property {string[]} [include]          file extensions to index (default: ts/js/py/md)
 * @property {string[]} [pathspecs]        optional git pathspecs to scope the index (e.g. ["app/**\/*.js"])
 * @property {string} [dbPath]             SQLite file path (default: <root>/.litectx/index.db)
 */

/**
 * @typedef {Object} IndexResult
 * @property {number} files      total documents in the index after the pass
 * @property {number} added      newly indexed files
 * @property {number} updated    re-indexed files (content changed)
 * @property {number} removed    files dropped (no longer present)
 * @property {number} unchanged  files skipped (mtime or content unchanged)
 */

export class LiteCtx {
  /** @param {LiteCtxConfig} config */
  constructor(config) {
    if (!config || !config.root) throw new Error("LiteCtx requires a { root } config");
    this.root = config.root;
    this.include = config.include ?? DEFAULT_INCLUDE;
    this.pathspecs = config.pathspecs;
    this.dbPath = config.dbPath ?? join(this.root, ".litectx", "index.db");
    if (this.dbPath !== ":memory:") mkdirSync(dirname(this.dbPath), { recursive: true });
    this.store = new Store(this.dbPath);
  }

  /**
   * Build or incrementally refresh the index over the configured root.
   *
   * By default only files whose content changed are re-read, and files that disappeared are
   * dropped. Pass `force` for a full rebuild, or `paths` (git pathspecs) to scope the pass —
   * a scoped pass never deletes files outside its scope.
   *
   * @param {{ paths?: string[], force?: boolean }} [opts]
   * @returns {IndexResult}
   */
  index(opts = {}) {
    const files = collectFiles(this.root, this.include, opts.paths ?? this.pathspecs);
    if (opts.force) this.store.reset();
    const prev = opts.force ? new Map() : this.store.loadIndex();

    const { upserts, touch, unchanged } = diffFiles(this.root, files, prev);
    const current = new Set(files);
    const deletes = opts.paths ? [] : [...prev.keys()].filter((p) => !current.has(p));

    this.store.applyChanges({ upserts, touch, deletes }, Date.now());

    const added = upserts.filter((u) => !prev.has(u.path)).length;
    return { files: this.store.count(), added, updated: upserts.length - added, removed: deletes.length, unchanged };
  }

  /**
   * Ranked recall over the index.
   * @param {string} query
   * @param {{ limit?: number }} [opts]
   * @returns {import("./store.js").Hit[]}
   */
  recall(query, opts = {}) {
    const match = ftsMatch(query);
    if (!match) return [];
    return this.store.search(match, opts.limit ?? 10);
  }

  /** @returns {number} indexed document count */
  size() {
    return this.store.count();
  }

  close() {
    this.store.close();
  }
}

export { Store } from "./store.js";
export { splitIdent, keywords, ftsMatch } from "./tokenize.js";
