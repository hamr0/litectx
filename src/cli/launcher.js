// `litectx start` / `litectx stop`: run the `litectx ui` server in the background and track it with a
// pid file (~/.litectx/ui.pid). Every function throws a plain Error on failure; the caller prints it.

import { spawn } from "node:child_process";
import net from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cyan } from "./style.js";
import { logFile, pagesDir, pidFile, pkgDir, stateDir } from "./paths.js";

const DEFAULT_PORT = 4747;
const PORT_TRIES = 20;

/** The port the UI prefers. `LITECTX_DEFAULT_PORT` is an internal override (tests); it is not documented config. @returns {number} */
export function basePort() {
  const n = Number(process.env.LITECTX_DEFAULT_PORT);
  return Number.isInteger(n) && n > 0 && n < 65535 - PORT_TRIES ? n : DEFAULT_PORT;
}

/** @param {number} port @returns {Promise<boolean>} can 127.0.0.1:port be bound right now? */
function isFree(port) {
  return new Promise((ok) => {
    const s = net.createServer();
    s.once("error", () => ok(false));
    s.listen(port, "127.0.0.1", () => s.close(() => ok(true)));
  });
}

/**
 * Walk base, base+1, … (bounded) to the first port that can be bound; occupied ports are skipped.
 * @returns {Promise<{ port: number }>}
 */
export async function pickPort() {
  const base = basePort();
  for (let p = base; p < base + PORT_TRIES; p++) if (await isFree(p)) return { port: p };
  throw new Error(`no free port in ${base}-${base + PORT_TRIES - 1}; pass --port <n>`);
}
const START_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;

/** How long `stop` waits for a page to exit. `LITECTX_STOP_TIMEOUT_MS` is an internal override (tests); not documented config. @returns {number} */
function stopTimeoutMs() {
  const n = Number(process.env.LITECTX_STOP_TIMEOUT_MS);
  return Number.isInteger(n) && n > 0 ? n : STOP_TIMEOUT_MS;
}

/** @typedef {{ pid: number, port: number, url: string, startedAt: string }} UiRecord */

/** @param {number} ms */
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** @param {number} pid @returns {boolean} */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM"; // exists, not ours
  }
}

/**
 * What `url` says about itself if it answers as a litectx ui (its state endpoint has a version and a sources
 * list), else null. `pid` is absent from an older litectx ui.
 * @param {string} url
 * @returns {Promise<{ pid: number | null, source: { name: string, path: string } | null } | null>}
 */
