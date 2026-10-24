// Shared locations for the `litectx` command: this package's own directory and the per-user state
// files. HOME is resolved at call time (os.homedir) so tests can point it at a temp dir.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** This running package's directory (works from a global install or a checkout). @returns {string} */
export const pkgDir = () => fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

/** @returns {string} */
export const version = () => /** @type {{ version: string }} */ (JSON.parse(readFileSync(join(pkgDir(), "package.json"), "utf8"))).version;

/** @returns {string} ~/.litectx — the UI's pid file and log live here */
export const stateDir = () => join(homedir(), ".litectx");
/** @returns {string} */
export const pidFile = () => join(stateDir(), "ui.pid");
/** @returns {string} */
export const logFile = () => join(stateDir(), "ui.out");

/** @returns {string} Claude Code's user settings (hooks) */
export const claudeSettings = () => join(homedir(), ".claude", "settings.json");
/** @returns {string} Claude Code's user config (user-scope MCP servers) */
export const claudeJson = () => join(homedir(), ".claude.json");
