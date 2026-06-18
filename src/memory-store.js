// RT-3 — litectx as a drop-in memory backend. Adapts a LiteCtx instance to the four-method `Store`
// shape a host (e.g. bareagent's `Memory`) mounts — `{ store, search, get, delete }` projecting to
// `[{ id, content, metadata, score }]` — so swapping a substring-scan JsonFileStore for litectx is a
// one-line change and the host code is untouched. It just gets ranked, graph-aware recall instead.
//
// NO import of the host: we COPY the shape (the Store-socket move, in reverse — the host adapted to
// litectx's Store interface for persistence; here litectx adapts to the host's Store interface for
// consumption). The five shape mismatches and how this resolves them (CE-PRD §8.2 / RT-3):
//   #1 id ownership inverts — the adapter is the Store, so IT mints the id (a namespaced uuid) and
//      calls remember(id, …); the host never supplies one.
//   #2 search must return content — uses recall({ body: true }) (the inline-body flag).
//   #3 opaque metadata round-trips — the host's arbitrary dict is split: litectx-meaningful keys
//      (`kind`, `by`) drive the write; the REST rides the sealed `meta` passthrough, returned
//      verbatim. On read, kind/by are reassembled INTO metadata so the full dict comes back.
//   #4 default kind — an un-kinded write is a durable `fact` (agent memory); metadata.kind overrides.
//   #5 comparable scores — search targets ONE kind (default fact) so scores never mix across litectx's
//      per-kind rankings; options.kind overrides.
//
// `store`/`search` are async (litectx's remember/recall are — embeddings): the host's Memory delegates
// the return value without awaiting, so a caller does `await memory.store(…)`. `get`/`delete` are sync.

import { randomUUID } from "node:crypto";

/** Keys the adapter interprets; everything else in a host metadata dict is opaque passthrough. */
const RESERVED = new Set(["kind", "by"]);

/**
 * Reassemble a host `metadata` dict from a litectx hit/item: the opaque `meta` passthrough plus the
 * reserved keys mapped back out of their typed columns (`kind`, and `by` from `provenance`). The
 * inverse of the split `store()` does on write, so the dict the host stored comes back whole.
 * @param {{ kind?: string, provenance?: string|null, meta?: Record<string, unknown>|null }} x
 * @returns {Record<string, unknown>}
 */
function reassembleMeta(x) {
  /** @type {Record<string, unknown>} */
  const md = { ...(x.meta ?? {}) };
  if (x.kind != null) md.kind = x.kind;
  if (x.provenance != null) md.by = x.provenance;
  return md;
}

/**
 * Wrap a {@link import("./index.js").LiteCtx} as a host `Store` (`{ store, search, get, delete }`).
 * @param {import("./index.js").LiteCtx} lc  an indexed LiteCtx instance (its own dbPath = isolation)
 * @param {{ kind?: string }} [opts]  default write/search kind (default `"fact"`)
 * @returns {{
 *   store(content: string, metadata?: Record<string, any>): Promise<string>,
 *   search(query: string, options?: Record<string, any>): Promise<Array<{ id: string, content: string|null, metadata: Record<string, unknown>, score: number }>>,
 *   get(id: string): { id: string, content: string|null, metadata: Record<string, unknown> } | null,
 *   delete(id: string): void,
 * }}
 */
export function liteCtxAsStore(lc, opts = {}) {
  const defaultKind = opts.kind ?? "fact";
  return {
    /** Persist content; returns the minted id (the host doesn't supply one). */
    async store(content, metadata = {}) {
      const kind = typeof metadata.kind === "string" ? metadata.kind : defaultKind;
      const by = metadata.by; // "human" | "agent" | undefined (remember defaults "agent")
      /** @type {Record<string, unknown>} */
      const passthrough = {};
      for (const k of Object.keys(metadata)) if (!RESERVED.has(k)) passthrough[k] = metadata[k];
      const id = `${kind}:${randomUUID()}`;
      await lc.remember(id, content, {
        kind,
        by,
        meta: Object.keys(passthrough).length ? passthrough : undefined,
      });
      return id;
    },

    /** Ranked search over one kind (scores stay comparable); `options.limit`/`options.kind` tune it. */
    async search(query, options = {}) {
      const kind = typeof options.kind === "string" ? options.kind : defaultKind;
      const n = typeof options.limit === "number" ? options.limit : options.n;
      const hits = await lc.recall(query, { kind, n, body: true });
      return hits.map((h) => ({
        id: h.path,
        content: h.body ?? null,
        metadata: reassembleMeta(h),
        score: h.score,
      }));
    },

    /** Fetch one record by id, or null. */
    get(id) {
      const item = lc.get(id);
      if (!item) return null;
      // This is a TEXT-content KV view (fact/episode memory). A litectx blob (a byte-exact upload, R3)
      // has `text: null` — its payload is in `item.bytes`, which this adapter deliberately does NOT
      // surface. Blobs aren't this store's model; reach `ctx.get(id).bytes` directly for upload bytes.
      return { id: item.id, content: item.text, metadata: reassembleMeta(item) };
    },

    /** Remove one record by id. */
    delete(id) {
      lc.forget(id);
    },
  };
}
