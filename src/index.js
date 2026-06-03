// litectx public API.
//
// Slice 0 (walking skeleton): index files into SQLite/FTS5 and rank recall by BM25,
// at file granularity. The API shape is the one later slices grow into — symbol-level
// chunking, activation, and the impact view slot in behind `index()` and `recall()`
// without changing these signatures.

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Store } from "./store.js";
import { collectFiles, readDocs } from "./indexer.js";
import { ftsMatch } from "./tokenize.js";

const DEFAULT_INCLUDE = [".ts", ".js", ".mjs", ".cjs", ".py", ".md"];

/**
 * @typedef {Object} LiteCtxConfig
 * @property {string} root                 repo root to index
 * @property {string[]} [include]          file extensions to index (default: ts/js/py/md)
 * @property {string[]} [pathspecs]        optional git pathspecs to scope the index (e.g. ["app/**\/*.js"])
 * @property {string} [dbPath]             SQLite file path (default: <root>/.litectx/index.db)
 */

export class LiteCtx {
  /** @param {LiteCtxConfig} config */
  constructor(config) {
    if (!config || !config.root) throw new Error("LiteCtx requires a { root } config");
    this.root = config.root;
    this.include = config.include ?? DEFAULT_INCLUDE;
    this.pathspecs = config.pathspecs;
    this.dbPath = config.dbPath ?? join(this.root, ".litectx", "index.db");
    if (this.dbPath !== ":memory:") mkdirSync(join(this.root, ".litectx"), { recursive: true });
    this.store = new Store(this.dbPath);
  }

  /**
   * Build (or rebuild) the index over the configured root.
   * @returns {{ files: number }}
   */
  index() {
    const paths = collectFiles(this.root, this.include, this.pathspecs);
    const docs = readDocs(this.root, paths);
    this.store.reset();
    this.store.insertMany(docs);
    return { files: docs.length };
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
