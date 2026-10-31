// `litectx start|stop|setup|status` and bare `litectx` — real CLI processes against a temp HOME. Nothing
// here touches the real ~/.claude, ~/.claude.json or ~/.litectx, and nothing uses port 4747 (random free
// ports; the `claude` binary and the browser opener are fakes found through PATH).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, symlinkSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { indexStamp } from "../src/indexer.js";

const PKG = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const BIN = join(PKG, "bin", "litectx.js");
const tmp = mkdtempSync(join(tmpdir(), "litectx-cli-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** a fresh sandbox: HOME, a fake-binaries dir (first on PATH), and an env for the CLI */
function sandbox() {
  const dir = join(tmp, `s${++n}`);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const editor = join(dir, "editor.sh");
  writeFileSync(editor, "#!/bin/sh\nexit 0\n");
  chmodSync(editor, 0o755);
  mkdirSync(join(dir, "cfg"));
  writeFileSync(join(dir, "cfg", "ui.json"), JSON.stringify({ active: null, sources: [], editor }));
  // the preferred port is moved off 4747 so a UI the owner has running there can never be seen or touched
  const env = { ...process.env, LITECTX_DEFAULT_PORT: String(20000 + Math.floor(Math.random() * 30000)), HOME: home, PATH: `${bin}:${(process.env.PATH ?? "").split(":").filter((d) => d && !existsSync(join(d, "litectx"))).join(":")}`, LITECTX_UI_CONFIG: join(dir, "cfg", "ui.json") };
  return { dir, home, bin, env, claudeLog: join(dir, "claude.log"), openLog: join(dir, "open.log") };
}
/** @param {ReturnType<typeof sandbox>} sb fake `claude`: logs its args; `mcp add/remove` edit $HOME/.claude.json like the real one */
function fakeClaude(sb) {
  const f = join(sb.bin, "claude");
  writeFileSync(
    f,
    `#!/usr/bin/env node
const fs = require("fs");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(sb.claudeLog)}, JSON.stringify(a) + "\\n");
const file = process.env.HOME + "/.claude.json";
let j = {}; try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
if (a[0] === "mcp" && a[1] === "add") { const i = a.indexOf("--"); j.mcpServers = { ...j.mcpServers, litectx: { type: "stdio", command: a[i + 1], args: a.slice(i + 2) } }; }
if (a[0] === "mcp" && a[1] === "remove") { delete j.mcpServers?.litectx; }
fs.writeFileSync(file, JSON.stringify(j));
`
  );
  chmodSync(f, 0o755);
}
/** @param {ReturnType<typeof sandbox>} sb fake `xdg-open`: logs its args */
function fakeOpener(sb) {
  const f = join(sb.bin, "xdg-open");
  writeFileSync(f, `#!/bin/sh\necho "$@" >> ${sb.openLog}\n`);
  chmodSync(f, 0o755);
}
/** @param {ReturnType<typeof sandbox>} sb @param {string[]} args @param {object} [o] */
function cli(sb, args, o = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: sb.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o });
  return { code: r.status, out: String(r.stdout), err: String(r.stderr) };
}
const calls = (/** @type {string} */ log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const settingsFile = (/** @type {ReturnType<typeof sandbox>} */ sb) => join(sb.home, ".claude", "settings.json");
const readSettings = (/** @type {ReturnType<typeof sandbox>} */ sb) => JSON.parse(readFileSync(settingsFile(sb), "utf8"));
const WARM = "warm-index.sh";
const PRE = "pre-edit-impact.mjs";
/** every litectx hook command in a settings object */
const ours = (/** @type {any} */ s) =>
  Object.values(s.hooks ?? {}).flatMap((/** @type {any} */ gs) => gs.flatMap((/** @type {any} */ g) => g.hooks.map((/** @type {any} */ h) => h.command))).filter((/** @type {string} */ c) => c.includes(WARM) || c.includes(PRE));

const UNRELATED = {
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/bin/other-guard" }] }],
    Stop: [{ hooks: [{ type: "command", command: "/usr/bin/on-stop" }] }],
  },
};

// ---- setup -----------------------------------------------------------------------------------------

test("setup: fresh HOME gets both hooks and the exact `claude mcp add`; a second run changes nothing", () => {
  const sb = sandbox();
  fakeClaude(sb);
  const r = cli(sb, ["setup", "--dev"]);
  assert.equal(r.code, 0, r.err);
  const s = readSettings(sb);
  assert.deepEqual(s.hooks.SessionStart, [{ matcher: "", hooks: [{ type: "command", command: join(PKG, "integrations/claude", WARM) }] }]);
  assert.deepEqual(s.hooks.PreToolUse, [{ matcher: "Edit", hooks: [{ type: "command", command: `node ${join(PKG, "integrations/claude", PRE)}` }] }]);
  assert.deepEqual(calls(sb.claudeLog), [["mcp", "add", "--scope", "user", "litectx", "--", "node", join(PKG, "bin/litectx-mcp.js"), "--embeddings"]]);
  assert.equal(readdirSync(join(sb.home, ".claude")).filter((f) => f.includes(".bak-")).length, 0, "no settings file existed → nothing to back up");

  const before = readFileSync(settingsFile(sb), "utf8");
  const r2 = cli(sb, ["setup", "--dev"]);
  assert.equal(r2.code, 0, r2.err);
  assert.equal(readFileSync(settingsFile(sb), "utf8"), before, "second run: settings byte-identical");
  assert.equal(calls(sb.claudeLog).length, 1, "second run: no second `mcp add`");
  assert.match(r2.out, /already registered/);
});

test("setup: unrelated keys/hooks survive; a litectx hook with an OLD path is updated, not duplicated; a backup is written", () => {
  const sb = sandbox();
  fakeClaude(sb);
  mkdirSync(join(sb.home, ".claude"));
  const old = structuredClone(UNRELATED);
  old.hooks.PreToolUse.push({ matcher: "Edit", hooks: [{ type: "command", command: "node /old/place/litectx/integrations/claude/pre-edit-impact.mjs" }, { type: "command", command: "/usr/bin/second-edit-hook" }] });
  old.hooks.SessionStart = [{ matcher: "", hooks: [{ type: "command", command: "/old/place/litectx/integrations/claude/warm-index.sh" }] }];
  writeFileSync(settingsFile(sb), JSON.stringify(old, null, 2));
  const r = cli(sb, ["setup", "--dev"]);
  assert.equal(r.code, 0, r.err);
  const s = readSettings(sb);
  assert.equal(s.model, "opus");
  assert.deepEqual(s.permissions, UNRELATED.permissions);
  assert.deepEqual(s.hooks.Stop, UNRELATED.hooks.Stop);
  assert.deepEqual(s.hooks.PreToolUse[0], UNRELATED.hooks.PreToolUse[0]);
  assert.deepEqual(s.hooks.PreToolUse[1].hooks.map((/** @type {any} */ h) => h.command), [`node ${join(PKG, "integrations/claude", PRE)}`, "/usr/bin/second-edit-hook"], "updated in place, sibling hook kept");
  assert.deepEqual(ours(s).sort(), [join(PKG, "integrations/claude", WARM), `node ${join(PKG, "integrations/claude", PRE)}`].sort(), "exactly one entry of each");
  const baks = readdirSync(join(sb.home, ".claude")).filter((f) => f.startsWith("settings.json.bak-"));
  assert.equal(baks.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(sb.home, ".claude", baks[0]), "utf8")), old, "the backup is the pre-change file");
});

