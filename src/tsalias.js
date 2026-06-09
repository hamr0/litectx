// tsconfig path-alias resolution (impact slice 5b only). A barrel re-exports a symbol under a
// new name; a consumer then imports that name through a path alias (`import { Panel } from "@ui"`).
// To attribute the consumer's call back to the original symbol WITHOUT over-counting an unrelated
// same-named symbol, the impact resolver must know which `import … from "<spec>"` actually point
// at the barrel. That means resolving both relative specifiers and tsconfig `compilerOptions.paths`
// aliases. Pure JSON + path arithmetic — no tree-sitter, no rg, and deliberately separate from
// edges.js so RECALL's import resolution (and its frozen benchmark) is never touched (§7.2 scope).

import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

// Extension + index resolutions tried when matching a specifier to a known file, TS-first.
const JS_EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];
const JS_INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.mjs", "/index.cjs"];

/**
 * @typedef {Object} TsPaths
 * @property {string} baseDir  baseUrl made repo-relative ("" for the root)
 * @property {{ prefix: string, suffix: string, wildcard: boolean, targets: string[] }[]} entries
 */

/**
 * Best-effort load of `<root>/tsconfig.json`'s `baseUrl` + `paths`. Returns null when there is no
 * tsconfig or it can't be read/parsed — callers then resolve relative specifiers only (which is
 * correct: a repo without path aliases has none to resolve).
 * @param {string} root  absolute repo root
 * @returns {TsPaths | null}
 */
export function loadTsPaths(root) {
  let raw;
  try {
    raw = readFileSync(join(root, "tsconfig.json"), "utf8");
  } catch {
    return null;
  }
  let cfg = parseJsonLoose(raw);
  if (!cfg || typeof cfg !== "object") return null;
  const co = cfg.compilerOptions || {};
  const baseUrl = typeof co.baseUrl === "string" ? co.baseUrl : ".";
  const baseDir = posix.normalize(baseUrl === "." ? "" : baseUrl.replace(/^\.\//, ""));
  /** @type {TsPaths["entries"]} */
  const entries = [];
  const paths = co.paths && typeof co.paths === "object" ? co.paths : {};
  for (const key of Object.keys(paths)) {
    const targets = Array.isArray(paths[key]) ? paths[key].filter((t) => typeof t === "string") : [];
    if (!targets.length) continue;
    const star = key.indexOf("*");
    if (star >= 0) entries.push({ prefix: key.slice(0, star), suffix: key.slice(star + 1), wildcard: true, targets });
    else entries.push({ prefix: key, suffix: "", wildcard: false, targets });
  }
  return { baseDir: baseDir === "." ? "" : baseDir, entries };
}

/**
 * Does `import/export … from "<spec>"` written in `fromPath` resolve to the repo-relative file
 * `target`? Handles relative specifiers and (when `tsPaths` is given) tsconfig path aliases, trying
 * the usual extension + `/index.*` resolutions. Over-matching is acceptable (§7.2 over-count safe);
 * the point is never to MISS a real link to `target`.
 * @param {string} fromPath  repo-relative file containing the specifier
 * @param {string} spec      the raw module specifier
 * @param {string} target    repo-relative file we're testing the specifier against
 * @param {TsPaths | null} tsPaths
 * @returns {boolean}
 */
export function specResolvesTo(fromPath, spec, target, tsPaths) {
  /** @type {string[]} */
  const bases = [];
  if (spec.startsWith(".")) {
    bases.push(posix.normalize(posix.join(posix.dirname(fromPath), spec)));
  } else if (tsPaths) {
    for (const e of tsPaths.entries) {
      if (e.wildcard) {
        if (spec.length < e.prefix.length + e.suffix.length) continue;
        if (!spec.startsWith(e.prefix) || !spec.endsWith(e.suffix)) continue;
        const star = spec.slice(e.prefix.length, spec.length - e.suffix.length);
        for (const t of e.targets) bases.push(aliasBase(tsPaths.baseDir, t.replace("*", star)));
      } else if (spec === e.prefix) {
        for (const t of e.targets) bases.push(aliasBase(tsPaths.baseDir, t));
      }
    }
  }
  for (const base of bases) {
    for (const ext of JS_EXTS) if (base + ext === target) return true;
    for (const idx of JS_INDEX) if (base + idx === target) return true;
  }
  return false;
}

// a tsconfig target ("./src/index.ts") under baseDir → a normalized repo-relative base.
function aliasBase(baseDir, target) {
  return posix.normalize(posix.join(baseDir, target.replace(/^\.\//, "")));
}

// JSON.parse, retried after stripping // and /* */ comments + trailing commas (tsconfig is JSONC).
// Best-effort: returns null if it still won't parse.
function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to a lenient pass */
  }
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}
