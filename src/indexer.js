// File collection + ingestion. Routed by extension, never by sniffing content.
// Prefers `git ls-files` (respects .gitignore, tracked-only); falls back to a
// filesystem walk that skips the usual noise dirs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", ".git", ".litectx", "dist", "build", "coverage", ".venv", "__pycache__"]);

/** @type {number | null} */
let stampCache = null;

/**
 * A fingerprint of the litectx source that decides *what gets written* at index time — the chunker,
 * the tokenizer, the schema. Stored in the index (`PRAGMA user_version`) so an index built by an
 * older litectx can be recognised and rebuilt.
 *
 * Why a source hash and not the package version: most releases don't touch indexing, and stamping the
 * package version would force a full re-chunk of every consumer's repo on every patch. And why not a
 * hand-maintained constant: someone edits the chunker, forgets to bump it, and the index silently rots
 * — which is the exact failure this exists to kill. A hash cannot be forgotten.
 *
 * It over-triggers slightly (a change to an unrelated module also moves it). That is the safe
 * direction: an unnecessary rebuild costs time, a skipped one serves wrong chunk boundaries forever.
 *
 * Computed once per process (~0.6ms) — the source cannot change under a running process.
 * @returns {number}  a POSITIVE i32 (the width `PRAGMA user_version` stores). Never 0 — see below.
 */
export function indexStamp() {
  if (stampCache !== null) return stampCache;
  const dir = dirname(fileURLToPath(import.meta.url));
  const h = createHash("sha256");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) h.update(readFileSync(join(dir, f)));
  // `|| 1` because 0 is RESERVED: an index that predates the stamp (or was never written) reads back as
  // 0, and that is precisely what means "rebuild me". A source hash that happened to land on 0 would be
  // indistinguishable from never-stamped — and would read as *fresh*, so the legacy indexes this exists
  // to heal would silently keep their stale boundaries. Vanishingly unlikely, permanently wrong: the one
  // combination the mechanism cannot afford. Mapping that single value to 1 costs nothing.
  stampCache = (h.digest().readInt32BE(0) & 0x7fffffff) || 1;
  return stampCache;
}

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
 * The git repos ONE level under `root`: child directories holding a `.git` (a dir, or a file for a
 * worktree/submodule), sorted by name. One level only — deeper repos are not searched (owner
 * decision 4A, docs/wiki/local-ui.md). Skipped, by design: hidden names (`.dotfiles`), repos named like
 * a noise dir (`node_modules`, `dist`, `build`, `coverage`, `.venv`, `__pycache__`, `.litectx`), and
 * SYMLINKED directories (a symlink to a repo would index it twice, under two prefixes). Rename such a
 * repo's folder to have it indexed.
 * @param {string} root
 * @returns {string[]} child directory names
 */
export function childRepos(root) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    try {
      if (lstatSync(join(root, name)).isSymbolicLink()) continue;
      if (statSync(join(root, name)).isDirectory() && statSync(join(root, name, ".git"))) out.push(name);
    } catch {
      // no .git (or unreadable) → not a repo
    }
  }
  return out;
}

/**
 * Route pathspecs to one child repo. A spec whose first segment is a child repo's name goes to that
 * repo only, prefix stripped (`rwxmap/src` → `src` in rwxmap; `rwxmap` alone → all of rwxmap). Any
 * other spec (`*.md`, `docs/x.md`) goes to every repo. A leading `./` is normalized away first. Specs
 * are routed on their first `/` segment only: `:`-magic pathspecs (`:(glob)…`, `:!x`) are not parsed
 * and go to every repo verbatim, and a spec whose first segment merely equals a repo name (e.g. a
 * `docs/` folder inside every repo while a repo is called `docs`) is routed to that repo, not the others.
 * Returns `undefined` = unscoped (whole repo),
 * `null` = no spec targets this repo (skip it), else the repo-relative specs.
 * @param {string} repo
 * @param {string[] | undefined} pathspecs
 * @param {Set<string>} repos  every child repo name
 * @returns {string[] | undefined | null}
 */
export function repoPathspecs(repo, pathspecs, repos) {
  if (!pathspecs?.length) return undefined;
  /** @type {string[]} */
  const mine = [];
  for (const raw of pathspecs) {
    const p = raw.replace(/^(\.\/)+/, "");
    const head = p.split("/")[0];
    if (!repos.has(head)) mine.push(p);
    else if (head === repo) {
      const rest = p.slice(repo.length + 1);
      if (!rest) return undefined;
      mine.push(rest);
    }
  }
  return mine.length ? mine : null;
}

/**
 * List candidate files under root, filtered to the included extensions.
 * @param {string} root
 * @param {string[]} include  extensions like [".ts", ".js", ".py", ".md"]
 * @param {string[]} [pathspecs]  optional git pathspecs to scope the index (e.g. ["app/**\/*.js"])
 * @param {boolean} [children]  index the git repos one level under root instead of root itself:
 *                              each repo's tracked files, paths prefixed `<repo>/` (see {@link childRepos})
 * @param {{ repo: string, error: string }[]} [skipped]  child-repo mode: filled with each repo whose
 *                              `git ls-files` failed (its files are NOT listed, so callers must keep, not delete, its prior entries)
 * @returns {string[]} root-relative paths
 */
export function collectFiles(root, include, pathspecs, children = false, skipped = []) {
  const inc = new Set(include.map((e) => (e.startsWith(".") ? e : `.${e}`)));
  if (children) {
    /** @type {string[]} */
    const all = [];
    const repos = childRepos(root);
    const names = new Set(repos);
    for (const repo of repos) {
      const specs = repoPathspecs(repo, pathspecs, names);
      if (specs === null) continue;
      try {
        const out = execFileSync("git", ["-C", join(root, repo), "ls-files", "-z", "--", ...(specs ?? [])], {
          encoding: "utf8",
          maxBuffer: 1 << 28,
          stdio: ["ignore", "pipe", "pipe"],
        });
        for (const f of out.split("\0")) if (f && inc.has(extname(f).toLowerCase())) all.push(`${repo}/${f}`);
      } catch (e) {
        // a broken repo (corrupt index, no git) is never walked — untracked data stays out. It is REPORTED,
        // not silently dropped: index() keeps its prior entries rather than reading "unlisted" as "deleted".
        const err = /** @type {{ stderr?: unknown, message?: unknown }} */ (e);
        const text = String(err.stderr || err.message || "git ls-files failed");
        skipped.push({ repo, error: text.split("\n").find((l) => l.trim()) ?? "git ls-files failed" });
      }
    }
    return all;
  }
  let files;
  try {
    // `--` so a pathspec can never be misread as a git option (parity with gitsig.js / the rg sweeps).
    // `-z`: raw NUL-separated paths. Without it git C-quotes any non-ASCII name ("Cr\303\250me.md"),
    // and that quoted string matches no file on disk — the file was silently never indexed.
    files = execFileSync("git", ["-C", root, "ls-files", "-z", "--", ...(pathspecs ?? [])], { encoding: "utf8", maxBuffer: 1 << 28 })
      .split("\0")
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