test("setup/--remove: a user's own warm-index.sh / non-litectx integrations path is never touched; stale litectx paths still update", () => {
  const sb = sandbox();
  fakeClaude(sb);
  mkdirSync(join(sb.home, ".claude"));
  // a real non-litectx package that happens to ship integrations/claude/warm-index.sh
  const other = join(sb.dir, "otherpkg");
  mkdirSync(other);
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "something-else" }));
  const mine = [
    { matcher: "", hooks: [{ type: "command", command: "/my/other/warm-index.sh" }] },
    { matcher: "", hooks: [{ type: "command", command: "/x/integrations/claude/warm-index.sh" }] },
    { matcher: "", hooks: [{ type: "command", command: join(other, "integrations/claude", WARM) }] },
  ];
  const pre = [{ matcher: "Edit", hooks: [{ type: "command", command: "node /my/other/pre-edit-impact.mjs" }] }];
  const stale = { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "/home/u/.local/lib/node_modules/litectx/integrations/claude/warm-index.sh" }] }] };
  const orig = { hooks: { SessionStart: mine, PreToolUse: pre } };
  writeFileSync(settingsFile(sb), JSON.stringify(orig, null, 2));
  assert.equal(cli(sb, ["setup", "--dev"]).code, 0);
  const s = readSettings(sb);
  assert.deepEqual(s.hooks.SessionStart.slice(0, 3), mine, "unrelated hooks kept byte-for-byte");
  assert.deepEqual(s.hooks.PreToolUse[0], pre[0]);
  assert.equal(ours(s).filter((c) => c.startsWith(PKG)).length + ours(s).filter((c) => c.startsWith("node " + PKG)).length, 2, "litectx's own two hooks were ADDED, nothing rewritten");
  assert.equal(cli(sb, ["setup", "--remove"]).code, 0);
  const after = readSettings(sb);
  assert.deepEqual(after.hooks.SessionStart, mine, "--remove leaves them");
  assert.deepEqual(after.hooks.PreToolUse, pre);

  // stale litectx-shaped path (install gone) is updated in place
  const sb2 = sandbox();
  fakeClaude(sb2);
  mkdirSync(join(sb2.home, ".claude"));
  writeFileSync(settingsFile(sb2), JSON.stringify({ hooks: stale }));
  assert.equal(cli(sb2, ["setup", "--dev"]).code, 0);
  assert.deepEqual(readSettings(sb2).hooks.SessionStart, [{ matcher: "", hooks: [{ type: "command", command: join(PKG, "integrations/claude", WARM) }] }]);
});

test("setup: malformed settings.json aborts, leaves the file alone and does not call claude", () => {
  const sb = sandbox();
  fakeClaude(sb);
  mkdirSync(join(sb.home, ".claude"));
  writeFileSync(settingsFile(sb), '{ "hooks": { oops');
  const r = cli(sb, ["setup", "--dev"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not valid JSON/);
  assert.equal(readFileSync(settingsFile(sb), "utf8"), '{ "hooks": { oops');
  assert.equal(calls(sb.claudeLog).length, 0);
  assert.deepEqual(readdirSync(join(sb.home, ".claude")), ["settings.json"], "no backup, no stray files");
});

test("setup: a wrong-typed `hooks` (or event) in settings.json gives the clean 'nothing was changed' error, no TypeError", () => {
  for (const bad of ['{ "hooks": "x" }', '{ "hooks": { "SessionStart": {} } }', '{ "hooks": [] }']) {
    const sb = sandbox();
    fakeClaude(sb);
    mkdirSync(join(sb.home, ".claude"));
    writeFileSync(settingsFile(sb), bad);
    const r = cli(sb, ["setup", "--dev"]);
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /nothing was changed/, bad);
    assert.doesNotMatch(r.err, /TypeError|Cannot create property|is not a function/, bad);
    assert.equal(readFileSync(settingsFile(sb), "utf8"), bad, "file untouched");
    assert.equal(calls(sb.claudeLog).length, 0, "claude not called");
    assert.deepEqual(readdirSync(join(sb.home, ".claude")), ["settings.json"]);
  }
});

