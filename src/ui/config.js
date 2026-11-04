// `litectx ui` settings: the sources list (~/.litectx/ui.json) and per-path mode detection.
// These are the UI's own settings, separate from LiteCtxConfig (docs/wiki/local-ui.md).

import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { childRepos } from "../indexer.js";

/**
 * @typedef {Object} Source
 * @property {string} name
 * @property {string} path         absolute directory
 * @property {boolean} [embeddings]  meaning re-rank on for this source (default off)
 */
/** @typedef {{ active: string | null, sources: Source[], editor?: string }} UiConfig  `editor`: absolute path of the IDE launcher */
/** @typedef {{ mode: "repo" | "repos", repos: number }} Mode */

/** Where the settings live. `LITECTX_UI_CONFIG` overrides the default (tests; relocated homes). @returns {string} */
export function configPath() {
  return process.env.LITECTX_UI_CONFIG || join(homedir(), ".litectx", "ui.json");
}

/** The click log sits beside the config file. @returns {string} */
export function logPath() {
  return join(dirname(configPath()), "ui-log.jsonl");
}

/** @returns {UiConfig} an unreadable or malformed file reads as empty — the page then opens on the Add form */
export function loadConfig() {
  try {
    const j = JSON.parse(readFileSync(configPath(), "utf8"));
    /** @type {Source[]} */
    const sources = [];
    for (const s of Array.isArray(j?.sources) ? j.sources : []) {
      if (s && typeof s.name === "string" && typeof s.path === "string") {
        sources.push({ name: s.name, path: s.path, ...(s.embeddings === true ? { embeddings: true } : {}) });
      }
    }
    const active = typeof j?.active === "string" && sources.some((s) => s.name === j.active) ? j.active : (sources[0]?.name ?? null);
    return { active, sources, ...(typeof j?.editor === "string" && j.editor ? { editor: j.editor } : {}) };
  } catch {
    return { active: null, sources: [] };
  }
}

/**
 * Canonical form of a source path, for comparing two sources: resolved (no trailing slash, no `..`) and, when the
 * directory exists, symlink-free. A relative path is returned as given (detectMode refuses it anyway).
 * @param {string} p @returns {string}
 */
export function normPath(p) {
  if (!isAbsolute(p)) return p;
  const r = resolve(p);
  try {
    return realpathSync(r);
  } catch {
    return r;
  }
}

/**
 * Heal a config that holds several sources on one path (they share one index.db, so the twins are the same
 * source twice). Keeps the active one if it is among the twins, else the first; mutates `cfg`. Deletes no index.
 * @param {UiConfig} cfg @returns {boolean} true when something was dropped (the caller saves once)
 */
export function dedupeSources(cfg) {
  /** @type {Map<string, Source>} */
  const keep = new Map();
  for (const s of cfg.sources) {
    const k = normPath(s.path);
    const prev = keep.get(k);
    if (!prev || (s.name === cfg.active && prev.name !== cfg.active)) keep.set(k, s);
  }
  if (keep.size === cfg.sources.length) return false;
  const kept = new Set(keep.values());
  const survivors = cfg.sources.filter((s) => kept.has(s));
  if (!survivors.some((s) => s.name === cfg.active)) {
    const twin = cfg.sources.find((s) => s.name === cfg.active);
    const sv = twin ? keep.get(normPath(twin.path)) : undefined;
    cfg.active = sv?.name ?? survivors[0]?.name ?? null;
  }
  cfg.sources = survivors;
  return true;
}

/** Atomic write (tmp + rename) so a crash never leaves half a config. @param {UiConfig} cfg */
export function saveConfig(cfg) {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
  renameSync(tmp, p);
}

/**
 * Decide how a source path is searched. Absolute + existing directory required.
 *  - has `.git`                                → one-repo mode (the repo's own index, shared with agents)
 *  - no `.git`, git repos one level down       → all-repos mode (one combined index)
 *  - neither                                   → error (plain-folder files mode is parked)
 * @param {string} path
 * @returns {{ ok: true, mode: Mode } | { ok: false, error: string }}
 */
export function detectMode(path) {
  if (typeof path !== "string" || !isAbsolute(path)) return { ok: false, error: "path must be absolute" };
  try {
    if (!statSync(path).isDirectory()) return { ok: false, error: "path is not a directory" };
  } catch {
    return { ok: false, error: "path does not exist" };
  }
  if (existsSync(join(path, ".git"))) return { ok: true, mode: { mode: "repo", repos: 1 } };
  let n = 0;
  try {
    n = childRepos(path).length;
  } catch {
    // unreadable directory → no repos
  }
  if (n > 0) return { ok: true, mode: { mode: "repos", repos: n } };
  return { ok: false, error: "no git repos found (a folder of plain files is not supported yet)" };
}

/** @param {Mode} m @returns {string} e.g. "all repos (45 found)" */
export function describeMode(m) {
  return m.mode === "repo" ? "one repo" : `all repos (${m.repos} found)`;
}

const NO_EDITOR = 'PyCharm not found; set "editor" in ~/.litectx/ui.json';

/** @param {string} p @returns {boolean} an existing, executable regular file */
function runnable(p) {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the editor launcher to run for "open in PyCharm". The `editor` setting (absolute path) wins and is
 * never second-guessed; otherwise: `pycharm` on PATH, then the usual Linux install locations.
 * @param {string | undefined} editor  the `editor` field of ui.json
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function resolveEditor(editor) {
  if (editor !== undefined) {
    if (isAbsolute(editor) && runnable(editor)) return { ok: true, path: editor };
    return { ok: false, error: `editor '${editor}' in ~/.litectx/ui.json is not an executable file` };
  }
  const onPath = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "pycharm"));
  const candidates = [
    ...onPath,
    "/opt/pycharm/bin/pycharm",
    join(homedir(), ".local/share/JetBrains/Toolbox/scripts/pycharm"),
    "/snap/bin/pycharm-professional",
    "/snap/bin/pycharm-community",
  ];
  for (const c of candidates) if (isAbsolute(c) && runnable(c)) return { ok: true, path: c };
  return { ok: false, error: NO_EDITOR };
}
