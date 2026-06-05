// Edge resolution (slice 4): raw import specifiers (from the chunker) → intra-repo destination
// files. The resolved `import` edges feed 1-hop spreading in recall — the validated v1 ranking
// signal over BM25 (POC: poc/RESULTS.md, +0.028 aurora / +0.021 gitdone).
//
// Intra-repo ONLY: a specifier that resolves to no indexed file (an external package, an
// unfound module) yields NO edge. For RECALL that is fine — spreading only ever borrows
// relevance between two files already in the candidate set, so over- and under-counting are
// both tolerable for ranking. The §7 isolation safety net (record unresolved refs, never drop
// them silently) is the IMPACT view's contract and lands with call edges in slice 5; recall
// makes no isolation claim, so it does not persist unresolved specifiers here.
//
// No tree-sitter, no ripgrep here — extraction already happened in the single parse; this is
// pure path arithmetic over the known file set. Routing is by `format` only (§6), never content.

import { posix } from "node:path";

/**
 * @typedef {Object} ResolveCtx
 * @property {(p: string) => boolean} has       membership test over all indexed paths
 * @property {Map<string, {file: string, key: string}[]>} pyByBase  python module index (basename → defs)
 */

/**
 * Build the per-pass resolution context from the full current file list (paths only — no reads).
 * The python index keys every `.py` file by its dotted-module suffix so an absolute import
 * `aurora_core.activation.base_level` can be matched against `…/aurora_core/activation/base_level.py`
 * regardless of the source-root prefix (`packages/core/src/…`).
 * @param {string[]} paths  repo-relative paths currently indexed
 * @returns {ResolveCtx}
 */
export function buildResolveCtx(paths) {
  const set = new Set(paths);
  /** @type {Map<string, {file: string, key: string}[]>} */
  const pyByBase = new Map();
  for (const p of paths) {
    if (!p.endsWith(".py")) continue;
    let key = p.slice(0, -3); // drop ".py"
    if (key.endsWith("/__init__")) key = key.slice(0, -9); // a package dir keys on the dir itself
    else if (key === "__init__") key = "";
    const slash = key.lastIndexOf("/");
    const base = slash >= 0 ? key.slice(slash + 1) : key;
    const bucket = pyByBase.get(base);
    if (bucket) bucket.push({ file: p, key });
    else pyByBase.set(base, [{ file: p, key }]);
  }
  return { has: (p) => set.has(p), pyByBase };
}

// absolute python module "a.b.c" → files whose module-suffix matches. Returns ALL matches
// (over-count is safe); the common case is exactly one.
function resolvePyAbs(module, pyByBase) {
  const slashMod = module.replace(/\./g, "/");
  const slash = slashMod.lastIndexOf("/");
  const base = slash >= 0 ? slashMod.slice(slash + 1) : slashMod;
  const bucket = pyByBase.get(base);
  if (!bucket) return [];
  /** @type {string[]} */
  const out = [];
  for (const { file, key } of bucket) {
    if (key === slashMod || key.endsWith("/" + slashMod)) out.push(file);
  }
  return out;
}

// relative python ".x" / "..pkg.name" → file, resolved from the importer's package dir.
// One leading dot = the importer's own package; each extra dot climbs one package up.
function resolvePyRel(fromPath, spec, has) {
  const dots = (spec.match(/^\.+/) || [""])[0].length;
  const tail = spec.slice(dots); // "store.sqlite" | "x" | "" (bare "from . import x" base)
  if (!tail) return [];
  let dir = posix.dirname(fromPath);
  for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
  const rel = tail.replace(/\./g, "/");
  const base = dir === "." ? rel : `${dir}/${rel}`;
  return [`${base}.py`, `${base}/__init__.py`].filter(has);
}

// relative JS/TS specifier "./x" / "../y" → file, trying the usual extension + index resolutions.
// Bare specifiers ("react") are external → no edge.
const JS_EXTS = ["", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx"];
const JS_INDEX = ["/index.js", "/index.mjs", "/index.cjs", "/index.ts", "/index.tsx"];
function resolveJs(fromPath, spec, has) {
  if (!spec.startsWith(".")) return []; // external package
  const base = posix.normalize(posix.join(posix.dirname(fromPath), spec));
  for (const e of JS_EXTS) if (has(base + e)) return [base + e];
  for (const i of JS_INDEX) if (has(base + i)) return [base + i];
  return [];
}

/**
 * Resolve one file's raw import specifiers to intra-repo destination paths.
 * @param {string} format    "py" | "js" | "ts" (others → no edges)
 * @param {string} fromPath  importer repo-relative path
 * @param {string[]} specs   raw specifiers from the chunker
 * @param {ResolveCtx} ctx   per-pass resolution context
 * @returns {string[]} deduped intra-repo destination paths (self-edges removed)
 */
export function resolveImports(format, fromPath, specs, ctx) {
  if (!specs.length) return [];
  /** @type {Set<string>} */
  const out = new Set();
  for (const spec of specs) {
    let dsts;
    if (format === "py") {
      dsts = spec.startsWith(".") ? resolvePyRel(fromPath, spec, ctx.has) : resolvePyAbs(spec, ctx.pyByBase);
    } else if (format === "js" || format === "ts") {
      dsts = resolveJs(fromPath, spec, ctx.has);
    } else {
      continue;
    }
    for (const d of dsts) if (d !== fromPath) out.add(d);
  }
  return [...out];
}