test("setup: MCP registered at a different path is removed and re-added; claude missing → prints the command", () => {
  const sb = sandbox();
  fakeClaude(sb);
  writeFileSync(join(sb.home, ".claude.json"), JSON.stringify({ mcpServers: { litectx: { command: "node", args: ["/old/bin/litectx-mcp.js"] }, other: { command: "x" } } }));
  const r = cli(sb, ["setup", "--dev"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(calls(sb.claudeLog).map((c) => c.slice(0, 2).join(" ")), ["mcp remove", "mcp add"]);
  const j = JSON.parse(readFileSync(join(sb.home, ".claude.json"), "utf8"));
  assert.deepEqual(j.mcpServers.litectx.args, [join(PKG, "bin/litectx-mcp.js"), "--embeddings"]);

  // no claude on PATH at all: hooks are still written, the command is printed, exit 0
  const sb2 = sandbox();
  const r2 = cli(sb2, ["setup", "--dev"], { env: { ...sb2.env, PATH: dirOf(process.execPath) } });
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, /`claude` is not on PATH — run this yourself:\s+claude mcp add --scope user litectx -- node \S+litectx-mcp\.js --embeddings/);
  assert.equal(ours(readSettings(sb2)).length, 2);
});
/** an "installed" litectx (no .git) under sb.dir, linked from a PATH dir; returns its package dir and the env */
function installed(/** @type {ReturnType<typeof sandbox>} */ sb, git = false) {
  const copy = join(sb.dir, "installed");
  mkdirSync(copy);
  for (const d of ["bin", "src", "integrations"]) cpSync(join(PKG, d), join(copy, d), { recursive: true });
  cpSync(join(PKG, "package.json"), join(copy, "package.json"));
  symlinkSync(join(PKG, "node_modules"), join(copy, "node_modules"));
  if (git) mkdirSync(join(copy, ".git"));
  const pathBin = join(sb.dir, "pathbin");
  mkdirSync(pathBin);
  symlinkSync(join(copy, "bin", "litectx.js"), join(pathBin, "litectx"));
  return { copy, env: { ...sb.env, PATH: `${pathBin}:${sb.env.PATH}` } };
}
const hasPython = spawnSync("python3", ["-c", "1"]).status === 0;
/** run `litectx setup` from the checkout on a pty, typing `answer` at the first prompt */
function setupOnPty(/** @type {ReturnType<typeof sandbox>} */ sb, /** @type {NodeJS.ProcessEnv} */ env, /** @type {string} */ answer) {
  const py = `import pty,os,sys,select
pid,fd=pty.fork()
if pid==0:
    os.execve(sys.executable if False else ${JSON.stringify(process.execPath)},[${JSON.stringify(process.execPath)},${JSON.stringify(BIN)},"setup"],os.environ)
out=b""
sent=False
while True:
    r,_,_=select.select([fd],[],[],20)
    if not r: break
    try: d=os.read(fd,4096)
    except OSError: break
    if not d: break
    out+=d
    if not sent and b"[Y/n]" in out:
        os.write(fd,${JSON.stringify(answer)}.encode()+b"\\r"); sent=True
os.waitpid(pid,0)
sys.stdout.write(out.decode("utf8","replace"))
`;
  const r = spawnSync("python3", ["-I", "-c", py], { env, encoding: "utf8" });
  return r.stdout + r.stderr;
}

test("setup from a checkout without an installed litectx refuses and writes nothing; --dev wires it; --remove is allowed", () => {
  const sb = sandbox();
  fakeClaude(sb);
  assert.ok(existsSync(join(PKG, ".git")), "the suite runs from a checkout");
  const r = cli(sb, ["setup"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /source checkout/);
  assert.match(r.out, /npm i -g litectx/);
  assert.match(r.out, /--dev/);
  assert.equal(existsSync(join(sb.home, ".claude")), false, "no settings written");
  assert.equal(calls(sb.claudeLog).length, 0, "claude never called");
  assert.equal(cli(sb, ["setup", "--remove"]).code, 0, "--remove works from anywhere");
  assert.equal(cli(sb, ["setup", "--dev"]).code, 0);
  assert.ok(readFileSync(settingsFile(sb), "utf8").includes(join(PKG, "integrations")), "--dev wires the checkout");
});

test("setup from a checkout, non-TTY, with an installed litectx on PATH: refuses (no prompt), names the install", () => {
  const sb = sandbox();
  fakeClaude(sb);
  const inst = installed(sb);
  const r = cli(sb, ["setup"], { env: inst.env });
  assert.equal(r.code, 1);
  assert.ok(r.out.includes(inst.copy), r.out);
  assert.equal(existsSync(join(sb.home, ".claude")), false);
  assert.equal(calls(sb.claudeLog).length, 0);
});

test("setup from a checkout: an installed litectx that is itself a checkout (npm link) is refused", () => {
  const sb = sandbox();
  fakeClaude(sb);
  const inst = installed(sb, true);
  const r = cli(sb, ["setup"], { env: inst.env });
  assert.equal(r.code, 1);
  assert.match(r.out, /no installed litectx found/);
  assert.equal(existsSync(join(sb.home, ".claude")), false);
});

test("setup on a terminal: y (and Enter) wire the INSTALLED paths, n writes nothing", { skip: !hasPython }, () => {
  for (const answer of ["y", ""]) {
    const sb = sandbox();
    fakeClaude(sb);
    const inst = installed(sb);
    const out = setupOnPty(sb, inst.env, answer);
    assert.match(out, /Set up Claude with the installed litectx at /);
    const settings = readFileSync(settingsFile(sb), "utf8");
    assert.ok(settings.includes(join(inst.copy, "integrations")), "hooks point at the installed copy");
    assert.ok(!settings.includes(join(PKG, "integrations")), "never the checkout");
    const add = calls(sb.claudeLog).find((c) => c[1] === "add");
    assert.ok(add?.includes(join(inst.copy, "bin", "litectx-mcp.js")), "MCP points at the installed copy");
  }
  const sb = sandbox();
  fakeClaude(sb);
  setupOnPty(sb, installed(sb).env, "n");
  assert.equal(existsSync(join(sb.home, ".claude")), false);
  assert.equal(calls(sb.claudeLog).length, 0);
});

test("setup run from an installed package (no .git) needs no flag", () => {
  const sb = sandbox();
  fakeClaude(sb);
  const inst = installed(sb);
  const r = spawnSync(process.execPath, [join(inst.copy, "bin", "litectx.js"), "setup"], { env: sb.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(readFileSync(settingsFile(sb), "utf8").includes(join(inst.copy, "integrations")));
});

const dirOf = (/** @type {string} */ p) => p.slice(0, p.lastIndexOf("/"));

test("setup --remove: only litectx's entries go, and only the containers that leaves empty", () => {
  const sb = sandbox();
  fakeClaude(sb);
  mkdirSync(join(sb.home, ".claude"));
  writeFileSync(settingsFile(sb), JSON.stringify(UNRELATED));
  assert.equal(cli(sb, ["setup", "--dev"]).code, 0);
  assert.equal(ours(readSettings(sb)).length, 2);
  const r = cli(sb, ["setup", "--remove"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(readSettings(sb), UNRELATED);
  assert.deepEqual(calls(sb.claudeLog).at(-1), ["mcp", "remove", "--scope", "user", "litectx"]);
  // from a settings file that held ONLY litectx: no empty `hooks` husk is left behind
  const sb2 = sandbox();
  fakeClaude(sb2);
  assert.equal(cli(sb2, ["setup", "--dev"]).code, 0);
  assert.equal(cli(sb2, ["setup", "--remove"]).code, 0);
  assert.deepEqual(readSettings(sb2), {});
});

// ---- start / stop ----------------------------------------------------------------------------------

function freePort() {
  return new Promise((ok) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = /** @type {net.AddressInfo} */ (s.address()).port;
      s.close(() => ok(p));
    });
  });
}
function tinyRepo(dir) {
  mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.dev");
  g("config", "user.name", "T");
  g("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.js"), "export function hello() { return 1; }\n");
  g("add", "-A");
  g("commit", "-qm", "init");
}
const alive = (/** @type {number} */ pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (/** @type {() => boolean} */ f, ms = 4000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50));
  return f();
};

test("start/stop: background server, pid file, no second server, browser opener, clean stop", async () => {
  const sb = sandbox();
  fakeOpener(sb);
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const port = await freePort();
  const pidFile = join(sb.home, ".litectx", "ui.pid");
  try {
    const r = cli(sb, ["start", repo, "--port", String(port)]);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, new RegExp(`started: http://127\\.0\\.0\\.1:${port}`));
    const rec = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.equal(rec.port, port);
    assert.equal(rec.url, `http://127.0.0.1:${port}`);
    assert.ok(alive(rec.pid));
    assert.ok(rec.startedAt);
    const st = await (await fetch(`${rec.url}/api/sources`)).json();
    assert.equal(typeof st.version, "string");
    assert.ok(existsSync(join(sb.home, ".litectx", "ui.out")));
    assert.ok(await until(() => existsSync(sb.openLog)), "browser opener ran");
    assert.equal(readFileSync(sb.openLog, "utf8").trim(), rec.url);

    const status = cli(sb, ["status", repo]);
    assert.match(status.out, new RegExp(`UI: running \\(${rec.url.replace(/\./g, "\\.")}\\)`));

    const r2 = cli(sb, ["start", repo, "--port", String(port), "--no-open"]);
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.out, new RegExp(`already live: http://127\\.0\\.0\\.1:${port} — source \\S+ \\(${repo}\\), pid ${rec.pid}\\n`));
    assert.doesNotMatch(r2.out, /run litectx stop first/, "same path: no hint");
    assert.equal(JSON.parse(readFileSync(pidFile, "utf8")).pid, rec.pid, "same server, no second spawn");

    const s = cli(sb, ["stop"]);
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, new RegExp(`stopped http://127\\.0\\.0\\.1:${port} \\(pid ${rec.pid}\\)`));
    assert.ok(await until(() => !alive(rec.pid)), "server process is gone");
    assert.equal(existsSync(pidFile), false);
    const none = cli(sb, ["stop"]);
    assert.equal(none.code, 0);
    assert.equal(none.out.trim(), "no search page running");
  } finally {
    if (existsSync(pidFile)) {
      try {
        process.kill(JSON.parse(readFileSync(pidFile, "utf8")).pid, "SIGTERM");
      } catch {}
    }
  }
});

