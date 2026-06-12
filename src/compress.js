// R-C7 — `compress()`: the rank-tiered render primitive (CE PRD §8.1). Given a graph node (a code
// chunk) and a level, return its text at one of three fidelities: `verbatim` (the full body),
// `signature` (header + doc, body elided — saves ~95–98% bytes per the POC), or `drop` (a name-only
// marker). A caller / `assemble()` picks the level by rank: top-N verbatim, next tier signature, the
// long tail dropped. This is a pure render VIEW over the chunk text — no DB, no ranking, no weights;
// it composes with recall (which hands you the ranked nodes) but owns none of recall's logic.
//
// Why a primitive and not a column: the signature/docstring unit is DERIVED from the chunk body via
// tree-sitter, not stored — correcting the borrow-ledger's "render unit is free." See `signatureOf`.

import { signatureOf } from "./chunker.js";

/** The render fidelities, most → least detail. @type {readonly string[]} */
export const COMPRESS_LEVELS = ["verbatim", "signature", "drop"];

/**
 * @typedef {Object} CompressNode
 * @property {string} text             the symbol's source text (a chunk body)
 * @property {string} [format]         "py" | "js" | "ts" | … — needed for `signature`/`drop` extraction
 * @property {string|null} [symbol]    the chunk's symbol name, used for the `drop` marker when present
 */

/**
 * Render a node at the given fidelity. `signature` and `drop` need a parseable `format`; when a node
 * can't be parsed (markdown, a preamble chunk, a parse failure) `signature` falls back to verbatim
 * text — never throws, never returns less than the body asked for losslessly.
 * @param {CompressNode} node
 * @param {{ level?: "verbatim" | "signature" | "drop" }} [opts]
 * @returns {Promise<string>}
 */
export async function compress(node, opts = {}) {
  const level = opts.level ?? "signature";
  const text = node?.text ?? "";
  if (level === "verbatim") return text;
  if (level !== "signature" && level !== "drop") {
    throw new TypeError(`compress: unknown level "${level}" (expected ${COMPRESS_LEVELS.join(" | ")})`);
  }

  const format = node?.format;
  const sig = format ? await signatureOf(format, text) : null;

  if (level === "drop") {
    const name = node?.symbol ?? sig?.name ?? null;
    return name ? `${name} …` : "…";
  }
  // signature: header + doc, body elided. Unparseable → lossless verbatim fallback.
  return sig ? sig.signature : text;
}
