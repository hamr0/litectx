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
import { chunkAndImports } from "./chunker.js";
import { buildResolveCtx, resolveImports } from "./edges.js";
import { collectGitSig } from "./gitsig.js";
import { computeImpact } from "./impact.js";
import { ftsMatch } from "./tokenize.js";
import { Embedder, cosine } from "./embedder.js";

const DEFAULT_INCLUDE = [".ts", ".js", ".mjs", ".cjs", ".py", ".md"];

// Embeddings tier (slice 6): when on, recall re-ranks a wider BM25-gated pool by semantic cosine.
// POOL is the candidate set the semantic signal can reorder — 400 matches the POC (a true answer
// ranked deep by BM25 can still be lifted). Weight 1.0 is the POC-validated default (held-out repo
// confirmed no overfitting cliff); the bench is NL-only, so it's deliberately not pushed higher.
const SEMANTIC_POOL = 400;
const DEFAULT_EMBED_WEIGHT = 1.0;
const QUERY_CACHE_CAP = 128; // LRU of query→vector so repeated queries skip re-embedding (aurora-borrowed)

/** Min–max normalise to [0,1] so BM25-spread scores and cosine compose on one scale. @param {number[]} a */
function minmax(a) {
  const lo = Math.min(...a);
  const hi = Math.max(...a);
  return a.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 1));
}