test("stop: a stale pid file naming a live NON-litectx process does not kill it", async () => {
  const sb = sandbox();
  const victim = spawn("sleep", ["30"], { stdio: "ignore" });
  const pidFile = join(sb.home, ".litectx", "ui.pid");
  try {
    for (const pid of [/** @type {number} */ (victim.pid), process.pid]) {
      mkdirSync(join(sb.home, ".litectx"), { recursive: true });
      writeFileSync(pidFile, JSON.stringify({ pid, port: 1, url: "http://127.0.0.1:1", startedAt: "x" }));
      const r = cli(sb, ["stop"]);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /no search page running/);
      assert.equal(alive(pid), true, `pid ${pid} must not be signalled`);
      assert.equal(existsSync(pidFile), false, "stale pid file cleaned up");
    }
  } finally {
    victim.kill("SIGKILL");
  }
});

test("start: a dead pid in the pid file is cleaned up and a fresh server starts", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const port = await freePort();
  const pidFile = join(sb.home, ".litectx", "ui.pid");
  mkdirSync(join(sb.home, ".litectx"), { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid: 2 ** 22 + 12345, port, url: `http://127.0.0.1:${port}`, startedAt: "x" }));
  try {
    const r = cli(sb, ["start", repo, "--port", String(port), "--no-open"]);
    assert.equal(r.code, 0, r.err);
    const rec = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.notEqual(rec.pid, 2 ** 22 + 12345);
    assert.ok(alive(rec.pid));
  } finally {
    cli(sb, ["stop"]);
  }
});

test("start: a bad path fails with the log path, and leaves no pid file", async () => {
  const sb = sandbox();
  const port = await freePort();
  const r = cli(sb, ["start", join(sb.dir, "nope"), "--port", String(port), "--no-open"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /ui\.out/);
  assert.equal(existsSync(join(sb.home, ".litectx", "ui.pid")), false);
});

// ---- port fallback ---------------------------------------------------------------------------------

/** a plain, non-litectx HTTP server on `port` */
function occupy(port) {
  return new Promise((ok, fail) => {
    const s = net.createServer((c) => c.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi"));
    s.once("error", fail);
    s.listen(port, "127.0.0.1", () => ok(s));
  });
}
/** a base port P with P and P+1 both free, and P held afterwards by the returned server */
async function occupiedBase() {
  for (;;) {
    const p = /** @type {number} */ (await freePort());
    const probe = await occupy(p + 1).catch(() => null); // P+1 must be free for the fallback to land there
    if (!probe) continue;
    await new Promise((r) => probe.close(r));
    const srv = await occupy(p).catch(() => null);
    if (srv) return { p, srv };
  }
}

test("start: port held by a non-litectx program → next free port; pid file, stop and status use the real URL", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const { p, srv } = await occupiedBase();
  sb.env.LITECTX_DEFAULT_PORT = String(p);
  const pidFile = join(sb.home, ".litectx", "ui.pid");
  try {
    // async calls: the non-litectx server lives in this process and cannot answer a probe while a sync spawn blocks it
    const r = await cliAsync(sb, ["start", repo, "--no-open"]);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, new RegExp(`started: http://127\\.0\\.0\\.1:${p + 1}\\b`));
    const rec = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.equal(rec.port, p + 1, "the pid file records the port actually used");
    assert.match((await cliAsync(sb, ["status", repo])).out, new RegExp(`UI: running \\(http://127\\.0\\.0\\.1:${p + 1}\\)`));
    const again = await cliAsync(sb, ["start", repo, "--no-open"]);
    assert.match(again.out, /already live/, "a second start reports it, not P+2");
    assert.equal(JSON.parse(readFileSync(pidFile, "utf8")).pid, rec.pid);
    assert.match((await cliAsync(sb, ["stop"])).out, /stopped/);
    assert.ok(await until(() => !alive(rec.pid)));
  } finally {
    srv.close();
    await cliAsync(sb, ["stop"]);
  }
});

test("an explicit --port that is taken is an error, never a silent move (start and ui)", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const { p, srv } = await occupiedBase();
  try {
    const r = cli(sb, ["start", repo, "--port", String(p), "--no-open"]);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`port ${p} is in use`));
    assert.equal(existsSync(join(sb.home, ".litectx", "ui.pid")), false);
    const u = cli(sb, ["ui", repo, "--port", String(p)], { timeout: 15000 });
    assert.equal(u.code, 1, "foreground ui with a taken explicit port fails");
    assert.match(u.err, /EADDRINUSE|in use/);
  } finally {
    srv.close();
  }
});

