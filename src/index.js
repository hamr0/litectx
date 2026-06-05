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
import { chunkFile } from "./chunker.js";
import { ftsMatch } from "./tokenize.js";

const DEFAULT_INCLUDE = [".ts", ".js", ".mjs", ".cjs", ".py", ".md"];

/**
 * The canonical memory-kind vocabulary — the kinds a bare `recall(query)` groups over. v1 ships
 * `code` (ts/js/py) + `doc` (md); `fact` and `episode` are reserved (schema ready, §3.1) and join
 * this list as their extractors land. Routing extension → kind lives in `indexer.classify`.
 * @type {string[]}
 */
export const KINDS = ["code", "doc"];

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
   * @returns {Promise<IndexResult>}
   */
  async index(opts = {}) {
    const files = collectFiles(this.root, this.include, opts.paths ?? this.pathspecs);
    if (opts.force) this.store.reset();
    const prev = opts.force ? new Map() : this.store.loadIndex();

    const { upserts, touch, unchanged } = diffFiles(this.root, files, prev);
    const current = new Set(files);
    const deletes = opts.paths ? [] : [...prev.keys()].filter((p) => !current.has(p));

    // chunk each changed file into symbol/section nodes (slice 2). Additive substrate — the
    // recall path below is untouched, so the file-granularity benchmark holds exactly.
    for (const u of upserts) u.nodes = await chunkFile(u.path, u.body);

    this.store.applyChanges({ upserts, touch, deletes }, Date.now());

    const added = upserts.filter((u) => !prev.has(u.path)).length;
    return { files: this.store.count(), added, updated: upserts.length - added, removed: deletes.length, unchanged };
  }

  /**
   * Ranked recall over the index, scoped by memory `kind`.
   *
   * Kinds never share a ranking, so high-volume prose can't bury code (§5): each kind is
   * FTS-gated and BM25-ranked only against its own kind, in a separate query. Three modes:
   * - **single kind** (`kind: "code"`) → a flat ranked `Hit[]`, default depth `n = 10`.
   * - **multiple kinds** (`kind: ["code", "doc"]`) → results grouped per kind, default `n = 5` each.
   * - **omitted** (`recall(q)`) → grouped over all known {@link KINDS}, default `n = 5` each —
   *   the safe default for a CLI or an agent that didn't state a kind (never a flattened ranking).
   *
   * `n` caps results **per kind**; raise it to dig deeper. There is no hard cap and no
   * pagination — a larger `n` is a larger context, which is the caller's budget to manage.
   *
   * @overload
   * @param {string} query
   * @param {{ kind: string, n?: number }} opts
   * @returns {import("./store.js").Hit[]}
   */
  /**
   * @overload
   * @param {string} query
   * @param {{ kind?: string[], n?: number }} [opts]
   * @returns {Record<string, import("./store.js").Hit[]>}
   */
  /**
   * @param {string} query
   * @param {{ kind?: string | string[], n?: number }} [opts]
   * @returns {import("./store.js").Hit[] | Record<string, import("./store.js").Hit[]>}
   */
  recall(query, opts = {}) {
    const match = ftsMatch(query);
    if (typeof opts.kind === "string") {
      // single kind → one flat ranked list
      return match ? this.store.search(match, opts.kind, opts.n ?? 10) : [];
    }
    // grouped: an explicit subset of kinds, or all known kinds when omitted. One FTS query per
    // kind, each ranked against only its own kind — no kind ever competes with another for rank.
    const kinds = Array.isArray(opts.kind) ? opts.kind : KINDS;
    const n = opts.n ?? 5;
    /** @type {Record<string, import("./store.js").Hit[]>} */
    const grouped = {};
    for (const k of kinds) grouped[k] = match ? this.store.search(match, k, n) : [];
    return grouped;
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
