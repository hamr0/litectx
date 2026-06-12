// litectx public API.
//
// index files into SQLite/FTS5 and rank recall by BM25, at file granularity. The API shape
// is the one later slices grow into — symbol-level chunking, activation, and the impact view
// slot in behind `index()` and `recall()` without changing these signatures.
//
// Slice 1: `index()` is incremental and git-aware — it re-reads only files whose content
// changed and drops files that disappeared (§6).

import { join, dirname } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { Store, MEM_KINDS } from "./store.js";
import { collectFiles, diffFiles } from "./indexer.js";
import { chunkAndImports } from "./chunker.js";
import { buildResolveCtx, resolveImports } from "./edges.js";
import { collectGitSig } from "./gitsig.js";
import { computeImpact } from "./impact.js";
import { ftsMatch, keywords } from "./tokenize.js";
import { Embedder, cosine } from "./embedder.js";

const DEFAULT_INCLUDE = [".ts", ".js", ".mjs", ".cjs", ".py", ".md"];

// Embeddings tier (slice 6): when on, recall re-ranks a wider BM25-gated pool by semantic cosine.
// POOL is the candidate set the semantic signal can reorder — 400 matches the POC (a true answer
// ranked deep by BM25 can still be lifted). Weight 1.0 is the POC-validated default (held-out repo
// confirmed no overfitting cliff); the bench is NL-only, so it's deliberately not pushed higher.
const SEMANTIC_POOL = 400;
const DEFAULT_EMBED_WEIGHT = 1.0;
const QUERY_CACHE_CAP = 128; // LRU of query→vector so repeated queries skip re-embedding (aurora-borrowed)
// KNN union (slice 11): written kinds (fact/episode) also get up to K semantic NOMINEES — stored
// vectors nearest the query by cosine — unioned into the lexical pool, so a zero-shared-term
// paraphrase can reach a fact at all (the gate alone returns nothing for it). K=8 swept on the
// memory bench (poc/knn-union-poc.mjs): para 0.000→0.574, morph 0.722→0.889, exact holds 1.000;
// an admission threshold only hurt (true-paraphrase cosines run low), so there is none.
const KNN_K = 8;

// Episode promotion ladder (slice 5b, §14 #4 view #4). Episodes are the agent's ephemeral
// scratchpad; they graduate by USE into durable facts. ACTIVE_EPISODE_DAYS = the rolling window an
// episode stays promote-eligible AND retained — older episodes self-prune on the next episode write
// (anything that mattered was already distilled into a fact, which never prunes). 30 days is long
// enough to promote-and-prove and keeps the set bounded with one knob (no count cap). The promote
// threshold runs higher than facts' review (10 vs 5) — episodes are noisier and more numerous.
const ACTIVE_EPISODE_DAYS = 30;
const EPISODE_PROMOTE_THRESHOLD = 10;
const DAY_MS = 86_400_000;

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
 * The canonical memory-kind vocabulary — the kinds a bare `recall(query)` groups over. `code`
 * (ts/js/py) + `doc` (md) enter via `index()` (files, routed by `indexer.classify`); `fact` +
 * `episode` enter via `remember()` (written directly — slice 7, §3.2). `doc` is the one kind both
 * paths produce. A bare grouped `recall` returns a (possibly empty) list per kind.
 * @type {string[]}
 */
export const KINDS = ["code", "doc", "fact", "episode"];

/**
 * @typedef {Object} LiteCtxConfig
 * @property {string} root                 repo root to index
 * @property {string[]} [include]          file extensions to index (default: ts/js/py/md)
 * @property {string[]} [pathspecs]        optional git pathspecs to scope the index (e.g. ["app/**\/*.js"])
 * @property {string} [dbPath]             SQLite file path (default: <root>/.litectx/index.db)
 * @property {boolean} [embeddings]        enable the opt-in semantic tier (default false). When on,
 *                                         `index()` embeds each file and `recall()` fuses cosine into
 *                                         the ranking. Requires the optional peer dep `@huggingface/transformers`.
 * @property {number} [embedWeight]        semantic fusion weight (default 1.0); higher = more semantic
 * @property {string} [embedModel]         transformers.js model id (default Xenova/all-MiniLM-L6-v2)
 * @property {{ embed(text: string): Promise<Float32Array> }} [embedder]  inject a custom/stub embedder
 *                                         (advanced/testing); overrides the built-in model loading
 */

