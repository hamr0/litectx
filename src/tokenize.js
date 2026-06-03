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