test("foreground `litectx ui` without --port takes the next free port when the base is taken; start reports a litectx ui already live", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const { p, srv } = await occupiedBase();
  sb.env.LITECTX_DEFAULT_PORT = String(p);
  /** @type {import("node:child_process").ChildProcess | null} */
  let ui = null;
  try {
    ui = spawn(process.execPath, [BIN, "ui", repo], { env: sb.env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    ui.stderr?.on("data", (c) => (err += c));
    assert.ok(await until(() => /litectx ui: http/.test(err), 10000), err);
    assert.match(err, new RegExp(`litectx ui: http://127\\.0\\.0\\.1:${p + 1}\\b`));
    // base P is held by a non-litectx program, P+1 by a litectx ui: start reuses P+1 instead of spawning a server
    const r = cli(sb, ["start", repo, "--no-open"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`already live: http://127\\.0\\.0\\.1:${p + 1} — source \\S+ \\(${repo}\\), pid ${ui.pid}`));
    assert.equal(existsSync(join(sb.home, ".litectx", "ui.pid")), false, "nothing was spawned");
  } finally {
    ui?.kill("SIGINT");
    srv.close();
  }
});

// ---- one page at a time ----------------------------------------------------------------------------

/**
 * Resolve `ui` once `ready()` holds. If it never does, kill the child BEFORE throwing: the caller's handle is
 * still null when this throws, so its `finally` could not clean up a child that was spawned inside a helper.
 */
async function readyOrKill(ui, ready, why) {
  try {
    assert.ok(await until(ready, 10000), why());
  } catch (e) {
    ui.kill("SIGKILL");
    throw e;
  }
  return ui;
}
/** a foreground `litectx ui` the test owns; resolves once it prints its URL */
async function fgUi(sb, repo, port) {
  const ui = spawn(process.execPath, [BIN, "ui", repo, "--port", String(port)], { env: sb.env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  ui.stderr?.on("data", (c) => (err += c));
  return readyOrKill(ui, () => /litectx ui: http/.test(err), () => err);
}
/**
 * A second litectx ui that slipped in despite the live-page check (a start/ui race): a tiny script named
 * `litectx.js` that serves the real UI with the argv `litectx.js ui --port N`, so it looks like a foreground ui.
 */
async function racedUi(sb, repo, port) {
  const script = join(sb.dir, "raced", "litectx.js");
  mkdirSync(join(sb.dir, "raced"), { recursive: true });
  writeFileSync(script, `import { createUi } from ${JSON.stringify(join(PKG, "src", "ui", "server.js"))};\nconst ui = await createUi({ port: Number(process.argv[4]), path: process.argv[5] });\nconsole.error("litectx ui: " + ui.url);\nprocess.on("SIGTERM", () => ui.close().then(() => process.exit(0)));\n`);
  const ui = spawn(process.execPath, [script, "ui", "--port", String(port), repo], { env: sb.env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  ui.stderr?.on("data", (c) => (err += c));
  return readyOrKill(ui, () => /litectx ui: http/.test(err), () => err);
}
/** like cli() but async, so the test process can reap the children the command stops (spawnSync would leave them zombies, which look alive) */
function cliAsync(sb, args) {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [BIN, ...args], { env: sb.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("close", (code) => ok({ code, out, err }));
  });
}
const portFree = (/** @type {number} */ p) => new Promise((ok) => { const s = net.createServer(); s.once("error", () => ok(false)); s.listen(p, "127.0.0.1", () => s.close(() => ok(true))); });
/** a base port P with P..P+3 all free */
async function baseWithRoom() {
  for (;;) {
    const p = await freePort();
    if (p < 61000 && (await Promise.all([1, 2, 3].map((i) => portFree(p + i)))).every(Boolean)) return p;
  }
}

test("one page: start twice → second reports url/source/pid, no second server; a different path is not switched", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  const other = join(sb.dir, "other");
  tinyRepo(repo);
  tinyRepo(other);
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  const pidFile = join(sb.home, ".litectx", "ui.pid");
  try {
    assert.equal(cli(sb, ["start", repo, "--no-open"]).code, 0);
    const rec = JSON.parse(readFileSync(pidFile, "utf8"));
    const r = cli(sb, ["start", repo, "--no-open"]);
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(`^already live: http://127\\.0\\.0\\.1:${base} — source \\S+ \\(${repo}\\), pid ${rec.pid}\\n$`));
    for (let i = 1; i < 4; i++) assert.equal(await portFree(base + i), true, `no server on base+${i}`);
    const o = cli(sb, ["start", other, "--no-open"]);
    assert.equal(o.code, 0);
    assert.match(o.out, /already live: /);
    assert.match(o.out, new RegExp(`to search ${other}, run litectx stop first`));
    assert.equal(JSON.parse(readFileSync(pidFile, "utf8")).pid, rec.pid);
    const st = await (await fetch(`${rec.url}/api/sources`)).json();
    assert.equal(st.sources.find((x) => x.name === st.active).path, repo, "not switched");
    assert.equal(st.pid, rec.pid);
  } finally {
    cli(sb, ["stop"]);
  }
});

test("start lock: two concurrent `litectx start` → exactly one page; the other reports already live; the lock is released", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  try {
    const rs = await Promise.all([cliAsync(sb, ["start", repo, "--no-open"]), cliAsync(sb, ["start", repo, "--no-open"])]);
    assert.deepEqual(rs.map((r) => r.code), [0, 0], rs.map((r) => r.err).join("|"));
    const started = rs.filter((r) => /started|litectx ui: |http:\/\/127/.test(r.out) && !/already live/.test(r.out));
    const already = rs.filter((r) => /^already live: /.test(r.out));
    assert.equal(started.length, 1, rs.map((r) => r.out).join("|"));
    assert.equal(already.length, 1, rs.map((r) => r.out).join("|"));
    const rec = JSON.parse(readFileSync(join(sb.home, ".litectx", "ui.pid"), "utf8"));
    assert.match(already[0].out, new RegExp(`pid ${rec.pid}`));
    const regs = readdirSync(join(sb.home, ".litectx", "pages"));
    assert.deepEqual(regs, [`${rec.pid}.json`], "one registry entry, the pid file's page");
    for (let i = 1; i < 4; i++) assert.equal(await portFree(base + i), true, `no server on base+${i}`);
    assert.equal(existsSync(join(sb.home, ".litectx", "start.lock")), false, "lock released");
  } finally {
    cli(sb, ["stop"]);
  }
});

test("start lock: a lock held by a dead pid (or an expired one) is stale and cleared; start proceeds", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  mkdirSync(join(sb.home, ".litectx"), { recursive: true });
  const lock = join(sb.home, ".litectx", "start.lock");
  try {
    // a dead pid: a just-exited child's pid is not reused within the test
    const gone = spawn(process.execPath, ["-e", "0"]);
    await new Promise((ok) => gone.on("close", ok));
    writeFileSync(lock, JSON.stringify({ pid: gone.pid, at: Date.now() }));
    const r = await cliAsync(sb, ["start", repo, "--no-open"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(existsSync(lock), false);
    cli(sb, ["stop"]);
    // alive pid but ancient timestamp: stale
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - 10 * 60 * 1000 }));
    const r2 = await cliAsync(sb, ["start", repo, "--no-open"]);
    assert.equal(r2.code, 0, r2.err);
    assert.equal(existsSync(lock), false);
  } finally {
    cli(sb, ["stop"]);
  }
});

/** run `fn` with HOME pointed at a fresh temp dir (the lock functions resolve ~/.litectx at call time) */
async function withHome(fn) {
  const sb = sandbox();
  const old = process.env.HOME;
  process.env.HOME = sb.home;
  try {
    return await fn(join(sb.home, ".litectx", "start.lock"));
  } finally {
    process.env.HOME = old;
  }
}

