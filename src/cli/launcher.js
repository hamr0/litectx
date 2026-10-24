// `litectx start` / `litectx stop`: run the `litectx ui` server in the background and track it with a
// pid file (~/.litectx/ui.pid). Every function throws a plain Error on failure; the caller prints it.

import { spawn } from "node:child_process";
import net from "node:net";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logFile, pidFile, pkgDir, stateDir } from "./paths.js";

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
 * Walk base, base+1, … (bounded) to the first usable port. A port where a litectx ui already answers is
 * returned as `{ reuse: true }` when `reuse` is set; any other occupied port is skipped.
 * @param {boolean} reuse @returns {Promise<{ port: number, reuse: boolean }>}
 */
export async function pickPort(reuse) {
  const base = basePort();
  for (let p = base; p < base + PORT_TRIES; p++) {
    if (reuse && (await answers(`http://127.0.0.1:${p}`))) return { port: p, reuse: true };
    if (await isFree(p)) return { port: p, reuse: false };
  }
  throw new Error(`no free port in ${base}-${base + PORT_TRIES - 1}; pass --port <n>`);
}
const START_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;

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

/** Does `url` answer as a litectx ui? (its state endpoint has a version and a sources list) @param {string} url @returns {Promise<boolean>} */
export async function answers(url) {
  try {
    const r = await fetch(`${url}/api/sources`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = /** @type {any} */ (await r.json());
    return typeof j?.version === "string" && Array.isArray(j?.sources);
  } catch {
    return false;
  }
}

/**
 * Is `pid` a `litectx ui` process? On Linux the command line says so; elsewhere (no /proc) fall back to
 * "its recorded URL answers as litectx". Never signal a pid for which this is false.
 * @param {UiRecord} rec @returns {Promise<boolean>}
 */
async function isLitectxUi(rec) {
  let cmd;
  try {
    cmd = readFileSync(`/proc/${rec.pid}/cmdline`, "utf8").split("\0");
  } catch {
    return answers(rec.url);
  }
  const i = cmd.findIndex((a) => /(^|[\\/])litectx\.js$/.test(a));
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

/**
 * The background UI recorded by `litectx start`, if it is really running. A stale pid file (dead pid, or a pid
 * that is no longer a litectx ui) is removed.
 * @returns {Promise<UiRecord | null>}
 */
export async function runningUi() {
  const rec = readRecord();
  if (!rec) return null;
  if (alive(rec.pid) && (await isLitectxUi(rec))) return rec;
  rmSync(pidFile(), { force: true });
  return null;
}

/** Read-only variant for `status`: never removes the stale pid file. @returns {Promise<UiRecord | null>} */
export async function peekRunningUi() {
  const rec = readRecord();
  return rec && alive(rec.pid) && (await isLitectxUi(rec)) ? rec : null;
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
 * @param {{ path?: string, port?: number, embeddings?: boolean, open?: boolean }} o
 * @returns {Promise<{ url: string, started: boolean, log: string }>}
 */
export async function startUi(o) {
  const open = o.open !== false;
  const rec = await runningUi();
  if (rec && (await answers(rec.url))) {
    if (open) openBrowser(rec.url);
    return { url: rec.url, started: false, log: logFile() };
  }
  // a litectx ui already on the port (a foreground `litectx ui`, say) is reused; a port held by anything
  // else moves on to the next free one, unless the caller chose the port explicitly
  let port = o.port;
  if (port === undefined) {
    const pick = await pickPort(true);
    port = pick.port;
    if (pick.reuse) {
      const url = `http://127.0.0.1:${port}`;
      if (open) openBrowser(url);
      return { url, started: false, log: logFile() };
    }
  } else if (port !== 0) {
    const url = `http://127.0.0.1:${port}`;
    if (await answers(url)) {
      if (open) openBrowser(url);
      return { url, started: false, log: logFile() };
    }
    if (!(await isFree(port))) throw new Error(`port ${port} is in use by another program; pick another with --port`);
  }

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
  return { url, started: true, log };
}

/** @returns {Promise<{ stopped: boolean, message: string }>} */
export async function stopUi() {
  const rec = readRecord();
  if (!rec) {
    if (await answers(`http://127.0.0.1:${basePort()}`)) {
      return { stopped: false, message: `a litectx ui answers on port ${basePort()} but was not started by \`litectx start\` — stop it with Ctrl+C in its terminal` };
    }
    return { stopped: false, message: "nothing running" };
  }
  if (!alive(rec.pid) || !(await isLitectxUi(rec))) {
    rmSync(pidFile(), { force: true });
    return { stopped: false, message: "nothing running (removed a stale pid file)" };
  }
  process.kill(rec.pid, "SIGTERM");
  const t0 = Date.now();
  while (alive(rec.pid) && Date.now() - t0 < STOP_TIMEOUT_MS) await sleep(50);
  if (alive(rec.pid)) throw new Error(`pid ${rec.pid} did not exit within ${STOP_TIMEOUT_MS / 1000}s after SIGTERM; pid file kept`);
  if (existsSync(pidFile())) rmSync(pidFile(), { force: true });
  return { stopped: true, message: `stopped the search page (pid ${rec.pid})` };
}
