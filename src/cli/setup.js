// `litectx setup [--remove] [--dev]`: wire litectx into Claude Code — the MCP server (user scope, via the `claude`
// CLI) and two hooks merged into ~/.claude/settings.json. Idempotent; entries are recognised by their script
// filename so a different install path is updated in place, never duplicated.

import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { red } from "./style.js";
import { claudeJson, claudeSettings, pkgDir } from "./paths.js";

/** @typedef {{ type?: string, command?: string }} Hook */
/** @typedef {{ matcher?: string, hooks?: Hook[] }} Group */

const q = (/** @type {string} */ p) => (/\s/.test(p) ? `"${p}"` : p);

/** The two hooks this package ships. `file` is how an existing entry is recognised. */
function hookSpecs(pkg = pkgDir()) {
  const dir = join(pkg, "integrations", "claude");
  return [
    { event: "SessionStart", matcher: "", file: "warm-index.sh", script: join(dir, "warm-index.sh"), command: q(join(dir, "warm-index.sh")) },
    { event: "PreToolUse", matcher: "Edit", file: "pre-edit-impact.mjs", script: join(dir, "pre-edit-impact.mjs"), command: `node ${q(join(dir, "pre-edit-impact.mjs"))}` },
  ];
}

/** @param {string} file @returns {any} parsed JSON; null when absent; throws on malformed */
function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON — fix it first; nothing was changed`);
  }
}

/**
 * Is this hook litectx's? Its command must run `<pkg>/integrations/claude/<file>` where `<pkg>` is a litectx
 * package: its package.json names "litectx", or — a stale path whose install is gone — the dir is called
 * `litectx`. A user's own `/my/other/warm-index.sh` is never matched.
 * @param {unknown} h @param {string} file
 */
function isOurs(h, file) {
  const command = /** @type {Hook} */ (h)?.command;
  if (typeof command !== "string") return false;
  const script = command.trim().replace(/^node\s+/, "").replace(/^(["'])(.*)\1$/, "$2");
  const tail = `/integrations/claude/${file}`;
  if (!script.endsWith(tail)) return false;
  const pkg = script.slice(0, -tail.length);
  try {
    return JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).name === "litectx";
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT" && basename(pkg) === "litectx";
  }
}

/** @returns {string | null} absolute path of `claude` on PATH */
function findClaude() {
  for (const d of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const p = join(d, "claude");
    try {
      if (statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {
      // not here
    }
  }
  return null;
}

/** Registered user-scope MCP entry, from ~/.claude.json. @returns {{ args: string[] } | null} */
function mcpEntry() {
  try {
    const e = readJson(claudeJson())?.mcpServers?.litectx;
    return e && typeof e === "object" ? { args: Array.isArray(e.args) ? e.args.map(String) : [] } : null;
  } catch {
    return null;
  }
}

/** What `litectx status` / the menu banner report about Claude. @returns {{ mcp: boolean, warm: boolean, preEdit: boolean }} */
export function claudeState() {
  /** @type {any} */
  let s = null;
  try {
    s = readJson(claudeSettings());
  } catch {
    // malformed settings: report nothing wired
  }
  const has = (/** @type {string} */ event, /** @type {string} */ file) => (s?.hooks?.[event] ?? []).some((/** @type {Group} */ g) => (g?.hooks ?? []).some((h) => isOurs(h, file)));
  return { mcp: mcpEntry() !== null, warm: has("SessionStart", "warm-index.sh"), preEdit: has("PreToolUse", "pre-edit-impact.mjs") };
}

/** @param {any} s @param {string} pkg @returns {boolean} true if it changed anything */
function addHooks(s, pkg) {
  let changed = false;
  s.hooks ??= {};
  const bad = (/** @type {string} */ what) => new Error(`${claudeSettings()} has ${what} that is not the shape Claude Code expects — fix it first; nothing was changed`);
  if (typeof s.hooks !== "object" || Array.isArray(s.hooks)) throw bad('a "hooks" entry');
  for (const sp of hookSpecs(pkg)) {
    if (s.hooks[sp.event] !== undefined && s.hooks[sp.event] !== null && !Array.isArray(s.hooks[sp.event])) throw bad(`a "hooks.${sp.event}" entry`);
    const groups = (s.hooks[sp.event] ??= []);
    let seen = false;
    for (let gi = 0; gi < groups.length; gi++) {
      const hs = groups[gi]?.hooks;
      if (!Array.isArray(hs)) continue;
      for (let i = 0; i < hs.length; i++) {
        if (!isOurs(hs[i], sp.file)) continue;
        if (seen) {
          hs.splice(i--, 1); // a duplicate litectx entry
          changed = true;
        } else {
          seen = true;
          if (hs[i].command !== sp.command) {
            hs[i].command = sp.command; // same entry, new install path
            changed = true;
          }
        }
      }
    }
    if (!seen) {
      groups.push({ matcher: sp.matcher, hooks: [{ type: "command", command: sp.command }] });
      changed = true;
    }
  }
  return changed;
}

/** Remove only litectx's entries, and only the containers that removal emptied. @param {any} s @returns {boolean} */
function removeHooks(s) {
  let changed = false;
  for (const sp of hookSpecs()) {
    const groups = s.hooks?.[sp.event];
    if (!Array.isArray(groups)) continue;
    for (let gi = groups.length - 1; gi >= 0; gi--) {
      const hs = groups[gi]?.hooks;
      if (!Array.isArray(hs)) continue;
      const kept = hs.filter((/** @type {unknown} */ h) => !isOurs(h, sp.file));
      if (kept.length === hs.length) continue;
      changed = true;
      if (kept.length) groups[gi].hooks = kept;
      else groups.splice(gi, 1);
    }
    if (!groups.length) delete s.hooks[sp.event];
  }
  if (changed && s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  return changed;
}

/** @param {any} s */
function saveSettings(s) {
  const file = claudeSettings();
  mkdirSync(dirname(file), { recursive: true });
  let backup = null;
  if (existsSync(file)) {
    backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
  }
  writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  return backup;
}

/** @param {string[]} args @returns {string} */
const claudeCmd = (args) => `claude ${args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;

/**
 * @param {string[]} args
 * @param {string | null} claude
 * @param {string[]} out
 * @returns {boolean} false when the command failed (reported in `out`)
 */
function runClaude(args, claude, out) {
  if (!claude) {
    out.push(`  \`claude\` is not on PATH — run this yourself:\n    ${claudeCmd(args)}`);
    return true;
  }
  try {
    execFileSync(claude, args, { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch (e) {
    const err = /** @type {{ stderr?: Buffer, message: string }} */ (e);
    out.push(`  \`${claudeCmd(args)}\` failed: ${(err.stderr?.toString() || err.message).trim()}`);
    return false;
  }
}

/** @param {string} dir @returns {boolean} true when `dir` is a git checkout (hooks/MCP would follow its working tree) */
const isCheckout = (dir) => existsSync(join(dir, ".git"));

/**
 * The installed litectx: `litectx` on PATH (entries inside this checkout skipped), realpath'd to its package dir.
 * @returns {string | null} null when none, or when the one found is itself a checkout (e.g. an `npm link`)
 */
export function findInstalled() {
  const here = pkgDir();
  for (const d of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    try {
      const real = realpathSync(join(d, "litectx"));
      if (real === here || real.startsWith(here + sep)) continue;
      const dir = dirname(dirname(real));
      if (!existsSync(join(dir, "package.json")) || !existsSync(join(dir, "bin", "litectx-mcp.js"))) continue;
      return isCheckout(dir) ? null : dir;
    } catch {
      // not here
    }
  }
  return null;
}

const refusal = (/** @type {string} */ why) => ({
  lines: [
    red(`refusing: litectx is running from a source checkout (${pkgDir()}); Claude's hooks and MCP server would follow your working tree.`),
    why,
    "Nothing was changed.",
  ],
  ok: false,
});

/**
 * `setup` with the checkout guard: from a git checkout it redirects to the installed litectx (after `ask`
 * confirms, when given) or refuses. `--dev` wires the checkout itself; `--remove` works from anywhere.
 * @param {{ remove?: boolean, dev?: boolean }} o
 * @param {((question: string) => Promise<string>) | null} [ask]  terminal prompt; null → never prompt
 * @returns {Promise<{ lines: string[], ok: boolean }>}
 */
export async function runSetup(o, ask = null) {
  if (o.remove || o.dev || !isCheckout(pkgDir())) return setup(o);
  const inst = findInstalled();
  if (!inst) return refusal("no installed litectx found — run `npm i -g litectx` (or pass --dev to wire this checkout)");
  if (!ask) return refusal(`run the installed \`litectx setup\` (${inst}) instead, or pass --dev to wire this checkout on purpose`);
  const a = (await ask(`  Set up Claude with the installed litectx at ${inst}? [Y/n] `)).trim().toLowerCase();
  if (a !== "" && a !== "y" && a !== "yes") return { lines: ["nothing was changed"], ok: true };
  return setup({ ...o, dir: inst });
}

/**
 * @param {{ remove?: boolean, dev?: boolean, dir?: string }} [o]  `dir`: package dir to wire (default: this one)
 * @returns {{ lines: string[], ok: boolean }}  human-readable report; ok=false if the `claude` CLI call failed
 */
export function setup(o = {}) {
  /** @type {string[]} */
  const out = [];
  let ok = true;
  const claude = findClaude();
  const pkg = o.dir ?? pkgDir();
  const bin = join(pkg, "bin", "litectx-mcp.js");
  const mcpArgs = ["mcp", "add", "--scope", "user", "litectx", "--", "node", bin, "--embeddings"];

  // settings first: a malformed file aborts before anything (the claude CLI included) is touched
  const settings = readJson(claudeSettings()) ?? {};
  if (typeof settings !== "object" || Array.isArray(settings)) throw new Error(`${claudeSettings()} is not a JSON object — nothing was changed`);
  const changed = o.remove ? removeHooks(settings) : addHooks(settings, pkg);
  if (!o.remove) {
    for (const sp of hookSpecs(pkg)) {
      try {
        accessSync(sp.script, constants.X_OK);
      } catch {
        try {
          chmodSync(sp.script, 0o755);
        } catch {
          out.push(`  could not chmod +x ${sp.script}`);
        }
      }
    }
  }
  if (changed) {
    const backup = saveSettings(settings);
    out.push(`hooks: ${o.remove ? "removed litectx's entries from" : "updated"} ${claudeSettings()}${backup ? ` (backup: ${backup})` : ""}`);
  } else out.push(`hooks: ${claudeSettings()} ${o.remove ? "has no litectx entries" : "already up to date"}`);

  const cur = mcpEntry();
  if (o.remove) {
    if (cur) {
      out.push("MCP: removing the litectx server");
      ok = runClaude(["mcp", "remove", "--scope", "user", "litectx"], claude, out) && ok;
    } else out.push("MCP: no litectx server registered");
  } else if (cur?.args.includes(bin)) {
    out.push("MCP: already registered");
  } else {
    if (cur) {
      out.push("MCP: registered with a different path — re-registering");
      ok = runClaude(["mcp", "remove", "--scope", "user", "litectx"], claude, out) && ok;
    } else out.push("MCP: registering the litectx server");
    ok = runClaude(mcpArgs, claude, out) && ok;
  }
  return { lines: out, ok };
}