test("start lock: a waiter's stale snapshot never removes a lock another waiter took over in between (interleaving, deterministic)", async () => {
  const { tryCreateLock, removeStaleLock, readLockRaw } = await import("../src/cli/launcher.js");
  await withHome(async (lock) => {
    mkdirSync(join(lock, ".."), { recursive: true });
    const gone = spawn(process.execPath, ["-e", "0"]);
    await new Promise((ok) => gone.on("close", ok));
    const staleRaw = JSON.stringify({ pid: gone.pid, at: Date.now(), nonce: "dead" });
    writeFileSync(lock, staleRaw);
    // A and B both read the dead holder; A removes it and takes the lock ...
    removeStaleLock(staleRaw);
    assert.equal(existsSync(lock), false, "A removed the stale lock");
    assert.equal(tryCreateLock("nonce-A"), true);
    // ... then B, still holding its stale snapshot, runs its removal: A's fresh lock must survive intact
    removeStaleLock(staleRaw);
    assert.equal(readLockRaw()?.rec?.nonce, "nonce-A", "A's lock was not removed");
    assert.deepEqual(readdirSync(join(lock, "..")), ["start.lock"], "no tombstone or temp file left behind");
    // and B cannot take it either
    assert.equal(tryCreateLock("nonce-B"), false);
    // a second removal of the very same stale snapshot when nothing is there is a no-op
    rmSync(lock);
    removeStaleLock(staleRaw);
    assert.equal(existsSync(lock), false);
  });
});

test("start lock: on a filesystem without hard links (link throws EPERM/ENOTSUP) the lock is still created with its content, and a stale-removal restore is not lost", async () => {
  const { tryCreateLock, removeStaleLock, readLockRaw } = await import("../src/cli/launcher.js");
  for (const code of ["EPERM", "ENOTSUP"]) {
    const noLink = () => {
      throw Object.assign(new Error("no hard links"), { code });
    };
    await withHome(async (lock) => {
      mkdirSync(join(lock, ".."), { recursive: true });
      assert.equal(tryCreateLock("nonce-X", noLink), true, code);
      const held = readLockRaw();
      assert.equal(held?.rec?.nonce, "nonce-X");
      assert.equal(held?.rec?.pid, process.pid);
      assert.equal(tryCreateLock("nonce-Y", noLink), false, "held lock is still reported held");
      // a waiter's stale snapshot must not remove X's fresh lock, even when it can only be restored by exclusive create
      removeStaleLock(JSON.stringify({ pid: 1, at: 1, nonce: "old" }), noLink);
      assert.equal(readFileSync(lock, "utf8"), held?.raw, "restored byte-identical");
      assert.deepEqual(readdirSync(join(lock, "..")), ["start.lock"], "no tombstone or temp file left behind");
    });
  }
});

test("start lock: a holder whose lock was replaced is told so (owned() false) and its release leaves the new lock alone", async () => {
  const { acquireStartLock } = await import("../src/cli/launcher.js");
  await withHome(async (lock) => {
    const release = await acquireStartLock();
    assert.equal(release.owned(), true);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "someone-else" }));
    assert.equal(release.owned(), false);
    release();
    assert.equal(existsSync(lock), true, "release did not delete a lock it no longer owns");
  });
});

test("start lock: an empty (corrupt) lock is not removed at first sight — only after the same content has stood for a second; the lock is never created empty", async () => {
  const { acquireStartLock, tryCreateLock } = await import("../src/cli/launcher.js");
  await withHome(async (lock) => {
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, "");
    let got = null;
    const p = acquireStartLock().then((r) => (got = r));
    await new Promise((ok) => setTimeout(ok, 400));
    assert.equal(got, null, "still waiting");
    assert.equal(existsSync(lock), true, "not removed within the grace period");
    const r = await p; // corrupt for >1 s: now stale and taken over
    assert.equal(r.owned(), true);
    r();
    // creation goes through a temp file + link, so the lock name never exists without its content
    assert.equal(tryCreateLock("n1"), true);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).nonce, "n1");
  });
});

test("one page: a foreground ui is live → start reports it and spawns nothing; a second foreground ui exits 1", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  let ui = null;
  try {
    ui = await fgUi(sb, repo, base + 1);
    const r = cli(sb, ["start", repo, "--no-open"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`already live: http://127\\.0\\.0\\.1:${base + 1} — source \\S+ \\(${repo}\\), pid ${ui.pid}`));
    assert.equal(existsSync(join(sb.home, ".litectx", "ui.pid")), false, "nothing spawned");
    assert.equal(await portFree(base), true);
    const second = cli(sb, ["ui", repo, "--port", String(base + 2)], { timeout: 15000 });
    assert.equal(second.code, 1);
    assert.match(second.err, /already live: /);
    assert.equal(await portFree(base + 2), true, "second ui never bound");
  } finally {
    ui?.kill("SIGKILL");
  }
});

test("one page: stop stops every live page (start's and a foreground one), clears the pid file, frees both ports; bystanders are never signalled", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  const pidFile = join(sb.home, ".litectx", "ui.pid");
  const victim = spawn("sleep", ["30"], { stdio: "ignore" });
  const plain = await occupy(base + 2); // a non-litectx http server inside the scanned range
  // a litectx-mcp process (not a UI) that must never be touched
  const mcp = spawn(process.execPath, [join(PKG, "bin", "litectx-mcp.js")], { env: sb.env, stdio: ["pipe", "ignore", "ignore"] });
  let fg = null;
  try {
    assert.equal((await cliAsync(sb, ["start", repo, "--no-open"])).code, 0); // async: `plain` lives in this process and cannot answer a probe while a sync spawn blocks it
    const rec = JSON.parse(readFileSync(pidFile, "utf8"));
    fg = await racedUi(sb, repo, base + 1);
    const banner = (await cliAsync(sb, ["status", repo])).out;
    assert.match(banner, /\(\+1 more — run litectx stop\)/);
    const s = await cliAsync(sb, ["stop"]);
    assert.equal(s.code, 0, s.err + s.out);
    assert.match(s.out, new RegExp(`stopped http://127\\.0\\.0\\.1:${base} \\(pid ${rec.pid}\\)`));
    assert.match(s.out, new RegExp(`stopped http://127\\.0\\.0\\.1:${base + 1} \\(pid ${fg.pid}\\)`));
    assert.ok(await until(() => !alive(rec.pid) && !alive(/** @type {number} */ (fg?.pid))));
    assert.equal(existsSync(pidFile), false);
    assert.equal(await portFree(base), true);
    assert.equal(await portFree(base + 1), true);
    assert.equal(alive(/** @type {number} */ (victim.pid)), true, "bystander untouched");
    assert.equal(alive(/** @type {number} */ (mcp.pid)), true, "litectx-mcp untouched");
    assert.equal(plain.listening, true, "non-litectx server untouched");
    assert.equal((await cliAsync(sb, ["stop"])).out.trim(), "no search page running");
  } finally {
    await cliAsync(sb, ["stop"]);
    fg?.kill("SIGKILL");
    victim.kill("SIGKILL");
    mcp.kill("SIGKILL");
    plain.close();
  }
});

