// Embeddings tier (slice 6) — the semantic re-ranking signal. OFF by default; the ONLY opt-in tier
// (CLAUDE.md). A local ONNX model via transformers.js — open-source, in-process, no vendor lock-in.
// The dependency is an OPTIONAL peer dep, lazy-imported on first use, so the deterministic core never
// pays the ML import/startup cost and `npm i litectx` stays one-prod-dep (LIBRARY_CONVENTIONS §1).
//
// Granularity + representation are POC-validated (poc/RESULTS.md, embeddings round 2): file-level
// (matches recall's unit), HEAD-truncated text — a distilled symbol/signature string was a wash, so
// the simpler head wins. Vectors are L2-normalized so cosine similarity is a plain dot product.

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2"; // small (~90 MB), 384-dim; aurora's choice, POC-proven
const HEAD_CHARS = 6000; // the model caps at ~512 tokens; head-truncation here bounds the input cheaply

/**
 * Lazy wrapper over a transformers.js feature-extraction pipeline. Any object with the same
 * `async embed(text): Float32Array` shape can stand in (see {@link LiteCtx} `embedder` option) — used
 * to inject a deterministic stub in tests so the tier's wiring is covered without the real model.
 */
export class Embedder {
  /** @param {{ model?: string }} [opts] */
  constructor({ model = DEFAULT_MODEL } = {}) {
    this.model = model;
    /** @type {any} */
    this._pipe = null;
  }

  /** @returns {Promise<any>} the cached pipeline, importing the optional dep on first call */
  async _pipeline() {
    if (this._pipe) return this._pipe;
    let transformers;
    try {
      // Non-literal specifier on purpose: this is an OPTIONAL peer dep, not installed for the core.
      // A literal `import("@xenova/transformers")` would make `tsc` demand the package at typecheck
      // (and CI would have to install its heavy native deps). The variable keeps the boundary `any`
      // without `@ts-ignore`; the runtime resolves the real module all the same.
      const pkg = "@xenova/transformers";
      transformers = await import(pkg);
    } catch {
      throw new Error(
        "litectx: the embeddings tier needs the optional peer dependency '@xenova/transformers'. " +
          "Install it (`npm i @xenova/transformers`) or leave `embeddings` off (the default)."
      );
    }
    this._pipe = await transformers.pipeline("feature-extraction", this.model);
    return this._pipe;
  }

  /**
   * Embed one text into an L2-normalized vector. Head-truncates to {@link HEAD_CHARS}.
   * @param {string} text
   * @returns {Promise<Float32Array>}
   */
  async embed(text) {
    const pipe = await this._pipeline();
    const out = await pipe((text || " ").slice(0, HEAD_CHARS), { pooling: "mean", normalize: true });
    const v = Float32Array.from(/** @type {Iterable<number>} */ (out.data));
    return v;
  }
}

/**
 * Cosine similarity of two L2-normalized vectors = their dot product. Returns 0 on a length mismatch
 * or a missing vector (an un-embedded candidate contributes no semantic boost, never an error).
 * @param {Float32Array | undefined} a
 * @param {Float32Array | undefined} b
 * @returns {number}
 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
