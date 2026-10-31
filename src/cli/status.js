// `litectx status [path]` and the one-line banner status. Strictly read-only: it never creates a db, a
// directory or a file, and opens an existing index readonly.

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { indexStamp } from "../indexer.js";
import { describeMode, detectMode, loadConfig } from "../ui/config.js";
import { basePort, liveUis } from "./launcher.js";
import { claudeState } from "./setup.js";
import { pkgDir, version } from "./paths.js";
import { bold, cyan, dim, green, yellow, yn } from "./style.js";

/** @returns {Promise<{ running: boolean, url: string, extra: number, source: { name: string, path: string } | null, current: import("./launcher.js").PageCurrent | null }>} the search page, whoever started it; `extra` = further live pages; `source`/`current` = the folder it has open */
export async function uiInfo() {
  const pages = await liveUis();
  return pages.length ? { running: true, url: pages[0].url, extra: pages.length - 1, source: pages[0].source, current: pages[0].current } : { running: false, url: `http://127.0.0.1:${basePort()}`, extra: 0, source: null, current: null };
}

/** @param {string} p @returns {string} `p` with the home directory as ~ */
export function shortPath(p) {
  const home = homedir();
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** @param {{ mode: string, repos: number }} m @returns {string} e.g. "46 repos" or "one repo" */
export const modeText = (m) => (m.mode === "repos" ? `${m.repos} repos` : "one repo");

/**
 * The saved active source's path in ui.json (what the page opens when it starts), or null if none saved.
 * @returns {string | null}
 */
export function savedSource() {
  const c = loadConfig();
  return c.sources.find((s) => s.name === c.active)?.path ?? null;
}

/** @param {number} extra @returns {string} e.g. " (+1 more — run litectx stop)", yellow; "" for none */
export const moreNote = (extra) => (extra > 0 ? ` ${yellow(`(+${extra} more — run litectx stop)`)}` : "");

/** @returns {Promise<string>} e.g. "running (http://127.0.0.1:4747)" or "not running" */
export async function uiLine() {
  const u = await uiInfo();
  return u.running ? `${green("running")} (${cyan(u.url)})${moreNote(u.extra)}` : dim("not running");
}

/** @returns {"yes" | "partial" | "no"} */
export function claudeSummary() {
  const c = claudeState();
  const n = [c.mcp, c.warm, c.preEdit].filter(Boolean).length;
  return n === 3 ? "yes" : n === 0 ? "no" : "partial";
}

/**
 * Read-only facts about the index at `path`. Opening a WAL database creates -wal/-shm files even readonly,
 * and status must leave no trace: read in place only while a writer already holds those files (live
 * process); otherwise read a throwaway copy.
 * @param {string} path
 * @returns {{ db: string, files?: number, repos?: number, meaning?: boolean, incomplete?: boolean, error?: string, mtime: Date } | null} null when no index
 */
export function indexInfo(path) {
  const db = join(path, ".litectx", "index.db");
  if (!existsSync(db)) return null;
  /** @type {{ db: string, files?: number, repos?: number, meaning?: boolean, incomplete?: boolean, error?: string, mtime: Date }} */
  const info = { db, mtime: statSync(db).mtime };
  const live = existsSync(`${db}-wal`) && existsSync(`${db}-shm`);
  const scratch = live ? null : mkdtempSync(join(tmpdir(), "litectx-status-"));
  let handle;
  try {
    if (scratch) {
      copyFileSync(db, join(scratch, "index.db"));
      if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, join(scratch, "index.db-wal"));
    }
    handle = new Database(scratch ? join(scratch, "index.db") : db, { readonly: true, fileMustExist: true });
    const one = (/** @type {string} */ sql) => /** @type {{ n: number }} */ (handle.prepare(sql).get()).n;
    info.files = one("SELECT count(*) AS n FROM file_index");
    const m = detectMode(path);
    if (m.ok && m.mode.mode === "repos") info.repos = m.mode.repos;
    info.meaning = one("SELECT count(*) AS n FROM file_embeddings") > 0;
    // a cold build that was cut short stores -stamp (see LiteCtx.index): its files are only partly there
    info.incomplete = Number(handle.pragma("user_version", { simple: true })) === -indexStamp();
  } catch (e) {
    info.error = e instanceof Error ? e.message : String(e);
  } finally {
    handle?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  return info;
}

/**
 * What `start` is about to open, before it waits: the folder given, else the saved active source in ui.json
 * (the current directory is never used). Reads ui.json and lists one directory level; touches nothing else.
 * @param {string} [path] the folder named on the command line, if any
 * @returns {string} e.g. "opening ~/PycharmProjects · all repos (46 found)"
 */
export function openingLine(path) {
  const target = path ? resolve(path) : savedSource();
  if (!target) return "no folder saved yet — the page opens its add-folder form";
  const m = detectMode(target);
  return `opening ${shortPath(target)} · ${m.ok ? describeMode(m.mode) : m.error}`;
}

/** @param {string} path @returns {string[]} lines about the index at `path` */
function indexLines(path) {
  const i = indexInfo(path);
  if (!i) return [`${bold("index:")} ${dim("none at")} ${path} — run ${cyan(`litectx index ${path}`)}`];
  const lines = [`${bold("index:")} ${i.db}`];
  if (i.error) lines.push(`  could not read the index: ${i.error}`);
  else {
    if (i.incomplete) lines.push(`  ${yellow("index: incomplete — a build is running or was stopped; run litectx index")}`);
    lines.push(`  files indexed: ${i.files}`);
    if (i.repos !== undefined) lines.push(`  repos: ${i.repos} (folder of repos)`);
    lines.push(`  meaning (embeddings): ${i.meaning ? "on" : dim("off")}`);
  }
  lines.push(`  last indexed: ${i.mtime.toISOString()}`);
  return lines;
}

/** @param {string} [path] @returns {Promise<string[]>} */
export async function statusLines(path) {
  const p = resolve(path ?? process.cwd());
  const c = claudeState();
  const y = (/** @type {boolean} */ b) => yn(b ? "yes" : "no");
  return [
    `${bold(`litectx ${version()}`)} ${dim(`— ${pkgDir()}`)}`,
    `${bold("UI:")} ${await uiLine()}`,
    ...indexLines(p),
    bold("Claude:"),
    `  MCP registered: ${y(c.mcp)}`,
    `  warm-index hook (SessionStart): ${y(c.warm)}`,
    `  pre-edit impact hook (PreToolUse:Edit): ${y(c.preEdit)}`,
    ...(c.mcp && c.warm && c.preEdit ? [] : [`  → run ${cyan("litectx setup")} to wire them`]),
  ];
}
