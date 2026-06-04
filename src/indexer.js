// File collection + ingestion. Routed by extension, never by sniffing content.
// Prefers `git ls-files` (respects .gitignore, tracked-only); falls back to a
// filesystem walk that skips the usual noise dirs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", ".litectx", "dist", "build", "coverage", ".venv", "__pycache__"]);

// extension → format tag (and, via the tag, kind). Routing is by extension only (§6).
const FORMAT = {
  ".ts": "ts",
  ".tsx": "ts",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "js",
  ".py": "py",
  ".md": "md",
};

/**
 * Classify a path into its `kind` + `format` from the extension alone.
 * @param {string} relPath
 * @returns {{ kind: string, format: string }}
 */
export function classify(relPath) {
  const format = FORMAT[extname(relPath).toLowerCase()] ?? extname(relPath).replace(/^\./, "").toLowerCase();
  return { kind: format === "md" ? "doc" : "code", format };
}

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
  return files.filter((f) => inc.has(extname(f).toLowerCase()));
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
 * Diff the current file list against the previously-indexed state, reading (and hashing)
 * only files whose mtime moved (§6, fast→slow: mtime → content-hash). Unchanged files are
 * skipped without a read.
 * @param {string} root
 * @param {string[]} relPaths  current candidate files
 * @param {Map<string, { hash: string, mtime: number, size: number }>} prev  prior index state
 * @returns {{ upserts: import("./store.js").Upsert[], touch: { path: string, mtime: number }[], unchanged: number }}
 */
export function diffFiles(root, relPaths, prev) {
  /** @type {import("./store.js").Upsert[]} */
  const upserts = [];
  /** @type {{ path: string, mtime: number }[]} */
  const touch = [];
  let unchanged = 0;

  for (const p of relPaths) {
    let mtime, size;
    try {
      const st = statSync(join(root, p));
      mtime = Math.floor(st.mtimeMs);
      size = st.size;
    } catch {
      continue; // vanished between listing and stat
    }
    const was = prev.get(p);
    if (was && was.mtime === mtime && was.size === size) {
      unchanged++; // fast skip: neither mtime nor size moved → assume content unchanged
      continue;
    }
    let body;
    try {
      body = readFileSync(join(root, p), "utf8");
    } catch {
      continue; // binary / unreadable
    }
    const hash = createHash("sha256").update(body).digest("hex");
    if (was && was.hash === hash) {
      touch.push({ path: p, mtime }); // content unchanged, just refresh mtime
      unchanged++;
      continue;
    }
    const { kind, format } = classify(p);
    upserts.push({ path: p, kind, format, body, hash, mtime, size });
  }
  return { upserts, touch, unchanged };
}
