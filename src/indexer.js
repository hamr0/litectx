// File collection + ingestion. Routed by extension, never by sniffing content.
// Prefers `git ls-files` (respects .gitignore, tracked-only); falls back to a
// filesystem walk that skips the usual noise dirs.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", ".litectx", "dist", "build", "coverage", ".venv", "__pycache__"]);
const DOC_EXTS = new Set([".md"]);

/**
 * List candidate files under root, filtered to the included extensions.
 * @param {string} root
 * @param {string[]} include  extensions like [".ts", ".js", ".py", ".md"]
 * @param {string[]} [pathspecs]  optional git pathspecs to scope the index (e.g. ["app/**\/*.js"])
 * @returns {string[]} repo-relative paths
 */
export function collectFiles(root, include, pathspecs) {
  const inc = new Set(include.map((e) => (e.startsWith(".") ? e : `.${e}`)));
  let files;
  try {
    files = execFileSync("git", ["-C", root, "ls-files", ...(pathspecs ?? [])], { encoding: "utf8", maxBuffer: 1 << 28 })
      .split("\n")
      .filter(Boolean);
  } catch {
    files = walk(root, root);
  }
  return files.filter((f) => inc.has(extname(f)));
}

/**
 * @param {string} dir
 * @param {string} root
 * @returns {string[]}
 */
function walk(dir, root) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, root));
    else if (st.isFile()) out.push(relative(root, full));
  }
  return out;
}

/**
 * Read files into DocRow records. Unreadable files are skipped.
 * @param {string} root
 * @param {string[]} relPaths
 * @returns {import("./store.js").DocRow[]}
 */
export function readDocs(root, relPaths) {
  /** @type {import("./store.js").DocRow[]} */
  const docs = [];
  for (const p of relPaths) {
    try {
      const body = readFileSync(join(root, p), "utf8");
      docs.push({ path: p, kind: DOC_EXTS.has(extname(p)) ? "doc" : "code", body });
    } catch {
      // skip binaries / unreadable files
    }
  }
  return docs;
}