/**
 * @typedef {Object} Item
 * @property {string} id                 the written-memory id, or the file's repo-relative path
 * @property {string} kind               "code" | "doc" | "fact" | "episode"
 * @property {string} format             "ts" | "js" | "py" | "md" | "text" | ...
 * @property {string} source             "file" (indexed from disk) | "direct" (written via remember)
 * @property {string|null} provenance    "human" | "agent" for written memory; null for indexed files
 * @property {number|null} occurredAt    episode timestamp (epoch ms); null otherwise
 * @property {string|null} text          the full body — written memory verbatim as remembered, files
 *                                       read fresh from disk; null only when the file is gone
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

  /**
   * Embed text, degrading gracefully when the optional model dependency (`@huggingface/transformers`)
   * can't load: disable the tier for this instance, warn once to stderr, and return `null` so
   * callers fall back to BM25. An injected embedder (tests) or a present dep never trips this.
   * @param {string} text @returns {Promise<Float32Array|null>}
   */
  async _embedSafe(text) {
    try {
      return await this.embedder.embed(text);
    } catch (e) {
      if (this.embeddings) {
        this.embeddings = false; // one-shot: subsequent calls skip the tier entirely
        console.error(
          `litectx: embeddings unavailable (${e instanceof Error ? e.message : e}) — falling back to BM25. ` +
            "Run `npm i @huggingface/transformers` to enable semantic recall."
        );
      }
      return null;
    }
  }

  /** Embed a query with a small LRU cache (repeated queries skip the model). @param {string} q */
  async _embedQuery(q) {
    const hit = this._qcache.get(q);
    if (hit) {
      this._qcache.delete(q); // refresh recency
      this._qcache.set(q, hit);
      return hit;
    }
    const v = await this._embedSafe(q);
    if (v === null) return null; // tier unavailable → BM25 path
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
    // force = re-read every FILE from disk. Written memory is not re-derivable from any file and
    // must survive even a force pass (§3.2) — so this clears file-sourced data only, never reset().
    if (opts.force) this.store.clearIndexed();
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
      for (const u of upserts) {
        const v = await this._embedSafe(u.body);
        if (v === null) break; // tier unavailable — index BM25-only from here
        u.embedding = v;
      }
    }

    // record per-chunk edits (slice 5a) only on an incremental pass over an existing index — a cold
    // first build or a `force` rebuild mass-inserts every chunk, which is loading, not editing. `prev`
    // is empty in both those cases (force clears it above), so its size is the cold-build test.
    this.store.applyChanges({ upserts, touch, deletes }, Date.now(), prev.size > 0);

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
   * Every hit carries a `chunk` pointer — the best-matching function/section inside the file
   * (chunk-granular recall; `null` for written memory, where the row is the unit). Ranking stays
   * file-level and is unchanged by this: the pointer localizes, it never reorders.
   *
   * `log: false` skips the recall audit log. The log is a **demand signal** — anything that isn't
   * real demand (dashboards, CI checks, batch tooling, read-only-db consumers) must not write to it.
   *
   * @overload
   * @param {string} query
   * @param {{ kind: string, n?: number, log?: boolean }} opts
   * @returns {Promise<import("./store.js").Hit[]>}
   */
  /**
   * @overload
   * @param {string} query
   * @param {{ kind?: string[], n?: number, log?: boolean }} [opts]
   * @returns {Promise<Record<string, import("./store.js").Hit[]>>}
   */
  /**
   * @param {string} query
   * @param {{ kind?: string | string[], n?: number, log?: boolean }} [opts]
   * @returns {Promise<import("./store.js").Hit[] | Record<string, import("./store.js").Hit[]>>}
   */
  async recall(query, opts = {}) {
    const match = ftsMatch(query);
    // embed the query ONCE up front (cached) when the tier is on; per-kind ranking is then sync.
    const qvec = this.embeddings && match ? await this._embedQuery(query) : null;
    const terms = keywords(query); // for chunk localization — same split the FTS body uses
    if (typeof opts.kind === "string") {
      // single kind → one flat ranked list
      const hits = this.store.attachChunks(this._rankKind(match, opts.kind, opts.n ?? 10, qvec), terms);
      if (MEM_KINDS.has(opts.kind)) this.store.attachMemMeta(hits); // slice 5c: surface provenance/use/occurredAt — read, never scored
      if (opts.log !== false) this.store.logRecall(hits, Date.now()); // audit log (slice 7, §3.2) — recorded, not scored
      return hits;
    }
    // grouped: an explicit subset of kinds, or all known kinds when omitted. One FTS query per
    // kind, each ranked against only its own kind — no kind ever competes with another for rank.
    const kinds = Array.isArray(opts.kind) ? opts.kind : KINDS;
    const n = opts.n ?? 5;
    /** @type {Record<string, import("./store.js").Hit[]>} */
    const grouped = {};
    for (const k of kinds) {
      grouped[k] = this.store.attachChunks(this._rankKind(match, k, n, qvec), terms);
      if (MEM_KINDS.has(k)) this.store.attachMemMeta(grouped[k]); // slice 5c: written-memory columns (read, never scored)
    }
    if (opts.log !== false) this.store.logRecall(Object.values(grouped).flat(), Date.now());
    return grouped;
  }

  /**
   * Rank one kind. Dual path (BM25 + spreading) when `qvec` is null; tri-hybrid when it's the query
   * vector — a wider BM25-gated pool re-ranked by `norm(dual) + weight·norm(cosine)`, then sliced to
   * `n`. Cosine runs on the pool plus at most {@link KNN_K} nominees, so it stays O(pool), never
   * O(corpus) for files.
   *
   * **Written kinds (slice 11): cosine also NOMINATES, not just re-ranks.** For `fact`/`episode`,
   * up to {@link KNN_K} stored vectors nearest the query are unioned into the pool before fusion —
   * so a zero-shared-term paraphrase ("money back" → a refunds fact) is reachable at all. Nominees
   * enter at the pool's score floor and compete on semantics alone; lexical hits keep their head
   * start. `code`/`doc` stay strictly gate-then-rerank (their queries share identifiers with their
   * answers, and their corpora are where a full scan would cost).
   * @param {string|null} match  FTS expression, or null when the query has no usable terms
   * @param {string} kind
   * @param {number} n
   * @param {Float32Array|null} qvec
   * @returns {import("./store.js").Hit[]}
   */
  _rankKind(match, kind, n, qvec) {
    if (!qvec) return match ? this.store.search(match, kind, n, SPREAD_WEIGHT) : []; // dual path (unchanged contract)
    const pool = match ? this.store.search(match, kind, Math.max(n, SEMANTIC_POOL), SPREAD_WEIGHT) : [];
    const knn = this.store.knnCandidates(kind, qvec, KNN_K, new Set(pool.map((h) => h.path)));
    const cand = pool.concat(knn);
    if (cand.length < 2) return cand.slice(0, n);
    const vecs = this.store.getEmbeddings(cand.map((h) => h.path));
    // nominees carry no lexical score — they enter at the pool floor and rank on cosine alone
    const floor = pool.length ? Math.min(...pool.map((h) => h.score)) : 0;
    const sN = minmax(cand.map((h, i) => (i < pool.length ? h.score : floor)));
    const cN = minmax(cand.map((h) => cosine(qvec, vecs.get(h.path))));
    return cand
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

  /**
   * Fetch one stored item's full record by id — the body-access counterpart to `recall` (slice 9).
   * Recall returns ranked pointers (paths/ids); `get` returns the thing itself. Any id works:
   * a written-memory id (`"fact:auth-uses-jwt"`) returns the text exactly as remembered, and an
   * indexed file's repo-relative path (`"src/auth.js"`) returns the file read fresh from disk —
   * the index stores the *searchable surface*, not a copy of your files. `text` is `null` only
   * when an indexed file has vanished from disk since the last `index()` pass.
   *
   * Each `get` appends an `action: 'fetch'` row to the audit log — a **tagged weak signal**, kept
   * apart from recall's demand signal: you fetch what recall just returned, so counting fetches as
   * demand would double-count every retrieval (the fetch-toll). Nothing reads the tag yet; it earns
   * weight (if any) at the action-signal bench. `log: false` opts out, same as `recall`.
   *
   * Sync (no embedder involved). Returns `null` for an unknown id.
   *
   * @param {string} id  a written-memory id, a stashed payload's id, or an indexed file's repo-relative path
   * @param {{ log?: boolean }} [opts]
   * @returns {Item | null}
   */
  get(id, opts = {}) {
    const r = this.store.getItem(id);
    if (!r) return null;
    let text = r.text;
    if (r.source === "file") {
      try {
        text = readFileSync(join(this.root, r.path), "utf8");
      } catch {
        text = null; // indexed but gone from disk — stale until the next index() sweeps it
      }
    }
    if (opts.log !== false) this.store.logRecall([{ path: r.path, kind: r.kind }], Date.now(), "fetch");
    return { id: r.path, kind: r.kind, format: r.format, source: r.source, provenance: r.provenance, occurredAt: r.occurred_at, text };
  }

  /**
   * Write a directly-authored memory — a `fact`/`episode`/`doc` with no file behind it (§3.2). This
   * is the write counterpart to `index()`: knowledge that isn't a file enters here. Upsert by `id`
   * (also the update/forget handle — recommend namespacing it, e.g. `"fact:auth-uses-jwt"`). Stored
   * **whole** (never chunked). Written rows are `source='direct'`, so `index()` never reconciles them
   * away; recall finds them like any other kind. Embeds the text when the embeddings tier is on.
   *
   * @param {string} id    caller key / identity (lands in the row's `path`)
   * @param {string} text  the content
   * @param {{ kind?: string, format?: string, by?: string, occurredAt?: number }} [opts]
   *   `kind` ∈ {fact, episode, doc} (default `fact`); `by` = provenance `"human"|"agent"` (default
   *   `"agent"`); `occurredAt` = episode timestamp (epoch ms, default now; ignored for non-episodes);
   *   `format` defaults to `md` for docs, `text` otherwise.
   * @returns {Promise<void>}
   */
  async remember(id, text, opts = {}) {
    const kind = opts.kind ?? "fact";
    if (kind !== "fact" && kind !== "episode" && kind !== "doc") {
      throw new Error(`remember: kind must be fact | episode | doc (got "${kind}"); code/doc-from-file enter via index()`);
    }
    const by = opts.by ?? "agent";
    if (by !== "human" && by !== "agent") throw new Error(`remember: by must be "human" | "agent" (got "${by}")`);
    const format = opts.format ?? (kind === "doc" ? "md" : "text");
    const occurredAt = kind === "episode" ? opts.occurredAt ?? Date.now() : null;
    const embedding = this.embeddings ? ((await this._embedSafe(text)) ?? undefined) : undefined;
    // slice 5b ephemerality: an episode write trims the scratchpad of PREVIOUSLY-accumulated episodes
    // past the rolling active window (anything that mattered was distilled into a durable fact, which
    // never prunes). Bounds the store with no cron; only episode writes grow the set, so that is where
    // it's trimmed. Pruned BEFORE the write so the episode the caller just authored — even one with an
    // explicit backdated occurredAt — is always honored, never deleted by its own write.
    if (kind === "episode") this.store.pruneStaleEpisodes(Date.now() - ACTIVE_EPISODE_DAYS * DAY_MS);
    this.store.writeMemory({ id, text, kind, format, provenance: by, occurredAt, embedding });
  }

  /**
   * Forget directly-written memory (§3.2). Pass an `id` to drop one item, or a query
   * (`{ kind?, by? }`) for bulk human invalidation (e.g. drop every agent-asserted fact). **Only ever
   * removes `source='direct'` rows** — an indexed file is never touched. Returns the count removed.
   *
   * @param {string | { kind?: string, by?: string }} sel
   * @returns {number}
   */
  forget(sel) {
    if (typeof sel === "string") return this.store.forgetMemory({ id: sel });
    if (sel.kind == null && sel.by == null) throw new Error("forget(query) needs at least { kind } or { by }");
    return this.store.forgetMemory({ kind: sel.kind, provenance: sel.by });
  }

  /**
   * Park a payload in the keyed agent-context store and return its handle — the durable half of
   * **restorable compression** (R-C4). The caller drops a large payload (a tool result, a fetched
   * page, a file dump) from its context window, keeping only the cheap handle (`id`); {@link get}
   * rehydrates the full text on demand and {@link forget} evicts it when truly done. A stash is **not
   * memory**: it is never indexed and never recalled (it lives in no FTS table, so recall can't
   * surface it on any kind) and never auto-pruned — it is addressable only by exact `id`. Upsert by
   * `id` (also the rehydrate/evict handle; namespace it, e.g. `"stash:toolresult-42"`). Sync — a
   * stash is never embedded (it isn't meaning-searchable), which is the whole point.
   *
   * @param {string} id    caller-chosen handle / identity
   * @param {string} text  the payload to park
   * @returns {void}
   */
  stash(id, text) {
    this.store.writeStash({ id, text, createdAt: Date.now() });
  }

  /**
   * Peek a stashed payload (R-I3 handle / lazy-load): a cheap **head+tail** preview of a parked blob
   * *without* rehydrating it — the read-half of {@link stash}. Where {@link get} pays the whole
   * payload's tokens back, `peek` returns only `{ id, bytes, head, tail, createdAt, truncated }`: a
   * fixed-length prefix *and suffix* (the conclusion — exit code, failing frame, closing structure —
   * lives at the end), the true byte size, the parked-at time, and whether a middle span is elided
   * (`tail` is empty when the head already holds the whole payload). The agent reasons over the handle
   * and calls {@link get} to load the full body *only if it decides it needs it*. The win is the
   * **bounded result** — only ~head+tail bytes return to the caller, never the whole blob, so the
   * payload stays out of its context/token budget. (Not a DB-time win: SQLite reads the column to slice
   * it, so peek's local compute scales with payload size — `get` it directly if you'll load it anyway.)
   * **Stash-only**: recall owns ranked retrieval over memory; a stash is a dumb keyed blob, so `peek`
   * carries no weights and no ranking. Null for an unknown id.
   *
   * @param {string} id  a stashed payload's id (as passed to {@link stash})
   * @returns {{ id: string, bytes: number, head: string, tail: string, createdAt: number, truncated: boolean } | null}
   */
  peek(id) {
    return this.store.peekStash(id);
  }

  /**
   * Human-in-the-loop review candidates (§3.2): agent-asserted facts whose recall count has crossed
   * `threshold`. The intended loop is the **consumer's** — it shows each candidate to a human who
   * either validates it (re-`remember(id, text, { by: "human" })`, promoting it to durable/high-trust)
   * or invalidates it (`forget(id)`). litectx supplies only the candidate set + those two actions;
   * the threshold and the review flow are the consumer's. Review is earned by use, so a human never
   * sees every agent fact — only the ones that proved useful.
   * @param {number} [threshold=5]
   * @returns {{ path: string, hits: number }[]}
   */
  reviewCandidates(threshold = 5) {
    return this.store.reviewCandidates(threshold);
  }

  /**
   * Episode promotion candidates (§14 #4 view #4, slice 5b) — the agent-side first rung of the
   * promotion ladder. Returns agent-written `episode`s recalled at least `threshold` times within the
   * {@link ACTIVE_EPISODE_DAYS}-day rolling active window (older episodes have decayed out and
   * self-prune on the next episode write). The intended loop is the **consumer's agent**: read each
   * candidate (`get(id)`), distil a durable `fact` via `remember(id, text, { kind: "fact", by:
   * "agent" })` — which then rides the existing `reviewCandidates(5)` → human-validate path. litectx
   * **flags, never summarizes** (no extraction LLM): it supplies the trigger; the agent writes the
   * fact. The count gates **distillation, never ranking** — a frequently-recalled episode does not
   * rank higher (that would be the feedback loop §4 forbids). Threshold defaults higher than facts'
   * review (10 vs 5): episodes are noisier and more numerous.
   *
   * Unlike `reviewCandidates` (where a human re-`remember` flips provenance and drops the row),
   * distilling does not remove an episode — it stays a candidate until it ages out of the window (or
   * the consumer `forget`s it post-distillation). Re-distilling is harmless: the agent's fact id is a
   * stable handle, so a second pass upserts the same fact rather than duplicating it.
   * @param {number} [threshold=10]
   * @returns {{ path: string, hits: number }[]}
   */
  promotionCandidates(threshold = EPISODE_PROMOTE_THRESHOLD) {
    return this.store.promotionCandidates({ threshold, since: Date.now() - ACTIVE_EPISODE_DAYS * DAY_MS });
  }

  /**
   * "What was I working on" (§14 #4 view #3, slice 5a): the code/doc chunks litectx witnessed edited
   * most recently — newest first — inside a recency window. Each `index()` pass that sees a chunk's
   * body change (added or modified vs the stored node) logs an edit; a cold first/`force` build logs
   * nothing (loading isn't editing), so this stays empty until real edits are observed.
   *
   * An **isolated** read by design: it reads the witnessed edit log and never the ranking path, so it
   * cannot regress recall — the edit→recall re-rank ships at zero (falsified repo-dependent, §14 #4).
   * The edit signal's home is here (next-use / "where was I"), not in search scores.
   *
   * @param {{ days?: number, since?: number, limit?: number }} [opts]
   *   `since` (epoch ms) sets the window floor explicitly; otherwise `days` back from now (default 7).
   *   `limit` caps rows (default 20).
   * @returns {{ id: string, symbol: string|null, kind: string, lastEditedAt: number, edits: number }[]}
   *   `id` is the chunk's file path (feed it to `get`); `symbol` localizes within the file (null for a
   *   file's anonymous chunks, collapsed to one row); `edits` is how many index passes (sessions)
   *   changed it in the window; sorted by `lastEditedAt` desc.
   */
  recentActivity(opts = {}) {
    const since = opts.since ?? Date.now() - (opts.days ?? 7) * 86_400_000;
    return this.store.recentActivity({ since, limit: opts.limit ?? 20 });
  }

  /** @returns {number} total stored items — indexed documents + written memory */
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
