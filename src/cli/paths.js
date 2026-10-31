// Shared locations for the `litectx` command: this package's own directory and the per-user state
// files. HOME is resolved at call time (os.homedir) so tests can point it at a temp dir.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This running package's directory (works from a global install or a checkout). @returns {string} */
export const pkgDir = () => fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

/** @returns {string} */
export const version = () => /** @type {{ version: string }} */ (JSON.parse(readFileSync(join(pkgDir(), "package.json"), "utf8"))).version;

/** @returns {string} ~/.litectx — the UI's pid file and log live here */
export const stateDir = () => join(homedir(), ".litectx");
/** @returns {string} */
export const pidFile = () => join(stateDir(), "ui.pid");
/** @returns {string} ~/.litectx/pages — one `<pid>.json` per live `litectx ui` process */
export const pagesDir = () => join(stateDir(), "pages");
/** @returns {string} ~/.litectx/start.lock — held while a page is being started */
export const lockFile = () => join(stateDir(), "start.lock");
/** @returns {string} ~/.litectx/ui.starting — the pid of a page that `start` spawned and is still waiting for */
export const startingFile = () => join(stateDir(), "ui.starting");
/** @returns {string} */
export const logFile = () => join(stateDir(), "ui.out");

/** @returns {string} Claude Code's user settings (hooks) */
export const claudeSettings = () => join(homedir(), ".claude", "settings.json");
/** @returns {string} Claude Code's user config (user-scope MCP servers) */
export const claudeJson = () => join(homedir(), ".claude.json");

/**
 * A typed/passed folder → absolute path: a leading `~` / `~/` is the home dir. Throws if it is not a directory,
 * so nothing is ever created at a mistyped path.
 * @param {string} p @returns {string}
 */
export function resolveFolder(p) {
  const abs = resolve(p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  let ok = false;
  try {
    ok = statSync(abs).isDirectory();
  } catch {
    // missing or unreadable → the error below
  }
  if (!ok) throw new Error(`no such folder: ${p}`);
  return abs;
}