// v1 default ranking = BM25 + 1-hop import-spreading (additive boost; see store.search). Weight
// settled on a 4-repo bench (aurora py, gitdone+multis js, aurora-mixed): additive@0.3 is the only
// setting positive on ALL FOUR (worst-case +0.008) with the fewest regressions. It is NOT the
// max-MRR setting on aurora alone — additive@0.7 scores higher there (+0.044) but drives the
// held-out multis repo BELOW baseline (−0.024). The two non-tuning repos (gitdone, multis) both
// peak low and punish high weight, so 0.3 is the robust pick; higher weights overfit aurora.
const SPREAD_WEIGHT = 0.3;

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
 * @property {boolean} [embeddings]        enable the opt-in semantic tier (default false). When on,
 *                                         `index()` embeds each file and `recall()` fuses cosine into
 *                                         the ranking. Requires the optional peer dep `@xenova/transformers`.
 * @property {number} [embedWeight]        semantic fusion weight (default 1.0); higher = more semantic
 * @property {string} [embedModel]         transformers.js model id (default Xenova/all-MiniLM-L6-v2)
 * @property {{ embed(text: string): Promise<Float32Array> }} [embedder]  inject a custom/stub embedder
 *                                         (advanced/testing); overrides the built-in model loading
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

    // embeddings tier (slice 6) — off by default. The embedder is lazy: built on first use only when
    // the tier is on (or injected for tests), so the default path never imports the ML dependency.
    this.embeddings = config.embeddings ?? false;
    this.embedWeight = config.embedWeight ?? DEFAULT_EMBED_WEIGHT;
    this.embedModel = config.embedModel;
    /** @type {{ embed(text: string): Promise<Float32Array> } | null} */
    this._embedder = config.embedder ?? null;
    /** @type {Map<string, Float32Array>} LRU query-embedding cache */
    this._qcache = new Map();
  }

  /** The embedder for this instance — injected, or lazily constructed when the tier is on. */
  get embedder() {
    if (!this._embedder) this._embedder = new Embedder({ model: this.embedModel });
    return this._embedder;
  }

  /** Embed a query with a small LRU cache (repeated queries skip the model). @param {string} q */
  async _embedQuery(q) {
    const hit = this._qcache.get(q);
    if (hit) {
      this._qcache.delete(q); // refresh recency
      this._qcache.set(q, hit);
      return hit;
    }
    const v = await this.embedder.embed(q);
    this._qcache.set(q, v);
    if (this._qcache.size > QUERY_CACHE_CAP) this._qcache.delete(this._qcache.keys().next().value);
    return v;
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

    // chunk each changed file into symbol/section nodes + collect its import specifiers, in one
    // parse (slice 2 + 4). Chunks are additive substrate; imports become edges below.
    for (const u of upserts) {
      const r = await chunkAndImports(u.path, u.body);
      u.nodes = r.chunks;
      u.imports = r.imports;
    }

    // resolve each changed file's imports to intra-repo edges (slice 4). The resolver indexes
    // the FULL current file list (paths only), so a changed file's imports resolve against the
    // whole repo — not just the other files that changed this pass.
    const ctx = buildResolveCtx(files);
    for (const u of upserts) u.edges = resolveImports(u.format, u.path, u.imports ?? [], ctx);

    // git activity metadata for the changed files (slice 4) — one `git log` pass, scoped like the
    // index. Grounding shown on hits, never scored (§4.1). Skipped when nothing changed.
    if (upserts.length) {
      const sig = collectGitSig(this.root, opts.paths ?? this.pathspecs);
      for (const u of upserts) u.git = sig.get(u.path);
    }

    // embeddings tier (slice 6): embed ONLY the changed files (incremental — unchanged files keep
    // their stored vector). File-level, head-truncated text (POC-validated). The vector rides on the
    // upsert into `applyChanges`, written as a BLOB. Sequential by design (batching deferred).
    if (this.embeddings) {
      for (const u of upserts) u.embedding = await this.embedder.embed(u.body);
    }

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
   * **Async** since slice 6: the embeddings tier embeds the query at call time. With embeddings off
   * (the default) no model is touched — the work is synchronous, just wrapped in a resolved promise.
   *
   * @overload
   * @param {string} query
   * @param {{ kind: string, n?: number }} opts
   * @returns {Promise<import("./store.js").Hit[]>}
   */
  /**
   * @overload
   * @param {string} query
   * @param {{ kind?: string[], n?: number }} [opts]
   * @returns {Promise<Record<string, import("./store.js").Hit[]>>}
   */
  /**
   * @param {string} query
   * @param {{ kind?: string | string[], n?: number }} [opts]
   * @returns {Promise<import("./store.js").Hit[] | Record<string, import("./store.js").Hit[]>>}
   */
  async recall(query, opts = {}) {
    const match = ftsMatch(query);
    // embed the query ONCE up front (cached) when the tier is on; per-kind ranking is then sync.
    const qvec = this.embeddings && match ? await this._embedQuery(query) : null;
    if (typeof opts.kind === "string") {
      // single kind → one flat ranked list
      return this._rankKind(match, opts.kind, opts.n ?? 10, qvec);
    }
    // grouped: an explicit subset of kinds, or all known kinds when omitted. One FTS query per
    // kind, each ranked against only its own kind — no kind ever competes with another for rank.
    const kinds = Array.isArray(opts.kind) ? opts.kind : KINDS;
    const n = opts.n ?? 5;
    /** @type {Record<string, import("./store.js").Hit[]>} */
    const grouped = {};
    for (const k of kinds) grouped[k] = this._rankKind(match, k, n, qvec);
    return grouped;
  }

  /**
   * Rank one kind. Dual path (BM25 + spreading) when `qvec` is null; tri-hybrid when it's the query
   * vector — a wider BM25-gated pool re-ranked by `norm(dual) + weight·norm(cosine)`, then sliced to
   * `n`. The pool is the only place cosine runs (gated, ~hundreds), so it's O(pool), not O(corpus).
   * @param {string|null} match  FTS expression, or null when the query has no usable terms
   * @param {string} kind
   * @param {number} n
   * @param {Float32Array|null} qvec
   * @returns {import("./store.js").Hit[]}
   */
  _rankKind(match, kind, n, qvec) {
    if (!match) return [];
    if (!qvec) return this.store.search(match, kind, n, SPREAD_WEIGHT); // dual path (unchanged contract)
    const pool = this.store.search(match, kind, Math.max(n, SEMANTIC_POOL), SPREAD_WEIGHT);
    if (pool.length < 2) return pool.slice(0, n);
    const vecs = this.store.getEmbeddings(pool.map((h) => h.path));
    const sN = minmax(pool.map((h) => h.score));
    const cN = minmax(pool.map((h) => cosine(qvec, vecs.get(h.path))));
    return pool
      .map((h, i) => ({ h, f: sN[i] + this.embedWeight * cN[i] }))
      .sort((a, b) => b.f - a.f)
      .slice(0, n)
      .map((x) => x.h);
  }

  /**
   * The **impact** view (§7): for a symbol, its blast radius and change-risk bucket. Computed on
   * demand — callees via a tree-sitter walk of the symbol's body, callers via an `rg -w` sweep
   * confirmed with tree-sitter; no LSP. Built around the §7.2 asymmetry (over-count safe,
   * under-count dangerous): connectivity may be overstated, but "isolated / low-risk" only ever
   * ships **hedged**. Returns `null` when the symbol isn't defined in the index.
   *
   * @param {string} symbol  the symbol name to assess
   * @returns {Promise<import("./impact.js").Impact | null>}
   */
  async impact(symbol) {
    return computeImpact(this.store, this.root, this.include, symbol);
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
export { Embedder, cosine } from "./embedder.js";