test("one page: a foreground ui on a port outside the fallback range is found by start (no second page) and stopped by stop; the registry is cleaned", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  let far;
  do far = await freePort();
  while (far >= base - 1 && far <= base + 25);
  const pages = join(sb.home, ".litectx", "pages");
  // a stale entry left by a killed page: dead pid, nothing listening
  mkdirSync(pages, { recursive: true });
  writeFileSync(join(pages, "4194999.json"), JSON.stringify({ pid: 4194999, url: "http://127.0.0.1:1", port: 1, path: null, startedAt: "x" }));
  let ui = null;
  try {
    ui = await fgUi(sb, repo, far);
    assert.ok(await until(() => existsSync(join(pages, `${ui?.pid}.json`))), "registered once listening");
    const r = cli(sb, ["start", repo, "--no-open"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`already live: http://127\\.0\\.0\\.1:${far} — source \\S+ \\(${repo}\\), pid ${ui.pid}`));
    assert.equal(existsSync(join(sb.home, ".litectx", "ui.pid")), false, "nothing spawned");
    assert.equal(await portFree(base), true, "no second page");
    assert.equal(existsSync(join(pages, "4194999.json")), false, "stale entry deleted");
    const s = await cliAsync(sb, ["stop"]);
    assert.equal(s.code, 0, s.err + s.out);
    assert.match(s.out, new RegExp(`stopped http://127\\.0\\.0\\.1:${far} \\(pid ${ui.pid}\\)`));
    assert.ok(await until(() => !alive(/** @type {number} */ (ui?.pid))));
    assert.equal(await portFree(far), true);
    assert.equal(existsSync(join(pages, `${ui.pid}.json`)), false, "entry removed on clean exit");
  } finally {
    ui?.kill("SIGKILL");
  }
});