async function probe(url) {
  try {
    const r = await fetch(`${url}/api/sources`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = /** @type {any} */ (await r.json());
    if (typeof j?.version !== "string" || !Array.isArray(j?.sources)) return null;
    const src = j.sources.find((/** @type {any} */ x) => x?.name === j.active);
    return { pid: Number.isInteger(j.pid) ? j.pid : null, source: src ? { name: String(src.name), path: String(src.path) } : null };
  } catch {
    return null;
  }
}

/** Does `url` answer as a litectx ui? @param {string} url @returns {Promise<boolean>} */
export async function answers(url) {
  return (await probe(url)) !== null;
}

/** @typedef {{ url: string, port: number, pid: number | null, source: { name: string, path: string } | null, origin: "start" | "foreground" }} LivePage */

/** @typedef {{ pid: number, url: string, port: number, path: string | null, startedAt: string }} PageEntry */

/**
 * Record this process in the page registry (`~/.litectx/pages/<pid>.json`) so `start`/`stop`/`status` find it on
 * any port. Called by `litectx ui` once it is listening; the entry is removed on exit. Best effort: a registry
 * that cannot be written only means the page is found through the pid file / port range instead.
 * @param {{ url: string, path?: string | null }} o
 */
export function registerPage(o) {
  try {
    mkdirSync(pagesDir(), { recursive: true });
    const file = join(pagesDir(), `${process.pid}.json`);
    /** @type {PageEntry} */
    const entry = { pid: process.pid, url: o.url, port: Number(new URL(o.url).port), path: o.path ?? null, startedAt: new Date().toISOString() };
    writeFileSync(file, JSON.stringify(entry, null, 2) + "\n");
    process.on("exit", () => rmSync(file, { force: true }));
  } catch {
    // registry unavailable
  }
}

/** @returns {PageEntry[]} the registry's well-formed entries (unverified: a killed page leaves its file behind) */
function readRegistry() {
  /** @type {PageEntry[]} */
  const out = [];
  let names = [];
  try {
    names = readdirSync(pagesDir());
  } catch {
    return out;
  }
  for (const n of names) {
    try {
      const j = JSON.parse(readFileSync(join(pagesDir(), n), "utf8"));
      if (Number.isInteger(j?.pid) && typeof j?.url === "string") out.push({ pid: j.pid, url: j.url, port: Number(j.port), path: j.path ?? null, startedAt: String(j.startedAt ?? "") });
    } catch {
      // malformed entry: ignored
    }
  }
  return out;
}

/**
 * Every litectx search page that is live right now: the registry's pages, the pid file's URL (older versions)
 * and every port in the fallback range (older versions). A registry entry whose pid is dead, or whose URL
 * answers as a different pid, is stale and its file is deleted; one that merely does not answer right now (a
 * busy page) is left in place but not reported.
 * @returns {Promise<LivePage[]>}
 */
export async function liveUis() {
  const rec = readRecord();
  const reg = readRegistry();
  const base = basePort();
  const urls = new Set([...reg.map((e) => e.url), ...(rec ? [rec.url] : []), ...Array.from({ length: PORT_TRIES }, (_, i) => `http://127.0.0.1:${base + i}`)]);
  const found = await Promise.all([...urls].map(async (url) => ({ url, info: await probe(url) })));
  for (const e of reg) {
    const info = found.find((f) => f.url === e.url)?.info;
    if (!alive(e.pid) || (info && info.pid !== null && info.pid !== e.pid)) rmSync(join(pagesDir(), `${e.pid}.json`), { force: true });
  }
  /** @type {LivePage[]} */
  const pages = [];
  for (const { url, info } of found) {
    if (!info) continue;
    const pid = info.pid ?? reg.find((e) => e.url === url)?.pid ?? (rec && rec.url === url ? rec.pid : null);
    pages.push({ url, port: Number(new URL(url).port), pid, source: info.source, origin: rec && pid === rec.pid ? "start" : "foreground" });
  }
  return pages;
}

/** @param {LivePage} p @returns {string} the "already live" line */
export function liveMessage(p) {
  const src = p.source ? `source ${p.source.name} (${p.source.path})` : "no source yet";
  return `already live: ${cyan(p.url)} — ${src}, pid ${p.pid ?? "unknown"}`;
}

/**
 * May `pid` be signalled as the litectx ui serving `page`? Linux: its command line is `litectx[.js] ui` (never
 * `litectx-mcp`, never anything else) AND the page itself reported that pid. Elsewhere (no /proc): the page
 * reporting that pid is the evidence. Never signal a pid for which this is false.
 * @param {LivePage} page @returns {boolean}
 */
function isLitectxUi(page) {
  if (page.pid === null) return false;
  let cmd;
  try {
    cmd = readFileSync(`/proc/${page.pid}/cmdline`, "utf8").split("\0");
  } catch {
    return true; // no /proc: the URL answered as litectx and named this pid
  }
  const i = cmd.findIndex((a) => /(^|[\\/])litectx(\.js)?$/.test(a));
  return i >= 0 && cmd[i + 1] === "ui";
}

/** @returns {UiRecord | null} the pid file's contents, or null if absent/unreadable */
function readRecord() {
  try {
    const j = JSON.parse(readFileSync(pidFile(), "utf8"));
    if (Number.isInteger(j?.pid) && typeof j?.url === "string") return { pid: j.pid, port: Number(j.port), url: j.url, startedAt: String(j.startedAt ?? "") };
  } catch {
    // absent or malformed
  }
  return null;
}

/** Open `url` in the default browser. Failure is ignored (the URL is printed either way). @param {string} url */
export function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]] : ["xdg-open", [url]];
  try {
    const p = spawn(cmd, args, { detached: true, stdio: "ignore" });
    p.on("error", () => {});
    p.unref();
  } catch {
    // no opener on this machine
  }
}

