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
  old.hooks.PreToolUse.push({ matcher: "Edit", hooks: [{ type: "command", command: "node /old/place/integrations/claude/pre-edit-impact.mjs" }, { type: "command", command: "/usr/bin/second-edit-hook" }] });
  old.hooks.SessionStart = [{ matcher: "", hooks: [{ type: "command", command: "/old/place/integrations/claude/warm-index.sh" }] }];
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
    assert.match(r2.out, /already running/);
    assert.equal(JSON.parse(readFileSync(pidFile, "utf8")).pid, rec.pid, "same server, no second spawn");

    const s = cli(sb, ["stop"]);
    assert.equal(s.code, 0, s.err);
    assert.match(s.out, /stopped/);
    assert.ok(await until(() => !alive(rec.pid)), "server process is gone");
    assert.equal(existsSync(pidFile), false);
    assert.match(cli(sb, ["stop"]).out, /nothing running/);
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
      assert.match(r.out, /stale pid file/);
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
    const r = cli(sb, ["start", repo, "--no-open"]);
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, new RegExp(`started: http://127\\.0\\.0\\.1:${p + 1}\\b`));
    const rec = JSON.parse(readFileSync(pidFile, "utf8"));
    assert.equal(rec.port, p + 1, "the pid file records the port actually used");
    assert.match(cli(sb, ["status", repo]).out, new RegExp(`UI: running \\(http://127\\.0\\.0\\.1:${p + 1}\\)`));
    const again = cli(sb, ["start", repo, "--no-open"]);
    assert.match(again.out, /already running/, "a second start reuses it, not P+2");
    assert.equal(JSON.parse(readFileSync(pidFile, "utf8")).pid, rec.pid);
    assert.match(cli(sb, ["stop"]).out, /stopped/);
    assert.ok(await until(() => !alive(rec.pid)));
  } finally {
    srv.close();
    cli(sb, ["stop"]);
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

test("foreground `litectx ui` without --port takes the next free port when the base is taken; start reuses a litectx ui already on the base", async () => {
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
    assert.match(r.out, new RegExp(`already running: http://127\\.0\\.0\\.1:${p + 1}`));
    assert.equal(existsSync(join(sb.home, ".litectx", "ui.pid")), false, "nothing was spawned");
  } finally {
    ui?.kill("SIGINT");
    srv.close();
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
