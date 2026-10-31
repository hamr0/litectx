// Menu pick 4 only: before a folder with no index is indexed, say how big it is and roughly how long that takes,
// and let the person confirm, pick another folder, or cancel. `litectx index` never goes through this.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { childRepos } from "../indexer.js";
import { bcyan, cyan, dim, red, yellow } from "./style.js";
import { resolveFolder } from "./paths.js";

/** Counting stops here, so a huge folder cannot make the count itself slow. */
export const COUNT_CAP = 5000;

// Same file set the indexer takes (src/index.js DEFAULT_INCLUDE; src/indexer.js SKIP_DIRS).
const INCLUDE = new Set([".ts", ".js", ".mjs", ".cjs", ".py", ".md"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".litectx", "dist", "build", "coverage", ".venv", "__pycache__"]);

// Seconds per file, cold, [low, high]. Measured 2026-10-31, 8 cores, scratch dbPath, embeddings per mode:
//   keywords only   litectx src 30 files 19 ms/file; aurora 688 files 6.4 ms/file          -> 0.005 to 0.05
//   with meaning    litectx src 30 files 155 ms/file; aurora 688 files 442 ms/file (304 s,
//                   9,824 vectors; load rose from ~1 to ~6 during the run, so a busy machine is slower);
//                   markdown 71 files 1.6 s/file (older measurement, docs sections embed one by one) -> 0.15 to 1.6
const KW_SEC = [0.005, 0.05];
const EMB_SEC = [0.15, 1.6]; // 1.6 s/file: the older md measurement (71 files, 116 s)

/**
 * Count the files the indexer would take under `root`, stopping at `cap`. Uses `git ls-files` where the indexer
 * does (a repo, or each repo of a folder of repos), a bounded walk otherwise.
 * @param {string} root @param {number} [cap]
 * @returns {{ count: number, capped: boolean }}
 */
export function countFiles(root, cap = COUNT_CAP) {
  let count = 0;
  const ok = (/** @type {string} */ f) => INCLUDE.has(extname(f).toLowerCase());
  /** @param {string} repo @returns {boolean} true once the cap is hit */
  const gitCount = (repo) => {
    try {
      const out = execFileSync("git", ["-c", "core.fsmonitor=false", "-C", repo, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
      for (const f of out.split("\0")) if (f && ok(f) && ++count >= cap) return true;
    } catch {
      // not listable: the indexer would skip it too
    }
    return false;
  };
  if (existsSync(join(root, ".git"))) {
    const capped = gitCount(root);
    return { count, capped };
  }
  let repos = [];
  try {
    repos = childRepos(root);
  } catch {
    // unreadable
  }
  if (repos.length) {
    for (const r of repos) if (gitCount(join(root, r))) return { count: cap, capped: true };
    return { count, capped: false };
  }
  /** @param {string} dir @returns {boolean} true once the cap is hit */
  const walk = (dir) => {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return false;
    }
    for (const n of names) {
      if (SKIP_DIRS.has(n)) continue;
      const p = join(dir, n);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (walk(p)) return true;
      } else if (st.isFile() && ok(n) && ++count >= cap) return true;
    }
    return false;
  };
  const capped = walk(root);
  return { count, capped };
}

/** @param {number} sec @returns {[number, string]} rounded value and unit */
function human(sec) {
  if (sec < 90) return [Math.max(5, Math.round(sec / 5) * 5), "seconds"];
  if (sec < 5400) return [Math.round(sec / 60), "minutes"];
  return [Math.round(sec / 3600), "hours"];
}

/** @param {number[]} r  [low, high] seconds per file @param {number} n @param {boolean} floor  count was capped: say the high end as a floor @returns {string} */
function range(r, n, floor) {
  const [l, lu] = human(n * r[0]);
  const [h, hu] = human(n * r[1]);
  if (floor) return `${h}+ ${hu}`;
  if (lu === hu) return l === h ? `about ${h} ${hu}` : `${l} to ${h} ${hu}`;
  return `${l} ${lu} to ${h} ${hu}`;
}

/**
 * The question to show for `root`, or null when there is nothing to ask.
 * @param {string} root absolute folder
 * @returns {null | { count: number, capped: boolean, lines: string[] }} null: it already has an index
 */
export function indexQuestion(root) {
  if (existsSync(join(root, ".litectx", "index.db"))) return null;
  const { count, capped } = countFiles(root);
  const home = root === homedir();
  const size = capped ? "Over 5,000 files." : `${count.toLocaleString("en-US")} files.`;
  const lines = [
    `${home ? yellow(`${root} is your home directory, not a project.`) + " " : ""}${root} has no index yet. ${size}`,
    `Rough time: ${range(KW_SEC, count, capped)} without meaning search, ${range(EMB_SEC, count, capped)} with it.`,
  ];
  return { count, capped, lines };
}

/**
 * Confirm a chosen folder that has no index. Typing another folder re-runs the check. A path that is not a
 * folder is returned as is, so the index step reports it exactly as before.
 * @param {string} first  the folder as typed
 * @param {(q: string) => Promise<string>} ask  one prompt
 * @returns {Promise<string | null>} the folder to index, null = cancelled
 */
export async function confirmFolder(first, ask) {
  let raw = first;
  for (;;) {
    let root;
    try {
      root = resolveFolder(raw);
    } catch {
      return raw;
    }
    const q = indexQuestion(root);
    if (!q) return raw;
    for (const l of q.lines) console.log(`  ${l}`);
    console.log(`    ${bcyan("y")}  index this folder\n    ${dim("or type another folder")}\n    ${bcyan("q")}  cancel`);
    const a = (await ask(`${cyan(">")} `)).trim();
    if (a.toLowerCase() === "y") return raw;
    if (a === "" || a.toLowerCase() === "q") return null;
    raw = a;
  }
}
