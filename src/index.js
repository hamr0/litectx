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
import { toWriteAction, WriteAudit, WriteDeniedError } from "./writegate.js";
import { observe } from "./contextgraph.js";
import { documentToSegments, classifyDocument, DEFAULT_MAX_SIZE } from "./docparse.js";

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

/** Derive a stable base id for an ingested document from its filename. @param {string} [filename] @returns {string} */
function deriveDocId(filename) {
  const base = (filename ?? "document").replace(/\.[^.]+$/, "").trim();
  const slug = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `doc:${slug || "document"}`;
}

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
 * The shared-tier scope sentinel (multis M3 fail-closed ask). Under `strictScope`, a missing scope
 * THROWS — so reading or writing the global knowledge base needs an explicit, unambiguous opt-in that
 * is never spelled the same as "I forgot." That is `GLOBAL`: pass it as a `scope` (to `recall`/`get`/
 * `ingest`/`remember`) or bind a `ctx.scoped(GLOBAL)` view to act on the global tier deliberately.
 *
 * It is a **read/write sentinel, never a stored value**: on write it maps to "no `doc_scope` row"
 * (`scope IS NULL`, exactly today's global rows); on read it maps to "`ds.scope IS NULL` only." So it
 * needs no migration and leaves the `scope ∪ NULL` union untouched. A unique Symbol so it can never
 * collide with a tenant scope string.
 * @type {symbol}
 */
export const GLOBAL = Symbol("litectx:global");

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
 * @property {string} [owner]              scope key (§4.4) — the actor that owns durable `fact`s (and
 *                                         tags `episode`s). Default unset = global/unscoped: recall
 *                                         sees & writes are owner-blind. A multi-tenant / shared-db host
 *                                         sets it (e.g. git email or OS user, resolved host-side) so a
 *                                         shared store isolates per actor; recall then returns own +
 *                                         global (NULL-owner) memory only.
 * @property {boolean} [strictScope]       fail-closed multi-tenant mode for the DOC axis (multis M3 ask).
 *                                         Default false = today's behaviour (a missing/`null` doc `scope`
 *                                         means "see everything" — correct single-tenant, a footgun on a
 *                                         shared store). When true, a missing scope on `recall({kind:'doc'})`,
 *                                         `get`, `ingest`, and `remember({kind:'doc'})` THROWS instead of
 *                                         returning/writing every tenant's rows; the only ways to act are an
 *                                         explicit tenant scope (`scope ∪ global`) or {@link GLOBAL} (the
 *                                         shared tier). Governs the doc/blob axis ONLY — `fact`/`episode`
 *                                         (the `owner`/`session` memory axis) and `code` are untouched.
 * @property {string} [session]            scope key (§4.4) — the run that owns volatile `episode`s.
 *                                         Default unset = durable/unscoped: recall sees all sessions'
 *                                         episodes. A host running concurrent agents sets it so a run's
 *                                         own episodes aren't buried by more-relevant other sessions
 *                                         (gate #1, 2026-06-13). `fact`s ignore it (always cross-session).
 * @property {WriteGateLike} [writeGate]   optional write-gate hook (CE-PRD §10.1) — when set, `remember()`
 *                                         emits a `{type:"memory.write", …}` action and `await`s
 *                                         `writeGate.check(action)` BEFORE persisting; a `deny` outcome
 *                                         throws {@link WriteDeniedError} and the write does not commit
 *                                         (`ask`/`allow` proceed). Duck-typed — bareguard's `Gate` when
 *                                         embedded, any `.check`-shaped object standalone. litectx is not
 *                                         coupled to a gate version. Default unset = no gate (byte-identical
 *                                         to pre-hook writes).
 * @property {WriteAudit} [writeAudit]     optional standalone audit sink (the paper-trail half §10.1) —
 *                                         when set with `writeGate`, each write decision is recorded. A
 *                                         host-supplied `redact` on it scrubs secrets (litectx ships none).
 * @property {boolean} [trace]             when true, the instance is returned wrapped in `observe()` — every
 *                                         CE verb call is recorded into `ctx.trace` (a `ContextGraph`). Off
 *                                         by default = the bare instance, no proxy. See `src/contextgraph.js`.
 */
/** @typedef {import("./writegate.js").WriteGateLike} WriteGateLike */

/**
 * @typedef {Object} Item
 * @property {string} id                 the written-memory id, or the file's repo-relative path
 * @property {string} kind               "code" | "doc" | "fact" | "episode"
 * @property {string} format             "ts" | "js" | "py" | "md" | "text" | ...
 * @property {string} source             "file" (indexed from disk) | "direct" (written via remember)
 * @property {string|null} provenance    "human" | "agent" for written memory; null for indexed files
 * @property {number|null} occurredAt    episode timestamp (epoch ms); null otherwise
 * @property {string|null} text          the full body — written memory verbatim as remembered, files
 *                                       read fresh from disk; null when the file is gone, or for a blob
 *                                       (a byte-exact upload — its payload is in `bytes`, not text)
 * @property {Buffer|null} bytes         a byte-exact upload's original bytes (R3); null for every other
 *                                       kind and for file rows
 * @property {Record<string, unknown>|null} meta  opaque caller metadata (RT-3 #3) as supplied to
 *                                       `remember`, returned verbatim; null for files and for memory
 *                                       with none
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
    // scope keys (§4.4 Isolate): the actor + run this instance acts as. Default null = unscoped
    // (global / durable) → recall sees everything and writes are unscoped, byte-identical to the
    // pre-scope behavior. A host threads identity in to isolate (owner = actor; session = run).
    this.owner = config.owner ?? null;
    this.session = config.session ?? null;
    // fail-closed DOC-axis scope (multis M3 ask): off = legacy (null scope = see-all); on = a missing
    // doc scope throws on read AND write, so a forgotten scope is a loud error, never a silent tenant leak.
    this.strictScope = config.strictScope ?? false;
    this.store = new Store(this.dbPath, { owner: this.owner, session: this.session });

    // embeddings tier (slice 6) — off by default. The embedder is lazy: built on first use only when
    // the tier is on (or injected for tests), so the default path never imports the ML dependency.
    this.embeddings = config.embeddings ?? false;
    this.embedWeight = config.embedWeight ?? DEFAULT_EMBED_WEIGHT;
    this.embedModel = config.embedModel;
    /** @type {{ embed(text: string): Promise<Float32Array> } | null} */
    this._embedder = config.embedder ?? null;
    /** @type {Map<string, Float32Array>} LRU query-embedding cache */
    this._qcache = new Map();

    // write-gate (§10.1) — opt-in. When wired, remember() emits a gate-able action and checks it
    // before persisting; default unset = no gate, byte-identical to pre-hook writes.
    /** @type {WriteGateLike | null} */
    this.writeGate = config.writeGate ?? null;
    /** @type {WriteAudit | null} */
    this.writeAudit = config.writeAudit ?? null;

    // contextgraph (opt-in): trace:true returns the instance wrapped in observe(), so every CE verb call
    // is recorded into ctx.trace. Off by default = the bare instance, no proxy, zero overhead.
    if (config.trace) return observe(this);
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
   * Resolve a caller's `scope` arg for a READ (`recall`/`get`) into the store's tri-state filter,
   * applying the strictScope policy (multis M3 fail-closed ask). The whole point: a *missing* scope
   * and a *deliberate* all/global read must not share a spelling.
   * - {@link GLOBAL} → the shared tier only (`{ scope: null, seeAll: false, globalOnly: true }`).
   * - a tenant string → `scope ∪ global` (`{ scope, seeAll: false, globalOnly: false }`).
   * - omitted/`null` → under `strict`, THROW; otherwise the legacy see-all (`{ seeAll: true }`).
   * @param {string | symbol | null | undefined} scope
   * @param {boolean} strict  enforce (throw on a missing scope) — the caller decides per-axis
   * @param {string} op  label for the thrown error
   * @returns {{ scope: string|null, seeAll: boolean, globalOnly: boolean }}
   */
  _resolveReadScope(scope, strict, op) {
    if (scope === GLOBAL) return { scope: null, seeAll: false, globalOnly: true };
    if (scope == null) {
      if (strict) throw new Error(`litectx: ${op} requires an explicit scope under strictScope — pass a tenant scope string or GLOBAL (got none)`);
      return { scope: null, seeAll: true, globalOnly: false };
    }
    if (typeof scope !== "string") throw new Error(`litectx: scope must be a string, GLOBAL, or omitted (got ${typeof scope})`);
    return { scope, seeAll: false, globalOnly: false };
  }

  /**
   * Resolve a caller's `scope` arg for a WRITE (`ingest`/`remember` on the doc axis) into the stored
   * `doc_scope` value, applying strictScope. {@link GLOBAL} and omitted-when-not-strict both map to
   * `null` (the shared tier = no `doc_scope` row); a missing scope under `strict` THROWS — so an
   * accidental publish-to-everyone is impossible, the persistent-leak half of the ask.
   * @param {string | symbol | null | undefined} scope
   * @param {boolean} strict
   * @param {string} op
   * @returns {string | null}
   */
  _resolveWriteScope(scope, strict, op) {
    if (scope === GLOBAL) return null;
    if (scope == null) {
      if (strict) throw new Error(`litectx: ${op} requires an explicit scope under strictScope — pass a tenant scope string or GLOBAL to write the shared tier (got none)`);
      return null;
    }
    if (typeof scope !== "string") throw new Error(`litectx: scope must be a string, GLOBAL, or omitted (got ${typeof scope})`);
    return scope;
  }

  /**
   * Resolve a caller's `scope` arg for a memory-axis READ (`recall`/`reviewCandidates`/
   * `promotionCandidates` over `fact`/`episode`) into the store's owner fence (multis M4). The memory
   * axis historically fenced ONLY by the instance `owner` set at construction; this lets one shared
   * instance fence per tenant by threading the scope through per call (via {@link scoped} or an explicit
   * `scope`). The mapping mirrors the doc-axis `_resolveReadScope` but targets `owner`:
   * - a tenant string → that owner ∪ global (`{ memOwner: scope, memSeeAll: false }`).
   * - {@link GLOBAL} → the shared tier only (`{ memOwner: null, memSeeAll: false }`).
   * - omitted/`null` → under `strictScope`, THROW (fail-closed, the M4 ask); otherwise fall back to the
   *   INSTANCE owner — so a single-tenant instance (owner set at construction, strict off) is unchanged.
   * @param {string | symbol | null | undefined} scope
   * @param {string} op  label for the thrown error
   * @returns {{ memOwner: string|null, memSeeAll: boolean }}
   */
  _resolveMemReadScope(scope, op) {
    if (scope === GLOBAL) return { memOwner: null, memSeeAll: false };
    if (typeof scope === "string") return { memOwner: scope, memSeeAll: false };
    if (scope != null) throw new Error(`litectx: scope must be a string, GLOBAL, or omitted (got ${typeof scope})`);
    if (this.strictScope) throw new Error(`litectx: ${op} requires an explicit scope under strictScope — pass a tenant scope string or GLOBAL (got none)`);
    return { memOwner: this.owner, memSeeAll: this.owner == null };
  }

  /**
   * Resolve a caller's `scope` arg for a memory-axis WRITE (`remember` over `fact`/`episode`) into the
   * stored `mem_scope.owner` (multis M4). {@link GLOBAL} → `null` (the shared tier); a tenant string →
   * that owner; omitted/`null` → under `strictScope` THROW (fail-closed), else the INSTANCE owner
   * (legacy single-tenant). So an accidental un-scoped tenant write is impossible under strict.
   * @param {string | symbol | null | undefined} scope
   * @param {string} op
   * @returns {string | null}
   */
  _resolveMemWriteOwner(scope, op) {
    if (scope === GLOBAL) return null;
    if (typeof scope === "string") return scope;
    if (scope != null) throw new Error(`litectx: scope must be a string, GLOBAL, or omitted (got ${typeof scope})`);
    if (this.strictScope) throw new Error(`litectx: ${op} requires an explicit scope under strictScope — pass a tenant scope string or GLOBAL to write the shared tier (got none)`);
    return this.owner;
  }

  /**
   * A scope-bound view (multis M3 fail-closed ask, layer c) — the doc-axis equivalent of binding
   * `owner`/`session` on the instance. `ctx.scoped('user:42')` returns a handle whose `recall`/`get`/
   * `ingest`/`remember` carry that scope automatically, so "forgot to pass a scope" becomes a
   * non-existent code path (the per-call `scope` is gone, there is nothing to omit). This is the
   * blessed multi-tenant pattern: it works regardless of `strictScope`, but pairs with it (the flag
   * makes the BASE methods safe; the view makes the safe path the only path the caller touches).
   *
   * Pass {@link GLOBAL} for a shared-tier (KB) view. A bad bind (null/omitted/non-string-non-GLOBAL)
   * throws HERE, at creation — a scope-bound view with no scope is the very footgun this closes, so
   * it can never be constructed. The bound scope is fixed: the returned methods ignore any `scope`
   * passed in their opts.
   * @param {string | symbol} scope  a tenant scope string, or {@link GLOBAL} for the shared tier
   * @returns {ScopedView}
   */
  scoped(scope) {
    if (scope !== GLOBAL && typeof scope !== "string") {
      throw new Error("litectx: scoped(scope) requires a tenant scope string or GLOBAL (a scope-bound view can't have no scope)");
    }
    return new ScopedView(this, scope);
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
   * `body: true` inlines each hit's content as `hit.body` (off by default — recall returns pointers,
   * not payloads). litectx owns this because *where the body lives is kind-dependent*: written memory
   * comes back VERBATIM; a file hit returns its localized chunk's indexed text, or the whole file when
   * nothing localized. Opt in when mounting litectx as a memory store or feeding an assembler. (A blob
   * hit — a byte-exact upload, R3 — has no text body: `body` is null; fetch its bytes with {@link get}.)
   *
   * `scope` (multis M3 R2 / M4) fences BOTH per-upload axes: direct doc/blob rows to `scope ∪ null-global`
   * (a chat sees its uploads + the global KB, never another chat's) AND `fact`/`episode` rows to that
   * tenant's owner ∪ global (multis M4 — one shared instance fences memory per tenant; {@link GLOBAL} =
   * the shared tier only). Unset = unscoped = the instance owner's view (sees everything when the instance
   * is ownerless; under `strictScope`, a memory- or doc-touching recall with no scope THROWS — fail-closed).
   * Code/file rows are repo-global, unaffected. Expired rows (R5 `expiresAt`) are always excluded.
   *
   * @overload
   * @param {string} query
   * @param {{ kind: string, n?: number, log?: boolean, body?: boolean, scope?: string | symbol }} opts
   * @returns {Promise<import("./store.js").Hit[]>}
   */
  /**
   * @overload
   * @param {string} query
   * @param {{ kind?: string[], n?: number, log?: boolean, body?: boolean, scope?: string | symbol }} [opts]
   * @returns {Promise<Record<string, import("./store.js").Hit[]>>}
   */
  /**
   * @param {string} query
   * @param {{ kind?: string | string[], n?: number, log?: boolean, body?: boolean, scope?: string | symbol }} [opts]
   * @returns {Promise<import("./store.js").Hit[] | Record<string, import("./store.js").Hit[]>>}
   */
  async recall(query, opts = {}) {
    const match = ftsMatch(query);
    // embed the query ONCE up front (cached) when the tier is on; per-kind ranking is then sync.
    const qvec = this.embeddings && match ? await this._embedQuery(query) : null;
    const terms = keywords(query); // for chunk localization — same split the FTS body uses
    // R2 scope + R5 expiry narrowing for direct doc/blob rows (no-op for code/file rows + fact/episode).
    // strictScope is enforced only when the query TOUCHES the doc axis ('doc' = the per-upload-scoped
    // kind); 'code' is repo-global and 'fact'/'episode' scope via owner/session, so a missing scope on
    // those never throws (the memory axis is explicitly untouched — see the ask's non-goals).
    const touchesDoc = typeof opts.kind === "string" ? opts.kind === "doc" : (Array.isArray(opts.kind) ? opts.kind : KINDS).includes("doc");
    const rs = this._resolveReadScope(opts.scope, this.strictScope && touchesDoc, "recall({ kind: 'doc' })");
    // `now` is stamped once so a recall is internally consistent; expired rows are excluded live here.
    const filter = { scope: rs.scope, seeAll: rs.seeAll, now: Date.now() };
    // memory axis (multis M4): when the query touches fact/episode, resolve the per-call owner fence and
    // ride it on the same `filter`. Computed ONLY when a mem kind is in play — a code/doc-only query
    // never pays it (and never throws under strict on the mem axis). The fence falls back to the instance
    // owner when no scope is passed, so an instance-owned recall is byte-identical.
    const touchesMem = typeof opts.kind === "string" ? MEM_KINDS.has(opts.kind) : (Array.isArray(opts.kind) ? opts.kind : KINDS).some((k) => MEM_KINDS.has(k));
    if (touchesMem) {
      const ms = this._resolveMemReadScope(opts.scope, "recall({ kind: 'fact' | 'episode' })");
      filter.memOwner = ms.memOwner;
      filter.memSeeAll = ms.memSeeAll;
    }
    if (typeof opts.kind === "string") {
      // single kind → one flat ranked list
      const hits = this.store.attachChunks(this._rankKind(match, opts.kind, opts.n ?? 10, qvec, filter), terms);
      if (MEM_KINDS.has(opts.kind)) this.store.attachMemMeta(hits); // slice 5c: surface provenance/use/occurredAt — read, never scored
      this._attachMeta(hits); // RT-3 #3: opaque caller metadata, verbatim (no-op for code/no-meta)
      if (opts.body) this._attachBodies(hits); // RT-3 inline-body — content, not a pointer
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
      grouped[k] = this.store.attachChunks(this._rankKind(match, k, n, qvec, filter), terms);
      if (MEM_KINDS.has(k)) this.store.attachMemMeta(grouped[k]); // slice 5c: written-memory columns (read, never scored)
      this._attachMeta(grouped[k]); // RT-3 #3: opaque caller metadata, verbatim (no-op for code/no-meta)
      if (opts.body) this._attachBodies(grouped[k]); // RT-3 inline-body — content, not a pointer
    }
    if (opts.log !== false) this.store.logRecall(Object.values(grouped).flat(), Date.now());
    return grouped;
  }

  /**
   * Fill each hit's `body` with its content (RT-3 inline-body, the opt-in for `recall({ body: true })`).
   * Kind-routed — the reason this is litectx's job, not an adapter's: written memory (`source:'direct'`)
   * returns its VERBATIM stored text (the FTS body is a processed search surface, never the deliverable);
   * an indexed file hit returns its localized chunk's indexed body (drift-free, exactly what ranked) via
   * {@link Store#chunkBodyAt}; when nothing localized, the whole file is read fresh from disk (matching
   * {@link get}'s freshness). `null` when the file is gone or the id is unknown. Mutates in place; bounded
   * disk reads (≤ hits, file-kind only). Note: does NOT log a fetch — body-fill is part of recall, not a
   * `get`, so it never pollutes the demand signal.
   * @param {Omit<import("./store.js").Hit, "score">[]} hits  any hit-like row (recall's `Hit`, or
   *   `recentMemory`'s unranked scoreless row) — reads `path`/`chunk`, writes `body`; `score` unused
   * @returns {Omit<import("./store.js").Hit, "score">[]}
   */
  _attachBodies(hits) {
    for (const h of hits) {
      if (h.chunk) {
        h.body = this.store.chunkBodyAt(h.path, h.chunk.startLine, h.chunk.endLine);
        continue;
      }
      const item = this.store.getItem(h.path);
      if (!item) {
        h.body = null;
        continue;
      }
      if (item.source === "direct") {
        h.body = item.text; // verbatim written memory
      } else {
        try {
          h.body = readFileSync(join(this.root, h.path), "utf8"); // whole-file fallback, fresh from disk
        } catch {
          h.body = null; // indexed but gone from disk
        }
      }
    }
    return hits;
  }

  /**
   * Attach parsed opaque `meta` (RT-3 #3) to written-memory hits, in place — the read half of the
   * sealed passthrough. One batched lookup; a hit whose path carries no metadata (every file, and
   * memory written without meta) is left untouched, so this is a no-op on pure-code recall. Parsed
   * here because the facade owns the JSON boundary; the store only ever holds/returns the raw string.
   * @param {Omit<import("./store.js").Hit, "score">[]} hits  any hit-like row (recall's `Hit`, or
   *   `recentMemory`'s unranked scoreless row) — reads `path`, writes `meta`; `score` unused
   * @returns {Omit<import("./store.js").Hit, "score">[]}
   */
  _attachMeta(hits) {
    if (!hits.length) return hits;
    const map = this.store.metaFor(hits.map((h) => h.path));
    for (const h of hits) {
      const raw = map.get(h.path);
      if (raw != null) h.meta = JSON.parse(raw);
    }
    return hits;
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
   * @param {{ scope?: string|null, seeAll?: boolean, now?: number|null, memOwner?: string|null, memSeeAll?: boolean }} [filter]  R2 scope + R5 expiry (docs/blobs) + per-call owner fence (fact/episode, multis M4)
   * @returns {import("./store.js").Hit[]}
   */
  _rankKind(match, kind, n, qvec, filter = {}) {
    if (!qvec) return match ? this.store.search(match, kind, n, SPREAD_WEIGHT, filter) : []; // dual path (unchanged contract)
    const pool = match ? this.store.search(match, kind, Math.max(n, SEMANTIC_POOL), SPREAD_WEIGHT, filter) : [];
    const knn = this.store.knnCandidates(kind, qvec, KNN_K, new Set(pool.map((h) => h.path)), filter);
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
   * Describe one graph node — the substrate accessor (`getNode` returns STRUCTURE; `get` returns the
   * body). The graph is first-class public API: recall and impact are *views* over it, and so are the
   * future codegraph/contextgraph. Kind-agnostic — an indexed file's repo-relative path returns a
   * file node (its symbols as `chunks` + exact import-edge counts), a written-memory id returns a
   * zero-chunk, zero-edge node. Edge counts are the persisted `import` graph (exact); call
   * relationships are `impact()`'s on-demand job, never drawn as graph edges. Sync; `null` if unknown.
   * @param {string} id  an indexed file's repo-relative path, or a written-memory id
   * @returns {import("./store.js").GraphNode | null}
   */
  getNode(id) {
    return this.store.getNode(id);
  }

  /**
   * Walk the edge graph from `id` — the substrate navigator. BFS over persisted `import` edges (the
   * only persisted type; `call`/blast is `impact()`). `dir`: "out" = what `id` imports, "in" = what
   * imports it, "both" = the neighbourhood (default). `hops` is the depth (default 1, hard-capped at
   * 3 — navigation, not ranking; `truncated` flags the cap). Deduped, nearest-hop-wins, excludes the
   * seed. `edge` is generic so future non-code edges slot in unchanged. Sync.
   * @param {string} id
   * @param {{ edge?: string, dir?: "out"|"in"|"both", hops?: number }} [opts]
   * @returns {{ items: import("./store.js").RelatedNode[], truncated: boolean }}
   */
  related(id, opts = {}) {
    return this.store.related(id, opts);
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
   * A **blob** (a byte-exact upload, R3) returns its original bytes in `bytes` with `text: null` — the
   * round-trip is byte-identical. An **expired** row (R5) returns `null`, exactly like recall hides it.
   *
   * `scope` (multis M3 R2) **fences the direct handle** like `recall({scope})` fences discovery: a `get`
   * for a doc/blob tagged with a *different* scope returns `null` (a global/null-scope row stays visible
   * to every scope; fact/episode/file rows are unaffected). This is the load-bearing half of "one customer
   * never sees another's" — recall alone fences search, but ids can be guessed, so a customer-reachable
   * fetch must pass the requesting scope. Pass {@link GLOBAL} to fetch only shared-tier rows.
   *
   * Under `strictScope` (multis M3 fail-closed ask), a **bare `get(id)` THROWS** — because `get` can't
   * know a guessable id's scope without fetching it, so a missing scope on a strict store is a leak, not
   * a convenience. Pass a tenant `scope` or `GLOBAL` to fetch. With strictScope off, `get(id)` is unfenced
   * by id (the legacy behaviour), exactly as before.
   *
   * Sync (no embedder involved). Returns `null` for an unknown id.
   *
   * @param {string} id  a written-memory id, a stashed payload's id, or an indexed file's repo-relative path
   * @param {{ log?: boolean, scope?: string | symbol }} [opts]
   * @returns {Item | null}
   */
  get(id, opts = {}) {
    // strictScope: a bare get(id) throws (can't fence a guessable id without a scope). GLOBAL → shared
    // tier only; a tenant scope → R2 handle fence; omitted (non-strict) → unfenced (owner-model intact).
    const rs = this._resolveReadScope(opts.scope, this.strictScope, "get(id)");
    // pass now → an expired direct doc/blob (R5) reads as gone; pass scope/global → another scope's row
    // reads as absent (R2 — fences the by-id handle, not only recall).
    const r = this.store.getItem(id, Date.now(), rs.scope, rs.globalOnly);
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
    return { id: r.path, kind: r.kind, format: r.format, source: r.source, provenance: r.provenance, occurredAt: r.occurred_at, text, bytes: r.bytes ?? null, meta: r.meta != null ? JSON.parse(r.meta) : null };
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
   * @param {{ kind?: string, format?: string, by?: string, occurredAt?: number, meta?: Record<string, unknown>, injectionRisk?: "low"|"medium"|"high", scope?: string|symbol|null, expiresAt?: number|null }} [opts]
   *   `kind` ∈ {fact, episode, doc} (default `fact`); `by` = provenance `"human"|"agent"` (default
   *   `"agent"`); `injectionRisk` = OPTIONAL guardrails shape flag forwarded to a wired `writeGate`
   *   (litectx core never computes it — a guardrails tier sets it; ignored when no `writeGate`);
   *   `occurredAt` = episode timestamp (epoch ms, default now; ignored for non-episodes);
   *   `format` defaults to `md` for docs, `text` otherwise. `meta` = an opaque caller dict (RT-3 #3)
   *   stored verbatim and returned untouched by `get`/`recall` — small structured tags ({sessionId,
   *   tag, …}), NEVER searched or ranked; park large payloads in `stash`, not here. Re-`remember`ing
   *   without `meta` clears any prior meta. `scope` routes by kind: on a `doc` it tags the row's recall
   *   scope (multis M3 R2; with `expiresAt`/R5 retention, both default null = global/forever); on a
   *   `fact`/`episode` it sets the per-call `mem_scope.owner` (multis M4 — a tenant string fences that
   *   memory to one tenant on a shared instance, {@link GLOBAL} writes the shared tier, omitted uses the
   *   instance `owner`; under `strictScope`, omitted THROWS). Prefer a bound {@link scoped} view so the
   *   scope can't be forgotten. Doc `scope` usually set via {@link ingest}, not here directly.
   * @returns {Promise<void>}
   */
  async remember(id, text, opts = {}) {
    const kind = opts.kind ?? "fact";
    if (kind !== "fact" && kind !== "episode" && kind !== "doc") {
      throw new Error(`remember: kind must be fact | episode | doc (got "${kind}"); code/doc-from-file enter via index()`);
    }
    const by = opts.by ?? "agent";
    if (by !== "human" && by !== "agent") throw new Error(`remember: by must be "human" | "agent" (got "${by}")`);
    // scope routes by axis. DOC: `scope` → `doc_scope` (explicit or GLOBAL, else throw under strict).
    // MEMORY (multis M4): fact/episode `scope` → the per-call `mem_scope.owner` — a tenant string, GLOBAL
    // (→ null shared tier), or omitted (→ instance owner; under strict, THROW). So one shared instance
    // fences memory per tenant, and the two axes never cross (a doc scope never reaches mem_scope and
    // vice-versa). `owner === undefined` tells writeMemory "use the instance owner" (legacy single-tenant).
    const writeScope = kind === "doc" ? this._resolveWriteScope(opts.scope, this.strictScope, "remember({ kind: 'doc' })") : null;
    const writeOwner = kind === "doc" ? undefined : this._resolveMemWriteOwner(opts.scope, `remember({ kind: '${kind}' })`);
    // write-gate + audit (§10.1) — runs when EITHER a gate or an audit sink is wired. The gate (when
    // present) checks BEFORE any side effect (no embedding spent, no episode prune, no write), so a denied
    // write is a true no-op. litectx states the SOURCE (`provenance:by`) + passes through an optional
    // guardrails `injectionRisk` shape flag; the gate renders deny/ask, a deny throws and nothing persists
    // (the §6 line: litectx never makes the content judgment). The audit is the standalone paper-trail
    // (`WriteAudit`) — it fires whenever a sink is set, gate or not; an un-gated write records a synthetic
    // `allow` (reason "no-gate") so the trail is complete without forcing a gate to exist.
    if (this.writeGate || this.writeAudit) {
      const action = toWriteAction(id, text, { kind, provenance: by, meta: opts.meta, injectionRisk: opts.injectionRisk });
      const decision = this.writeGate ? await this.writeGate.check(action) : { outcome: "allow", reason: "no-gate" };
      if (this.writeAudit) this.writeAudit.emit(action, decision, Date.now());
      if (decision.outcome === "deny") throw new WriteDeniedError(id, decision);
    }
    const format = opts.format ?? (kind === "doc" ? "md" : "text");
    const occurredAt = kind === "episode" ? opts.occurredAt ?? Date.now() : null;
    // RT-3 #3: serialize the opaque caller dict to JSON once, here — the store holds bytes, the facade
    // owns the (de)serialization boundary. null when none → writeMemory clears any prior meta.
    const meta = opts.meta != null ? JSON.stringify(opts.meta) : null;
    const embedding = this.embeddings ? ((await this._embedSafe(text)) ?? undefined) : undefined;
    // slice 5b ephemerality: an episode write trims the scratchpad of PREVIOUSLY-accumulated episodes
    // past the rolling active window (anything that mattered was distilled into a durable fact, which
    // never prunes). Bounds the store with no cron; only episode writes grow the set, so that is where
    // it's trimmed. Pruned BEFORE the write so the episode the caller just authored — even one with an
    // explicit backdated occurredAt — is always honored, never deleted by its own write.
    if (kind === "episode") this.store.pruneStaleEpisodes(Date.now() - ACTIVE_EPISODE_DAYS * DAY_MS);
    this.store.writeMemory({ id, text, kind, format, provenance: by, occurredAt, meta, embedding, scope: writeScope, owner: writeOwner, expiresAt: opts.expiresAt, createdAt: Date.now() });
  }

  /**
   * Forget directly-written memory (§3.2). Pass an `id` to drop one item, or a query
   * (`{ kind?, by? }`) for bulk human invalidation (e.g. drop every agent-asserted fact). **Only ever
   * removes `source='direct'` rows** — an indexed file is never touched. **Memory-only:** a stash is not
   * memory — clean parked payloads with {@link evict} (a `forget`-by-id no longer reaches the stash table).
   * Returns the count removed.
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
   * Ingest an uploaded file (bytes + filename) — the third ingest path, distinct from {@link index}
   * (sweeps a disk root) and {@link remember} (stores text whole, unchunked). Built for transient chat
   * uploads (a buffer, not a repo file). Routed by extension (multis M3):
   *
   * - **md / pdf / docx** → converted to markdown, split into segments, each written as its own
   *   `source='direct'` `doc` row — so it ranks alongside `md` docs in `recall(q,{kind:'doc'})`,
   *   survives every `index()` pass, and carries its `format` ("md"|"pdf"|"docx") under `kind='doc'`.
   * - **txt / text / log / csv** → already plaintext (no parser, no peer dep): packed into
   *   passage-sized segments (blank-line paragraphs, else lines), stored exactly like the above with
   *   `format` ("txt"|"log"|"csv"; "text"→"txt"). CSV is chunked as raw text (no columnar parse).
   * - **everything else** (xlsx / xml / code / binary) → stored BYTE-EXACT as a blob; its
   *   **filename** is indexed for recall but the body is never parsed/chunked, and {@link get} returns
   *   the original bytes. Getting body-search for those types is the consumer's opt-in (send a chunkable type).
   *
   * Untrusted input is BOUNDED: oversized / over-page / slow / corrupt / encrypted / no-text inputs
   * throw a clear, specific error and write NOTHING (the index is left intact). The two parsers
   * (`pdfjs-dist`, `mammoth`) are optional peer deps, lazy-loaded on first chunkable ingest (a blob
   * needs neither). Every row may carry a `scope` (R2 — recall fences `scope ∪ null-global`) and an
   * `expiresAt` (R5 — excluded from recall/get once past, reclaimed by {@link purge}).
   *
   * **A wired `writeGate` screens the CHUNKABLE path only (per segment, via {@link remember}); a BLOB
   * write is NOT gated.** This is deliberate: the gate judges searchable *text* for injection-risk, and a
   * blob has none — its bytes are opaque and never reach an LLM (the only path that turns blob content
   * into context is converting + sending as md/pdf/docx, which IS the gated chunked route). Screen
   * uploads at the call site (size/type/AV) and treat retrieved bytes as untrusted on egress; don't rely
   * on `writeGate` for blobs.
   *
   * Re-ingesting the same `id` is an upsert: prior segments/blob of that document are dropped first, so
   * a shorter (or format-changed) re-ingest never leaves orphans.
   *
   * @param {Uint8Array} buffer  the file bytes (e.g. a chat upload)
   * @param {{ filename?: string, format?: string, id?: string, scope?: string|symbol|null, expiresAt?: number|null, meta?: Record<string, unknown>, maxSize?: number, maxPages?: number, parseTimeoutMs?: number }} [opts]
   *   `filename` drives extension routing; `format` overrides it; `id` = stable base id (else derived
   *   from the filename); `scope`/`expiresAt` = per-upload recall scope + retention (default null =
   *   global/forever); `meta` = opaque passthrough; `maxSize`/`maxPages`/`parseTimeoutMs` = the
   *   untrusted-input bounds (defaults 10 MB / 2000 / 30 s; `maxSize` also caps a blob).
   * @returns {Promise<{ id: string, kind: "doc", format: string, mode: "chunked" | "blob", chunks: number }>}
   */
  async ingest(buffer, opts = {}) {
    if (!(buffer instanceof Uint8Array)) throw new Error("ingest: expected a Buffer/Uint8Array of file bytes");
    const cls = classifyDocument(opts.filename, opts.format);
    const id = opts.id ?? deriveDocId(opts.filename);
    // strictScope: ingest is ALWAYS the doc axis, so an explicit scope (or GLOBAL) is required. Resolve
    // once up front so a missing scope fails fast — BEFORE any (expensive, untrusted) parse work — and so
    // the blob branch has its stored scope value. The chunked branch passes the raw scope to remember,
    // which re-resolves identically (passing the resolved null would wrongly re-trip the strict throw).
    const writeScope = this._resolveWriteScope(opts.scope, this.strictScope, "ingest");
    if (cls.mode === "blob") {
      // byte-exact store (R3): no parser, body never chunked — the filename is the searchable surface.
      const maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE;
      if (buffer.length > maxSize) throw new Error(`ingest: file exceeds maxSize (${buffer.length} > ${maxSize} bytes)`);
      const filename = opts.filename ?? `${id}.${cls.format}`;
      const meta = opts.meta != null ? JSON.stringify(opts.meta) : null;
      this.store.forgetMemory({ idPrefix: id }); // upsert: drop any prior row/segments + bytes for this id
      this.store.writeBlob({ id, bytes: buffer, filename, format: cls.format, meta, scope: writeScope, expiresAt: opts.expiresAt, createdAt: Date.now() });
      return { id, kind: "doc", format: cls.format, mode: "blob", chunks: 0 };
    }
    const { format, segments } = await documentToSegments(buffer, {
      mode: cls.mode,
      format: cls.format,
      maxSize: opts.maxSize,
      maxPages: opts.maxPages,
      parseTimeoutMs: opts.parseTimeoutMs,
    });
    // re-ingest = upsert: drop any prior segments/blob of THIS document first (direct rows only).
    this.store.forgetMemory({ idPrefix: id });
    // one direct doc row per segment, ids `<base>#<n>` — each independently ranked + recallable.
    for (let i = 0; i < segments.length; i++) {
      await this.remember(`${id}#${i}`, segments[i], { kind: "doc", format, meta: opts.meta, scope: opts.scope, expiresAt: opts.expiresAt });
    }
    return { id, kind: "doc", format, mode: "chunked", chunks: segments.length };
  }

  /**
   * Reclaim expired uploads (multis M3 R5) — the retention sweep's mechanism. Every direct doc/blob row
   * whose `expiresAt` has passed `now` (default `Date.now()`) is deleted and its storage (including the
   * byte-exact blob) reclaimed, leaving no orphans. The CONSUMER owns the schedule (when/how often);
   * litectx owns the delete. Note recall/get already EXCLUDE expired rows the instant they expire — so
   * this is a storage-reclamation pass, not a correctness gate. Returns the number of rows reclaimed.
   * @param {{ now?: number }} [opts]  `now` = the cutoff (epoch ms); rows with `expiresAt <= now` go
   * @returns {number}
   */
  purge(opts = {}) {
    return this.store.purge(opts.now ?? Date.now());
  }

  /**
   * Park a payload in the keyed agent-context store and return its handle — the durable half of
   * **restorable compression** (R-C4). The caller drops a large payload (a tool result, a fetched
   * page, a file dump) from its context window, keeping only the cheap handle (`id`); {@link get}
   * rehydrates the full text on demand and {@link evict} drops it when truly done. A stash is **not
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
   * Evict parked stashes (R-C4 housekeeping) — the runtime's stash deleter, the cleanup half of
   * {@link stash}. **API-only** (§10.5: a stash is orchestration plumbing, never a model verb) and
   * **stash-only**: unlike {@link forget} (which invalidates durable memory), `evict` can never reach a
   * fact/episode — a bulk age/size sweep is safe by construction (only the `stash` table is touched).
   * Pass an `id` to drop one parked payload, or a policy: `{ olderThan }` (epoch-ms floor — evict anything
   * parked before it) and/or `{ maxCount }` (keep only the newest N, evict the rest). When both are given
   * they apply in turn (age first, then count). The runtime owns the *policy* (which/when); litectx owns
   * the *delete*. Returns the count removed.
   *
   * @param {string | { olderThan?: number, maxCount?: number }} sel
   * @returns {number}
   */
  evict(sel) {
    if (typeof sel === "string") return this.store.evictStash({ id: sel });
    let removed = 0;
    let applied = false;
    if (sel.olderThan != null) (removed += this.store.evictStash({ olderThan: sel.olderThan })), (applied = true);
    if (sel.maxCount != null) (removed += this.store.evictStash({ maxCount: sel.maxCount })), (applied = true);
    if (!applied) throw new Error("evict(policy) needs an id string, { olderThan }, and/or { maxCount }");
    return removed;
  }

  /**
   * Human-in-the-loop review candidates (§3.2): agent-asserted facts whose recall count has crossed
   * `threshold`. The intended loop is the **consumer's** — it shows each candidate to a human who
   * either validates it (re-`remember(id, text, { by: "human" })`, promoting it to durable/high-trust)
   * or invalidates it (`forget(id)`). litectx supplies only the candidate set + those two actions;
   * the threshold and the review flow are the consumer's. Review is earned by use, so a human never
   * sees every agent fact — only the ones that proved useful.
   *
   * `scope` (multis M4) fences the candidate set to one tenant on a shared instance, exactly like
   * `recall({ kind: 'fact', scope })`: a tenant string → that owner's facts only; {@link GLOBAL} → the
   * shared tier only; omitted → the instance owner (under `strictScope`, omitted THROWS — fail-closed).
   * Prefer the bound {@link ScopedView#reviewCandidates} so the scope can't be forgotten.
   * @param {number} [threshold=5]
   * @param {{ scope?: string | symbol }} [opts]
   * @returns {{ path: string, hits: number }[]}
   */
  reviewCandidates(threshold = 5, opts = {}) {
    const ms = this._resolveMemReadScope(opts.scope, "reviewCandidates");
    return this.store.reviewCandidates(threshold, { memOwner: ms.memOwner, memSeeAll: ms.memSeeAll });
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
   *
   * `scope` (multis M4) fences the candidate set to one tenant on a shared instance, exactly like
   * {@link reviewCandidates} (tenant string → that owner; {@link GLOBAL} → shared tier; omitted → the
   * instance owner, or THROW under `strictScope`). Prefer the bound {@link ScopedView#promotionCandidates}.
   * @param {number} [threshold=10]
   * @param {{ scope?: string | symbol }} [opts]
   * @returns {{ path: string, hits: number }[]}
   */
  promotionCandidates(threshold = EPISODE_PROMOTE_THRESHOLD, opts = {}) {
    const ms = this._resolveMemReadScope(opts.scope, "promotionCandidates");
    return this.store.promotionCandidates({ threshold, since: Date.now() - ACTIVE_EPISODE_DAYS * DAY_MS, memOwner: ms.memOwner, memSeeAll: ms.memSeeAll });
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

  /**
   * Recent written-`doc` memory, newest first (multis M3) — the recency sibling of `recall({kind:'doc'})`
   * for the empty-FTS-match fallback. When a query carries no usable term (an all-stopword "what did I
   * say"), `recall` returns `[]` (no relevance to rank on); call `recentMemory` to ground the agent on the
   * latest uploads for its scope instead. **The consumer owns the policy** (when to fall back); litectx
   * owns the mechanism — so it is a separate verb, not a `recall` flag (which would mix recency into a
   * relevance ranking and let it pollute the demand signal).
   *
   * Returns direct `doc` rows (those written via {@link ingest}/{@link remember}; blobs included by
   * filename) ordered by write time, capped at `n` (default 10). **Scope-fenced + expiry-aware exactly
   * like `recall`:** `scope` narrows to `scope ∪ null-global` and expired rows (R5) are always excluded —
   * the fallback can never leak another tenant's memory or surface a dead row. Under `strictScope`, a
   * missing `scope` THROWS (the doc axis, same as `recall({kind:'doc'})`/`get`/`ingest`); pass {@link
   * GLOBAL} for the shared tier. `fact`/`episode` (the owner/session axis) and `code`/files are not
   * included — this is the doc axis only.
   *
   * Each row is a `recall`-shaped hit (`{ path, kind, format }`) plus `createdAt` (epoch ms; `null` for a
   * doc written before this column shipped — sorted last), the opaque `meta` when present, and `body` when
   * `body:true` (VERBATIM stored text; `null` for a blob — fetch its bytes with {@link get}). It does NOT
   * log a recall: recency is not query-demand, so counting it would inflate `use` for whatever is newest.
   *
   * @param {{ scope?: string | symbol, n?: number, body?: boolean }} [opts]
   * @returns {(Omit<import("./store.js").Hit, "score"> & { createdAt: number|null })[]}
   */
  recentMemory(opts = {}) {
    const rs = this._resolveReadScope(opts.scope, this.strictScope, "recentMemory");
    const hits = this.store.recentMemory({ scope: rs.scope, seeAll: rs.seeAll, now: Date.now(), limit: opts.n ?? 10 });
    // _attachMeta/_attachBodies mutate in place reading only path/chunk/meta/body — never `score`, which
    // these unranked recency rows don't carry (their param is `Omit<Hit,"score">[]`, so no score lie).
    this._attachMeta(hits); // RT-3 #3: opaque caller metadata, verbatim (no-op when none)
    if (opts.body) this._attachBodies(hits); // verbatim stored text (null for a blob)
    return hits;
  }

  /** @returns {number} total stored items — indexed documents + written memory */
  size() {
    return this.store.count();
  }

  close() {
    this.store.close();
  }
}

/**
 * A scope-bound facade over a {@link LiteCtx} (multis M3 fail-closed ask). Created by {@link LiteCtx#scoped},
 * never directly. Every doc-axis verb carries the view's bound scope automatically; there is no per-call
 * `scope` to pass, so it cannot be forgotten — the structural fix that mirrors how the memory axis binds
 * `owner`/`session` once on the instance. The bound scope is final: any `scope` in a call's opts is ignored.
 */
export class ScopedView {
  /** @param {LiteCtx} ctx  the underlying instance @param {string | symbol} scope  the bound scope (string | GLOBAL) */
  constructor(ctx, scope) {
    /** @type {LiteCtx} */
    this._ctx = ctx;
    /** @type {string | symbol} */
    this._scope = scope;
  }

  /** Scope-bound {@link LiteCtx#recall}. @param {string} query @param {{ kind?: string | string[], n?: number, log?: boolean, body?: boolean }} [opts] */
  recall(query, opts = {}) {
    // narrow `kind` so the call lands on a single recall overload (the union satisfies neither directly);
    // `kind:` after the spread overrides `...opts`'s widened type with the narrowed one.
    return typeof opts.kind === "string"
      ? this._ctx.recall(query, { ...opts, kind: opts.kind, scope: this._scope })
      : this._ctx.recall(query, { ...opts, kind: opts.kind, scope: this._scope });
  }

  /** Scope-bound {@link LiteCtx#get}. @param {string} id @param {{ log?: boolean }} [opts] */
  get(id, opts = {}) {
    return this._ctx.get(id, { ...opts, scope: this._scope });
  }

  /** Scope-bound {@link LiteCtx#recentMemory}. @param {{ n?: number, body?: boolean }} [opts] */
  recentMemory(opts = {}) {
    return this._ctx.recentMemory({ ...opts, scope: this._scope });
  }

  /** Scope-bound {@link LiteCtx#reviewCandidates} (multis M4). @param {number} [threshold=5] */
  reviewCandidates(threshold) {
    return this._ctx.reviewCandidates(threshold, { scope: this._scope });
  }

  /** Scope-bound {@link LiteCtx#promotionCandidates} (multis M4). @param {number} [threshold=10] */
  promotionCandidates(threshold) {
    return this._ctx.promotionCandidates(threshold, { scope: this._scope });
  }

  /** Scope-bound {@link LiteCtx#ingest}. @param {Uint8Array} buffer @param {{ filename?: string, format?: string, id?: string, expiresAt?: number|null, meta?: Record<string, unknown>, maxSize?: number, maxPages?: number, parseTimeoutMs?: number }} [opts] */
  ingest(buffer, opts = {}) {
    return this._ctx.ingest(buffer, { ...opts, scope: this._scope });
  }

  /** Scope-bound {@link LiteCtx#remember}. @param {string} id @param {string} text @param {{ kind?: string, format?: string, by?: string, occurredAt?: number, meta?: Record<string, unknown>, injectionRisk?: "low"|"medium"|"high", expiresAt?: number|null }} [opts] */
  remember(id, text, opts = {}) {
    return this._ctx.remember(id, text, { ...opts, scope: this._scope });
  }
}

export { Store } from "./store.js";
export { splitIdent, keywords, ftsMatch } from "./tokenize.js";
export { Embedder, cosine } from "./embedder.js";
export { compress, COMPRESS_LEVELS } from "./compress.js";
export { assemble, summaryWindow, trim } from "./assemble.js";
export { liteCtxAsStore } from "./memory-store.js";
export { toWriteAction, WriteAudit, WriteDeniedError } from "./writegate.js";
export { observe, ContextGraph, PRIMITIVES, VERBS_BY_PRIMITIVE, PRIMITIVE } from "./contextgraph.js";
