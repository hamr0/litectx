// `litectx update` (menu 7): the one command that goes online, and only when pressed. Asks the npm registry
// for the newest version and, on a y, installs it into the global prefix the RUNNING litectx lives in.

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { pkgDir, version } from "./paths.js";

const REGISTRY_URL = "https://registry.npmjs.org/litectx/latest";
const REGISTRY_TIMEOUT_MS = 5000;
const NPM_DEADLINE_MS = 300_000;

/** @param {string} v @returns {number[] | null} X.Y.Z as numbers, nothing else counts */
const semverOf = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
/** @param {number[]} a @param {number[]} b @returns {boolean} a is newer than b */
const isNewer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
};

/**
 * The npm prefix this litectx was installed into, or null when it is not a global install (a checkout, npx, a
 * local node_modules). Plain `npm install -g` can land in a different global than the one that runs, so the
 * install is pinned to this one. `<prefix>/lib/node_modules/litectx` only; the Windows shape
 * (`<prefix>\node_modules\litectx`) is indistinguishable from a local install, so it counts as not global.
 * @param {string} dir the package dir @returns {string | null}
 */
export function globalPrefix(dir) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return null;
  }
  const lib = dirname(real);
  const nm = dirname(lib);
  if (basename(real) !== "litectx" || basename(lib) !== "node_modules" || basename(nm) !== "lib") return null;
  const prefix = dirname(nm);
  return prefix === nm ? null : prefix;
}

/**
 * Run npm: no shell, its output on the terminal, killed at the deadline.
 * @param {string} npm @param {string[]} args @param {number} deadlineMs @returns {Promise<number>} 0 only when npm exited 0
 */
function runNpm(npm, args, deadlineMs) {
  return new Promise((ok) => {
    let child;
    try {
      child = spawn(npm, args, { shell: false, stdio: "inherit" });
    } catch {
      ok(1);
      return;
    }
    let done = false;
    const end = (/** @type {number} */ code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ok(code);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      end(1);
    }, deadlineMs);
    child.once("error", () => end(1));
    child.once("close", (code) => end(code === 0 ? 0 : 1));
  });
}

/**
 * @typedef {object} UpdateOpts
 * @property {((q: string) => Promise<string>) | null} [ask] terminal prompt; null → no terminal, never installs
 * @property {boolean} [fromMenu] changes only the "then pick 3 restart" wording
 * @property {string} [registryUrl] test seam (default LITECTX_REGISTRY_URL, else the npm registry)
 * @property {string} [npm] test seam (default LITECTX_NPM, else `npm`)
 * @property {string} [dir] test seam: the package dir (default this one)
 * @property {number} [timeoutMs] test seam: registry deadline
 * @property {number} [npmDeadlineMs] test seam: install deadline
 * @property {(s: string) => void} [out]
 * @property {(s: string) => void} [err]
 */

/**
 * @param {UpdateOpts} [o]
 * @returns {Promise<number>} exit code: 0 newest / updated / not updated; 1 could not reach npm, install failed
 */
export async function updateCmd(o = {}) {
  const out = o.out ?? ((/** @type {string} */ s) => console.log(s));
  const err = o.err ?? ((/** @type {string} */ s) => console.error(s));
  const mine = version();
  /** @type {string | null} */
  let latest = null;
  try {
    const res = await fetch(o.registryUrl ?? process.env.LITECTX_REGISTRY_URL ?? REGISTRY_URL, { signal: AbortSignal.timeout(o.timeoutMs ?? REGISTRY_TIMEOUT_MS) });
    if (res.ok) {
      const v = /** @type {any} */ (await res.json())?.version;
      if (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)) latest = v;
    }
  } catch {
    // offline, timeout or bad JSON: the same answer
  }
  if (latest === null) {
    err("Could not reach npm to check. Try again later.");
    return 1;
  }
  if (!isNewer(/** @type {number[]} */ (semverOf(latest)), semverOf(mine) ?? [0, 0, 0])) {
    out(`You have the newest litectx (${mine}).`);
    return 0;
  }
  out(`litectx ${latest} is out. You have ${mine}.`);
  const prefix = globalPrefix(o.dir ?? pkgDir());
  if (prefix === null) {
    out("Not a global install, so update it the way you installed it.");
    return 0;
  }
  const args = ["install", "-g", "--prefix", prefix, "litectx@latest"];
  const cmd = `npm ${args.join(" ")}`;
  const later = `Not updated. To update later: ${cmd}`;
  if (!o.ask) {
    out(later);
    return 0;
  }
  let answer = (await o.ask("Update now? (y/n) ")).trim().toLowerCase();
  if (answer === "") answer = (await o.ask("Update now? (y/n) ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    out(later);
    return 0;
  }
  if ((await runNpm(o.npm ?? process.env.LITECTX_NPM ?? "npm", args, o.npmDeadlineMs ?? NPM_DEADLINE_MS)) !== 0) {
    err(`The update did not finish. Run it yourself: ${cmd}`);
    return 1;
  }
  out(o.fromMenu ? `Updated to ${latest}. Then pick 3 restart.` : `Updated to ${latest}. Then run litectx restart.`);
  return 0;
}
