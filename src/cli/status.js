// `litectx status [path]` and the one-line banner status. Strictly read-only: it never creates a db, a
// directory or a file, and opens an existing index readonly.

import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { detectMode } from "../ui/config.js";
import { answers, basePort, peekRunningUi } from "./launcher.js";
import { claudeState } from "./setup.js";
import { pkgDir, version } from "./paths.js";

/** @returns {Promise<string>} e.g. "running (http://127.0.0.1:4747)" or "not running" */
export async function uiLine() {
  const rec = await peekRunningUi();
  if (rec) return `running (${rec.url})`;
  const url = `http://127.0.0.1:${basePort()}`;
  return (await answers(url)) ? `running (${url}, started with \`litectx ui\`)` : "not running";
}

/** @returns {"yes" | "partial" | "no"} */
export function claudeSummary() {
  const c = claudeState();
  const n = [c.mcp, c.warm, c.preEdit].filter(Boolean).length;
  return n === 3 ? "yes" : n === 0 ? "no" : "partial";
}

/** @param {string} path @returns {string[]} lines about the index at `path` */
function indexLines(path) {
  const db = join(path, ".litectx", "index.db");
  if (!existsSync(db)) return [`index: none at ${path} — run \`litectx index ${path}\``];
  const lines = [];
  // Opening a WAL database creates -wal/-shm files even readonly, and status must leave no trace. Read in
  // place only while a writer already holds those files (live process); otherwise read a throwaway copy.
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
    lines.push(`index: ${db}`);
    lines.push(`  files indexed: ${one("SELECT count(*) AS n FROM file_index")}`);
    const m = detectMode(path);
    if (m.ok && m.mode.mode === "repos") lines.push(`  repos: ${m.mode.repos} (folder of repos)`);
    lines.push(`  meaning (embeddings): ${one("SELECT count(*) AS n FROM file_embeddings") > 0 ? "on" : "off"}`);
  } catch (e) {
    lines.push(`  could not read the index: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    handle?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  lines.push(`  last indexed: ${statSync(db).mtime.toISOString()}`);
  return lines;
}

/** @param {string} [path] @returns {Promise<string[]>} */
export async function statusLines(path) {
  const p = resolve(path ?? process.cwd());
  const c = claudeState();
  const yn = (/** @type {boolean} */ b) => (b ? "yes" : "no");
  return [
    `litectx ${version()} — ${pkgDir()}`,
    `UI: ${await uiLine()}`,
    ...indexLines(p),
    "Claude:",
    `  MCP registered: ${yn(c.mcp)}`,
    `  warm-index hook (SessionStart): ${yn(c.warm)}`,
    `  pre-edit impact hook (PreToolUse:Edit): ${yn(c.preEdit)}`,
    ...(c.mcp && c.warm && c.preEdit ? [] : ["  → run `litectx setup` to wire them"]),
  ];
}
