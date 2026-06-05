// Code-aware tokenization. Splits identifiers the way developers read them
// (getUserData -> get user data, base_level -> base level) so a natural-language
// query matches identifier-heavy code. Slice 0: used for both indexing and queries.

const STOP = new Set(
  ("the a an is are be how where what when which does do i of to into for from on in it its and " +
    "or s as we use used using module responsible there here that this with by at").split(" ")
);

/**
 * Split a string into lowercased word tokens, breaking camelCase, snake_case,
 * dots, slashes, and other separators.
 * @param {string} s
 * @returns {string[]}
 */
export function splitIdent(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Camel-split supplement for an FTS body. Queries are identifier-split (`keywords` runs
 * `splitIdent`), so the body must expose the same parts or a `get user data` query can't match a
 * source containing only `getUserData`. FTS5's unicode61 tokenizer already splits on `_` and
 * punctuation — so snake_case (`base_level`) is covered for free — leaving **only camelCase** as
 * the gap. We emit the broken-down parts for camelCase identifiers *once* (not a full re-split of
 * the body: that would duplicate every token and wreck BM25 length-normalization — measured to
 * regress Python, where there's no camelCase to gain). Python files yield nothing here and index
 * byte-identically to the pre-slice-3 body.
 * @param {string} body
 * @returns {string[]}
 */
function camelParts(body) {
  /** @type {string[]} */
  const parts = [];
  for (const tok of body.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    // lower-first camelCase only (`getUserData`). PascalCase (`BaseLevel`) is excluded: it's
    // class-name / filename-like signal already, and splitting it dilutes precision (measured to
    // hurt aurora's P@1 with no offsetting JS gain).
    if (/^[a-z_$]/.test(tok) && /[a-z][A-Z]/.test(tok)) parts.push(...splitIdent(tok));
  }
  return parts;
}

/**
 * Build the FTS5-indexed body for a file — the code-aware searchable surface (§5 mechanism 3).
 * Folds: (1) the file path, doubled, so filename matches count; (2) `extra` tokens (symbol names,
 * deps) the caller supplies; (3) the raw source, whose whole lowercased identifiers unicode61
 * indexes; (4) the camelCase supplement (see `camelParts`). Exact and descriptive queries both
 * land, closing the "sparse code loses to prose" gap.
 * @param {{ path: string, body: string, extra?: string[] }} doc
 * @returns {string}
 */
export function indexBody({ path, body, extra = [] }) {
  const pathTok = splitIdent(path).join(" ");
  const camel = camelParts(body).join(" ");
  const head = extra.length ? `${extra.join(" ")}\n` : "";
  return `${pathTok} ${pathTok}\n${head}${body}${camel ? `\n${camel}` : ""}`;
}

/**
 * Extract content keywords from a query: deduped, stopwords dropped, length >= 3.
 * @param {string} query
 * @returns {string[]}
 */
export function keywords(query) {
  return [...new Set(splitIdent(query).filter((w) => w.length >= 3 && !STOP.has(w)))];
}

/**
 * Build an FTS5 MATCH expression (OR of quoted keywords), or null if the query
 * has no usable terms.
 * @param {string} query
 * @returns {string | null}
 */
export function ftsMatch(query) {
  const kw = keywords(query);
  return kw.length ? kw.map((k) => `"${k}"`).join(" OR ") : null;
}