/**
 * Start the background search page, unless one is already live (only one at a time): then start nothing and
 * return the live pages (opening the browser on the first one).
 * @param {{ path?: string, port?: number, embeddings?: boolean, open?: boolean }} o
 * @returns {Promise<{ url: string, started: boolean, log: string, live: LivePage[] }>}
 */
export async function startUi(o) {
  const open = o.open !== false;
  const live = await liveUis();
  if (live.length) {
    if (open) openBrowser(live[0].url);
    return { url: live[0].url, started: false, log: logFile(), live };
  }
  rmSync(pidFile(), { force: true }); // nothing is live, so any pid file is stale
  // a port held by anything that is not litectx moves on to the next free one, unless the caller chose the
  // port explicitly
  let port = o.port;
  if (port === undefined) port = (await pickPort()).port;
  else if (port !== 0 && !(await isFree(port))) throw new Error(`port ${port} is in use by another program; pick another with --port`);

  mkdirSync(stateDir(), { recursive: true });
  const log = logFile();
  const out = openSync(log, "w");
  const args = [join(pkgDir(), "bin", "litectx.js"), "ui"];
  if (o.path) args.push(o.path);
  args.push("--port", String(port));
  if (o.embeddings) args.push("--embeddings");
  const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out] });
  closeSync(out);
  let exited = false;
  child.on("exit", () => (exited = true));
  child.unref();
  const pid = child.pid;
  if (pid === undefined) throw new Error(`could not start the search page (see ${log})`);

  const t0 = Date.now();
  let url = null;
  while (Date.now() - t0 < START_TIMEOUT_MS) {
    if (exited) throw new Error(`the search page exited at start-up — see ${log}`);
    url ??= /litectx ui: (http:\/\/127\.0\.0\.1:\d+)/.exec(readFileSync(log, "utf8"))?.[1] ?? null;
    if (url && (await answers(url))) break;
    await sleep(100);
  }
  if (!url || !(await answers(url))) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    throw new Error(`the search page did not answer within ${START_TIMEOUT_MS / 1000}s — see ${log}`);
  }
  writeFileSync(pidFile(), JSON.stringify({ pid, port: Number(new URL(url).port), url, startedAt: new Date().toISOString() }, null, 2) + "\n");
  if (open) openBrowser(url);
  return { url, started: true, log, live: [] };
}

/**
 * Stop every live litectx search page (the pid file's and any foreground `litectx ui`). One line per page.
 * @returns {Promise<{ ok: boolean, lines: string[] }>} ok is false when a page could not be stopped
 */
export async function stopUi() {
  const pages = await liveUis();
  const rec = readRecord();
  /** @type {string[]} */
  const lines = [];
  let ok = true;
  for (const p of pages) {
    if (!isLitectxUi(p) || p.pid === null) {
      ok = false;
      lines.push(`not stopping ${p.url}: its process could not be confirmed as a litectx ui — stop it with Ctrl+C in its terminal`);
      continue;
    }
    try {
      process.kill(p.pid, "SIGTERM");
    } catch (e) {
      ok = false;
      lines.push(`could not signal ${p.url} (pid ${p.pid}): ${/** @type {Error} */ (e).message}`);
      continue;
    }
    const t0 = Date.now();
    const limit = stopTimeoutMs();
    while (alive(p.pid) && Date.now() - t0 < limit) await sleep(50);
    if (alive(p.pid)) {
      ok = false;
      lines.push(`${p.url} (pid ${p.pid}) did not exit within ${limit / 1000}s after SIGTERM — run: kill -9 ${p.pid}`);
    } else lines.push(`stopped ${p.url} (pid ${p.pid})`);
  }
  if (!pages.length) lines.push("no search page running");
  if (rec && !pages.some((p) => p.pid === rec.pid && alive(p.pid)) && existsSync(pidFile())) rmSync(pidFile(), { force: true });
  return { ok, lines };
}
