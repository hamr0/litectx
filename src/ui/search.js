// Turn raw recall hits into the page's result rows. Pure functions + one recall call, kept apart from
// the HTTP layer so the knobs (docs/wiki/local-ui.md "Build order" 3) are plain, testable transforms.

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Knob 2 — "old/tests last": a dir segment archive|poc|test|tests|logs, or `.test.` in the file name.
const NOISY_DIRS = new Set(["archive", "poc", "test", "tests", "logs"]);

/**
 * @param {string[]} segs  the path's directory segments (repo prefix already removed)
 * @param {string} file
 * @returns {boolean}
 */
export function isNoisy(segs, file) {
  return segs.some((s) => NOISY_DIRS.has(s)) || file.includes(".test.");
}

/**
 * @typedef {Object} Row
 * @property {string} repo      first path segment in all-repos mode; the source name in one-repo mode
 * @property {string} folder    directory inside the repo ("" at the top)
 * @property {string} file
 * @property {string} path      index-relative path (the handle for /view)
 * @property {string} abs       absolute path on disk (display only; the editor is launched by the server from `path`)
 * @property {string} kind
 * @property {number} score
 * @property {boolean} keyword
 * @property {string | null} symbol
 * @property {number} start     1-based, for humans (the API's chunk lines are 0-based)
 * @property {number} end       1-based inclusive
 * @property {{ n: number, t: string }[]} preview  first 3 non-blank lines of the chunk, from disk (n = 1-based line number)
 * @property {number} more      other sections of this file that also matched
 * @property {{ symbol: string | null, start: number, end: number }[]} others  those sections
 * @property {boolean} noisy
 */

/**
 * @typedef {Object} SearchOpts
 * @property {string[]} [repos]   keep only these repos
 * @property {string[]} [kinds]   subset of doc|code (default both)
 * @property {string} [ext]       keep only files with this extension (no dot)
 * @property {string} [folder]    keep only folders starting with this (repo-relative)
 * @property {boolean} [demote]   knob 2 (default on)
 * @property {boolean} [group]    knob 1 (default on)
 * @property {number} [limit]
 */

/**
 * @param {import("../index.js").LiteCtx} ctx
 * @param {string} root         the source root (absolute)
 * @param {"repo" | "repos"} mode
 * @param {string} sourceName
 * @param {string} q            searched AS TYPED — repo names stay in the query
 * @param {SearchOpts} o
 * @returns {Promise<{ rows: Row[], facets: { exts: string[], folders: string[] } }>}
 */
export async function search(ctx, root, mode, sourceName, q, o = {}) {
  const kinds = (o.kinds?.length ? o.kinds : ["doc", "code"]).filter((k) => k === "doc" || k === "code");
  if (!q.trim() || !kinds.length) return { rows: [], facets: { exts: [], folders: [] } };
  const wanted = o.repos?.length ? new Set(o.repos) : null;
  // overfetch when filtering to repos: the wanted repo's hits may sit far below other repos' hits
  const n = wanted ? 200 : 60;
  const r = await ctx.recall(q, { kind: kinds, n });
  // filter to the wanted repos BEFORE interleaving: interleaving by global rank first lets one repo's code
  // hold early slots and its docs late ones, burying its docs behind all its code
  const repoOf = (/** @type {{ path: string }} */ h) => (mode === "repos" ? (h.path.split("/")[0] ?? "") : sourceName);
  const keep = (/** @type {{ path: string }} */ h) => !wanted || wanted.has(repoOf(h));
  const d = (r.doc ?? []).filter(keep);
  const c = (r.code ?? []).filter(keep);
  // per-kind scores are not comparable → interleave doc/code by rank
  const merged = [];
  for (let i = 0; i < d.length || i < c.length; i++) {
    if (d[i]) merged.push(d[i]);
    if (c[i]) merged.push(c[i]);
  }

  /** @type {Row[]} */
  let rows = [];
  /** @type {Map<string, Row>} */
  const byPath = new Map();
  for (const h of merged) {
    const split = h.path.split("/");
    const repo = mode === "repos" ? (split.shift() ?? "") : sourceName;
    if (wanted && !wanted.has(repo)) continue;
    const ch = h.chunk;
    const s = ch ? ch.startLine + 1 : 1;
    const e = ch ? ch.endLine + 1 : s;
    const prior = byPath.get(h.path);
    if (prior && o.group !== false) {
      prior.more++;
      prior.others.push({ symbol: ch?.symbol ?? null, start: s, end: e });
      continue;
    }
    const file = split.pop() ?? h.path;
    const row = {
      repo,
      folder: split.join("/"),
      file,
      path: h.path,
      abs: join(root, h.path),
      kind: h.kind,
      score: h.score,
      keyword: h.keyword,
      symbol: ch?.symbol ?? null,
      start: s,
      end: e,
      preview: preview(join(root, h.path), s, e),
      more: 0,
      others: [],
      noisy: isNoisy(split, file),
    };
    byPath.set(h.path, row);
    rows.push(row);
  }

  const facets = {
    exts: [...new Set(rows.map((x) => extOf(x.file)).filter(Boolean))].sort(),
    folders: [...new Set(rows.map((x) => x.folder.split("/")[0]).filter(Boolean))].slice(0, 12),
  };
  if (o.ext) rows = rows.filter((x) => extOf(x.file) === o.ext);
  const f = o.folder;
  if (f) rows = rows.filter((x) => x.folder === f || x.folder.startsWith(f + "/"));
  if (o.demote !== false) rows = [...rows.filter((x) => !x.noisy), ...rows.filter((x) => x.noisy)];
  return { rows: rows.slice(0, o.limit ?? 50), facets };
}

/** @param {string} file @returns {string} extension without the dot, "" if none */
function extOf(file) {
  const i = file.lastIndexOf(".");
  return i > 0 ? file.slice(i + 1).toLowerCase() : "";
}

/**
 * The first three non-blank lines of lines s..e (1-based) read from disk; [] if the file is gone.
 * @param {string} abs @param {number} s @param {number} e @returns {{ n: number, t: string }[]}
 */
function preview(abs, s, e) {
  try {
    return readFileSync(abs, "utf8")
      .split("\n")
      .map((t, i) => ({ n: i + 1, t }))
      .slice(s - 1, e)
      .filter((l) => l.t.trim())
      .slice(0, 3)
      .map((l) => ({ n: l.n, t: l.t.length > 200 ? l.t.slice(0, 200) + "…" : l.t }));
  } catch {
    return [];
  }
}