test("stop: a page that ignores SIGTERM is reported with `kill -9 <pid>` (no escalation), exit 1", async () => {
  const sb = sandbox();
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  sb.env.LITECTX_STOP_TIMEOUT_MS = "400";
  // a stand-in named litectx.js (argv `litectx.js ui`, so the Linux cmdline guard accepts it) that serves the
  // state endpoint with its own pid and ignores SIGTERM
  const dir = join(sb.dir, "stubborn");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "litectx.js");
  writeFileSync(script, `process.on("SIGTERM", () => {});\nimport("node:http").then(({ default: http }) => http.createServer((q, r) => r.end(JSON.stringify({ version: "x", pid: process.pid, active: null, sources: [] }))).listen(${base}, "127.0.0.1", () => console.error("up")));\n`);
  const stub = spawn(process.execPath, [script, "ui"], { env: sb.env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  stub.stderr?.on("data", (c) => (err += c));
  try {
    assert.ok(await until(() => /up/.test(err), 10000), err);
    const s = await cliAsync(sb, ["stop"]);
    assert.equal(s.code, 1, s.err + s.out);
    assert.match(s.out, new RegExp(`pid ${stub.pid}\\) did not exit within 0\\.4s after SIGTERM — run: kill -9 ${stub.pid}\\n`));
    assert.equal(alive(/** @type {number} */ (stub.pid)), true, "stop does not escalate to SIGKILL");
  } finally {
    stub.kill("SIGKILL");
  }
});

test("a live page that answers slower than 1.5s still counts as live: status reports it, stop stops it (not 'no search page running')", async () => {
  const sb = sandbox();
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  // a stand-in named litectx.js (argv `litectx.js ui`) whose state endpoint answers only after 2s (a busy page)
  const dir = join(sb.dir, "slow");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "litectx.js");
  writeFileSync(script, `process.on("SIGTERM", () => process.exit(0));\nimport("node:http").then(({ default: http }) => http.createServer((q, r) => setTimeout(() => r.end(JSON.stringify({ version: "x", pid: process.pid, active: null, sources: [] })), 2000)).listen(${base}, "127.0.0.1", () => console.error("up")));\n`);
  const stub = spawn(process.execPath, [script, "ui"], { env: sb.env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  stub.stderr?.on("data", (c) => (err += c));
  try {
    assert.ok(await until(() => /up/.test(err), 10000), err);
    const st = await cliAsync(sb, ["status"]);
    assert.match(st.out, /UI: .*running.*\(.*http:\/\/127\.0\.0\.1:\d+/, st.out);
    assert.doesNotMatch(st.out, /not running/);
    const s = await cliAsync(sb, ["stop"]);
    assert.equal(s.code, 0, s.err + s.out);
    assert.match(s.out, new RegExp(`stopped http://127\\.0\\.0\\.1:\\d+ \\(pid ${stub.pid}\\)`));
    assert.equal(alive(/** @type {number} */ (stub.pid)), false);
  } finally {
    stub.kill("SIGKILL");
  }
});

test("stop finds a page that `start` spawned and is still waiting for (not listening, not registered): it stops it, never says 'no search page running'", async () => {
  const sb = sandbox();
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  // a stand-in named litectx.js (argv `litectx.js ui`) that never listens: a page busy with a big folder
  const dir = join(sb.dir, "busy");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "litectx.js");
  writeFileSync(script, "setInterval(() => {}, 1000);\n");
  const stub = spawn(process.execPath, [script, "ui"], { env: sb.env, stdio: "ignore" });
  const victim = spawn("sleep", ["30"], { stdio: "ignore" });
  mkdirSync(join(sb.home, ".litectx"), { recursive: true });
  const starting = join(sb.home, ".litectx", "ui.starting");
  try {
    writeFileSync(starting, JSON.stringify({ pid: stub.pid }) + "\n"); // what startUi writes right after spawning
    const s = await cliAsync(sb, ["stop"]);
    assert.equal(s.code, 0, s.err + s.out);
    assert.match(s.out, new RegExp(`stopped the search page that was still starting \\(pid ${stub.pid}\\)`));
    assert.doesNotMatch(s.out, /no search page running/);
    assert.equal(await until(() => !alive(/** @type {number} */ (stub.pid)), 5000), true);
    assert.equal(existsSync(starting), false, "the record is removed");
    // a record whose pid is not a litectx ui (reused pid) is dropped, never signalled
    writeFileSync(starting, JSON.stringify({ pid: victim.pid }) + "\n");
    const t = await cliAsync(sb, ["stop"]);
    assert.match(t.out, /no search page running/);
    assert.equal(alive(/** @type {number} */ (victim.pid)), true, "never signalled");
    assert.equal(existsSync(starting), false);
  } finally {
    stub.kill("SIGKILL");
    victim.kill("SIGKILL");
  }
});

test("one page: start with several pages live ends with the (+N more — run litectx stop) hint; with one page it does not", async () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  let fg = null;
  try {
    assert.equal(cli(sb, ["start", repo, "--no-open"]).code, 0);
    const one = cli(sb, ["start", repo, "--no-open"]);
    assert.doesNotMatch(one.out, /more — run litectx stop/);
    fg = await racedUi(sb, repo, base + 1);
    const two = cli(sb, ["start", repo, "--no-open"]);
    assert.equal(two.code, 0, two.err);
    assert.equal(two.out.match(/already live: /g)?.length, 2);
    assert.match(two.out, /\(\+1 more — run litectx stop\)\n$/);
  } finally {
    cli(sb, ["stop"]);
    fg?.kill("SIGKILL");
  }
});

test("one page: the stop guard refuses a page whose pid is not a litectx ui process", async () => {
  // a fake "litectx ui" API that reports the pid of a plain `sleep` — the guard must not signal it
  const sb = sandbox();
  const base = await baseWithRoom();
  sb.env.LITECTX_DEFAULT_PORT = String(base);
  const victim = spawn("sleep", ["30"], { stdio: "ignore" });
  const fake = spawn(process.execPath, ["-e", `require("http").createServer((q,r)=>r.end(JSON.stringify({version:"x",pid:${victim.pid},active:null,sources:[]}))).listen(${base},"127.0.0.1",()=>console.log("up"))`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((ok) => fake.stdout.once("data", ok));
  try {
    const r = cli(sb, ["stop"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /not stopping/);
    assert.equal(alive(/** @type {number} */ (victim.pid)), true, "never signalled");
  } finally {
    fake.kill("SIGKILL");
    victim.kill("SIGKILL");
  }
});

// ---- status ----------------------------------------------------------------------------------------

/** recursive listing with sizes+mtimes, to prove a command wrote nothing */
function snapshot(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      const st = statSync(p);
      out.push(`${p}\t${e.isDirectory() ? "d" : st.size}\t${st.mtimeMs}`);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

test("status: with and without an index, and it writes nothing", () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  const world = () => [...snapshot(sb.dir)];
  let before = world();
  const none = cli(sb, ["status", repo]);
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /index: none at /);
  assert.match(none.out, /MCP registered: no/);
  assert.deepEqual(world(), before, "status without an index created nothing (no .litectx dir, no home files)");

  assert.equal(cli(sb, ["index", repo, "--no-embeddings"]).code, 0);
  before = world();
  const some = cli(sb, ["status", repo]);
  assert.equal(some.code, 0, some.err);
  assert.match(some.out, /files indexed: 1\b/);
  assert.match(some.out, /meaning \(embeddings\): off/);
  assert.match(some.out, /last indexed: \d{4}-/);
  assert.deepEqual(world(), before, "status on an index changed nothing (no -wal/-shm, no mtime change)");

  // Claude section reflects reality
  fakeClaude(sb);
  assert.equal(cli(sb, ["setup", "--dev"]).code, 0);
  const wired = cli(sb, ["status", repo]).out;
  assert.match(wired, /MCP registered: yes/);
  assert.match(wired, /warm-index hook \(SessionStart\): yes/);
  assert.match(wired, /pre-edit impact hook \(PreToolUse:Edit\): yes/);
});

test("status: a folder of repos reports its repo count", () => {
  const sb = sandbox();
  const folder = join(sb.dir, "many");
  tinyRepo(join(folder, "r1"));
  tinyRepo(join(folder, "r2"));
  // the UI indexes a folder of repos as childRepos; the library writes <folder>/.litectx/index.db
  execFileSync(process.execPath, ["--input-type=module", "-e", `import {LiteCtx} from ${JSON.stringify(join(PKG, "src/index.js"))}; const c=new LiteCtx({root:${JSON.stringify(folder)},childRepos:true,embeddings:false}); await c.index(); c.close();`]);
  const r = cli(sb, ["status", folder]);
  assert.match(r.out, /repos: 2 \(folder of repos\)/);
  assert.match(r.out, /files indexed: 2\b/);
});

// ---- bare ------------------------------------------------------------------------------------------

test("bare `litectx` without a terminal still prints usage and exits 0 (scripts never hang)", () => {
  const sb = sandbox();
  const r = cli(sb, []);
  assert.equal(r.code, 0);
  assert.match(r.out, /^usage: litectx index/);
  assert.match(r.out, /litectx start \[path\]/);
  assert.match(r.out, /litectx setup \[--remove\] \[--dev\]/);
});

// ---- index path resolution ---------------------------------------------------------------------------

test("index: a leading ~ expands to HOME; a nonexistent folder exits 1 and creates nothing", () => {
  const sb = sandbox();
  mkdirSync(join(sb.home, "proj"));
  writeFileSync(join(sb.home, "proj", "a.js"), "export function alpha() { return 1; }\n");
  const r = cli(sb, ["index", "~/proj", "--no-embeddings"], { cwd: sb.dir });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /indexed 1 files from /);
  assert.ok(existsSync(join(sb.home, "proj", ".litectx", "index.db")), "indexed under HOME");
  assert.ok(!existsSync(join(sb.dir, "~")), "no literal ~ directory in cwd");

  const before = readdirSync(sb.dir).sort();
  const bad = cli(sb, ["index", "~/nope/deeper", "--no-embeddings"], { cwd: sb.dir });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /no such folder: ~\/nope\/deeper/);
  assert.deepEqual(readdirSync(sb.dir).sort(), before, "cwd listing unchanged");
  assert.ok(!existsSync(join(sb.home, "nope")));
  const file = cli(sb, ["index", join(sb.home, "proj", "a.js"), "--no-embeddings"], { cwd: sb.dir });
  assert.equal(file.code, 1, "a file is not a folder");
});

test("status: a cold build that was cut short is reported as incomplete; a complete index is not", () => {
  const sb = sandbox();
  const repo = join(sb.dir, "repo");
  tinyRepo(repo);
  assert.equal(cli(sb, ["index", repo, "--no-embeddings"]).code, 0);
  assert.doesNotMatch(cli(sb, ["status", repo]).out, /incomplete/);
  const stamp = (/** @type {number} */ v) => {
    const db = new Database(join(repo, ".litectx", "index.db"));
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
    db.pragma(`user_version = ${v}`);
    db.close();
  };
  stamp(-indexStamp()); // exactly what LiteCtx.index leaves after Ctrl+C mid cold build
  assert.match(cli(sb, ["status", repo]).out, /index: incomplete — a build is running or was stopped; run litectx index/);
  stamp(indexStamp());
  assert.doesNotMatch(cli(sb, ["status", repo]).out, /incomplete/);
});
