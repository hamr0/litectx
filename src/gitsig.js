// File-level git activity metadata (slice 4): commit count + last-commit time per file, from a
// SINGLE `git log` pass. This is GROUNDING shown alongside recall hits — never a ranking signal.
// The Slice-4 Step-0 POC falsified git as a scored prior (repo-dependent; §4/§4.1): git gives EDIT
// frequency, not ACCESS frequency, so it is displayed raw and left to the caller to weigh. No
// per-block blame (file granularity only) — that, and base-level activation, are the access-log tier.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { childRepos, repoPathspecs } from "./indexer.js";

/**
 * @typedef {Object} GitSig
 * @property {number} commits          number of commits that touched the file
 * @property {number|null} lastCommit  unix time (seconds) of the most recent such commit, or null
 */

// commit lines are prefixed with SOH (0x01) — a control byte that never appears in a path, so a
// file named "@types/x" or "-foo" can't be mistaken for a commit header.
const FMT = "--pretty=format:\x01%ct";

/**
 * Collect per-file git activity in one `git log` pass, scoped by the same pathspecs as the index.
 * Renames are not followed (counts accrue under the path's current name — fine for grounding).
 * Returns an empty map when the root is not a git repo, so metadata is always optional.
 * @param {string} root
 * @param {string[]} [pathspecs]
 * @param {boolean} [children]  root holds git repos one level down: collect each, keys prefixed `<repo>/`
 * @returns {Map<string, GitSig>}
 */
export function collectGitSig(root, pathspecs, children = false) {
  if (children) {
    /** @type {Map<string, GitSig>} */
    const all = new Map();
    const repos = childRepos(root);
    const names = new Set(repos);
    for (const repo of repos) {
      const specs = repoPathspecs(repo, pathspecs, names);
      if (specs === null) continue;
      for (const [f, g] of collectGitSig(join(root, repo), specs)) all.set(`${repo}/${f}`, g);
    }
    return all;
  }
  /** @type {Map<string, GitSig>} */
  const map = new Map();
  let out;
  try {
    out = execFileSync("git", ["-C", root, "log", "-z", FMT, "--name-only", "--", ...(pathspecs ?? [])], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return map; // not a git repo / git unavailable → no metadata (graceful)
  }
  /** @type {number|null} */
  let ct = null;
  // `-z` output: each header is `\x01<ct>\n` glued to the commit's FIRST name, every name NUL-terminated
  // (raw bytes, so `"`, `\\`, tab, newline and non-ASCII names need no unquoting), commits separated by an
  // empty token. The header's `\n` is the first one in the token (<ct> is digits), so a newline inside a
  // name can never be mistaken for it.
  for (const tok of out.split("\0")) {
    if (!tok) continue;
    let line = tok;
    if (tok.charCodeAt(0) === 1) {
      const nl = tok.indexOf("\n");
      const t = Number(nl < 0 ? tok.slice(1) : tok.slice(1, nl));
      ct = Number.isFinite(t) ? t : null;
      if (nl < 0 || nl === tok.length - 1) continue; // header with no name (e.g. an empty/merge commit)
      line = tok.slice(nl + 1);
    }
    if (ct === null) continue; // a file line before any commit header — ignore
    const cur = map.get(line);
    if (cur) {
      cur.commits++;
      if (ct > (cur.lastCommit ?? 0)) cur.lastCommit = ct;
    } else {
      map.set(line, { commits: 1, lastCommit: ct });
    }
  }
  return map;
}
