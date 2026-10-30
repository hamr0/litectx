// `litectx update` / `restart` and the menu that carries them. A fake registry (loopback http server) and a fake
// npm script stand in for the network and for npm: nothing here goes online or installs anything. CLI processes
// run against a temp HOME, a fake editor config and a port far from 4747.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { updateCmd, globalPrefix } from "../src/cli/update.js";
import { version } from "../src/cli/paths.js";

const PKG = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const BIN = join(PKG, "bin", "litectx.js");
const tmp = mkdtempSync(join(tmpdir(), "litectx-upd-"));
const servers = /** @type {http.Server[]} */ ([]);
after(() => {
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

const MINE = version();
const NEWER = "999.0.0";

/** a loopback registry answering `handler` @param {http.RequestListener} handler @returns {Promise<string>} its url */
async function registry(handler) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise((ok) => s.listen(0, "127.0.0.1", () => ok(undefined)));
  return `http://127.0.0.1:${/** @type {any} */ (s.address()).port}/litectx/latest`;
}
const reply = (/** @type {unknown} */ body) => registry((_q, r) => r.end(JSON.stringify(body)));

let n = 0;
/** a fake npm: logs its args as JSON, exits `code` @returns {{ npm: string, log: string }} */
function fakeNpm(code = 0) {
  const dir = join(tmp, `npm${++n}`);
  mkdirSync(dir);
  const log = join(dir, "args.log");
  const npm = join(dir, "npm");
  writeFileSync(npm, `#!/usr/bin/env node\nrequire("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(${code});\n`);
  chmodSync(npm, 0o755);
  return { npm, log };
}
const ran = (/** @type {string} */ log) => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

/** a global-shaped install: <prefix>/lib/node_modules/litectx (a real copy of the CLI; node_modules is shared) */
function globalInstall() {
  const prefix = join(tmp, `g${++n}`);
  const dir = join(prefix, "lib", "node_modules", "litectx");
  mkdirSync(dir, { recursive: true });
  for (const f of ["bin", "src", "package.json", "integrations"]) cpSync(join(PKG, f), join(dir, f), { recursive: true });
  symlinkSync(join(PKG, "node_modules"), join(dir, "node_modules"));
  return { prefix, dir };
}

/** run updateCmd in-process, capturing its lines @param {import("../src/cli/update.js").UpdateOpts} o */
async function run(o) {
  /** @type {string[]} */
  const lines = [];
  const code = await updateCmd({ out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), ...o });
  return { code, lines };
}
/** an answer script for the y/n; records the questions @param {string[]} answers */
function answers(answers) {
  const asked = /** @type {string[]} */ ([]);
  return { asked, ask: async (/** @type {string} */ q) => (asked.push(q), answers.shift() ?? "") };
}

test("globalPrefix: <prefix>/lib/node_modules/litectx is global; checkout, local node_modules and Windows shape are not; symlinks are resolved", () => {
  const g = globalInstall();
  assert.equal(globalPrefix(g.dir), g.prefix);
  assert.equal(globalPrefix(PKG), null, "a checkout");
  const local = join(tmp, "proj", "node_modules", "litectx");
  mkdirSync(local, { recursive: true });
  assert.equal(globalPrefix(local), null, "a local node_modules");
  const win = join(tmp, "winprefix", "node_modules", "litectx");
  mkdirSync(win, { recursive: true });
  assert.equal(globalPrefix(win), null, "Windows shape is not told apart from a local install");
  const link = join(tmp, `link${++n}`);
  symlinkSync(g.dir, link);
  assert.equal(globalPrefix(link), g.prefix, "the real location decides");
  const elsewhere = join(tmp, `elsewhere${++n}`);
  mkdirSync(elsewhere);
  const viaLink = join(tmp, "lib2", "node_modules");
  mkdirSync(viaLink, { recursive: true });
  symlinkSync(elsewhere, join(viaLink, "litectx"));
  assert.equal(globalPrefix(join(viaLink, "litectx")), null, "a global-looking path that really lives elsewhere");
  assert.equal(globalPrefix(join(tmp, "missing")), null);
});

test("newest: equal or older registry version -> the newest line, exit 0, no question, no npm", async () => {
  for (const v of [MINE, "0.0.1"]) {
    const f = fakeNpm();
    const a = answers([]);
    const r = await run({ registryUrl: await reply({ version: v }), npm: f.npm, ask: a.ask, dir: globalInstall().dir });
    assert.equal(r.code, 0);
    assert.deepEqual(r.lines, [`You have the newest litectx (${MINE}).`]);
    assert.deepEqual(a.asked, []);
    assert.deepEqual(ran(f.log), []);
  }
});

test("newer + y: installs with --prefix <the running prefix>, exact words, typed vs menu wording", async () => {
  for (const [yes, then] of [["y", "Then run litectx restart."], [" YES ", "Then pick 3 restart."]]) {
    const g = globalInstall();
    const f = fakeNpm();
    const a = answers([yes]);
    const r = await run({ registryUrl: await reply({ version: NEWER }), npm: f.npm, ask: a.ask, dir: g.dir, fromMenu: then.includes("pick") });
    assert.equal(r.code, 0);
    assert.deepEqual(r.lines, [`litectx ${NEWER} is out. You have ${MINE}.`, `Updated to ${NEWER}. ${then}`]);
    assert.deepEqual(a.asked, ["Update now? (y/n) "]);
    assert.deepEqual(ran(f.log), [["install", "-g", "--prefix", g.prefix, "litectx@latest"]]);
  }
});

test("newer + n (or anything else): the Not updated line with the exact command, no npm, exit 0; Enter asks once more, a second Enter is n", async () => {
  for (const ans of [["n"], ["maybe"], ["", ""]]) {
    const g = globalInstall();
    const f = fakeNpm();
    const a = answers([...ans]);
    const r = await run({ registryUrl: await reply({ version: NEWER }), npm: f.npm, ask: a.ask, dir: g.dir });
    assert.equal(r.code, 0);
    assert.deepEqual(r.lines, [`litectx ${NEWER} is out. You have ${MINE}.`, `Not updated. To update later: npm install -g --prefix ${g.prefix} litectx@latest`]);
    assert.equal(a.asked.length, ans.length === 2 ? 2 : 1);
    assert.deepEqual(ran(f.log), []);
  }
  const g = globalInstall();
  const f = fakeNpm();
  const a = answers(["", "y"]);
  assert.equal((await run({ registryUrl: await reply({ version: NEWER }), npm: f.npm, ask: a.ask, dir: g.dir })).code, 0);
  assert.equal(ran(f.log).length, 1, "an empty Enter then y installs");
});

test("piped input (no ask): prints the newer line then Not updated, exit 0, never installs", async () => {
  const g = globalInstall();
  const f = fakeNpm();
  const r = await run({ registryUrl: await reply({ version: NEWER }), npm: f.npm, ask: null, dir: g.dir });
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, [`litectx ${NEWER} is out. You have ${MINE}.`, `Not updated. To update later: npm install -g --prefix ${g.prefix} litectx@latest`]);
  assert.deepEqual(ran(f.log), []);
});

test("not a global install: newer line, the not-global line, no question, no npm, exit 0", async () => {
  const f = fakeNpm();
  const a = answers(["y"]);
  const r = await run({ registryUrl: await reply({ version: NEWER }), npm: f.npm, ask: a.ask, dir: PKG });
  assert.equal(r.code, 0);
  assert.deepEqual(r.lines, [`litectx ${NEWER} is out. You have ${MINE}.`, "Not a global install, so update it the way you installed it."]);
  assert.deepEqual(a.asked, []);
  assert.deepEqual(ran(f.log), []);
});

test("failed install: the exact command to run yourself, exit 1 (non-zero npm, missing npm, and a hung npm at the deadline)", async () => {
  const g = globalInstall();
  const want = `ERR The update did not finish. Run it yourself: npm install -g --prefix ${g.prefix} litectx@latest`;
  const url = await reply({ version: NEWER });
  const bad = await run({ registryUrl: url, npm: fakeNpm(3).npm, ask: answers(["y"]).ask, dir: g.dir });
  assert.equal(bad.code, 1);
  assert.deepEqual(bad.lines, [`litectx ${NEWER} is out. You have ${MINE}.`, want]);
  assert.equal((await run({ registryUrl: url, npm: join(tmp, "no-such-npm"), ask: answers(["y"]).ask, dir: g.dir })).code, 1);
  const hang = join(tmp, "hang-npm");
  writeFileSync(hang, "#!/bin/sh\nsleep 30\n");
  chmodSync(hang, 0o755);
  const t0 = Date.now();
  const slow = await run({ registryUrl: url, npm: hang, ask: answers(["y"]).ask, dir: g.dir, npmDeadlineMs: 300 });
  assert.equal(slow.code, 1);
  assert.ok(Date.now() - t0 < 5000, "killed at its deadline");
});

test("could not reach npm: timeout, offline, bad reply, a version that is not semver -> one line, exit 1, nothing asked or run", async () => {
  const f = fakeNpm();
  const a = answers(["y"]);
  const hung = await registry(() => {}); // never answers
  const dead = await registry((_q, r) => r.end());
  const closed = new URL(dead);
  servers.at(-1)?.close();
  const urls = [
    [hung, 200],
    [`http://127.0.0.1:${closed.port}/x`, 2000],
    [await registry((_q, r) => r.end("not json")), 2000],
    [await registry((_q, r) => ((r.statusCode = 500), r.end("{}"))), 2000],
    [await reply({ version: "1.2.3; rm -rf /" }), 2000],
    [await reply({ version: 5 }), 2000],
    [await reply({}), 2000],
  ];
  for (const [registryUrl, timeoutMs] of urls) {
    const r = await run({ registryUrl: String(registryUrl), timeoutMs: Number(timeoutMs), npm: f.npm, ask: a.ask, dir: globalInstall().dir });
    assert.equal(r.code, 1, String(registryUrl));
    assert.deepEqual(r.lines, ["ERR Could not reach npm to check. Try again later."]);
  }
  assert.deepEqual(a.asked, []);
  assert.deepEqual(ran(f.log), []);
});

// ---- the real CLI process -------------------------------------------------------------------------------

/** a sandbox env: temp HOME, fake editor config, a port far from 4747, fake opener first on PATH */
function sandbox() {
  const dir = join(tmp, `s${++n}`);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  const editor = join(dir, "editor.sh");
  writeFileSync(editor, "#!/bin/sh\nexit 0\n");
  chmodSync(editor, 0o755);
  writeFileSync(join(bin, "xdg-open"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "xdg-open"), 0o755);
  writeFileSync(join(dir, "ui.json"), JSON.stringify({ active: null, sources: [], editor }));
  const port = 20000 + Math.floor(Math.random() * 30000);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, LITECTX_UI_CONFIG: join(dir, "ui.json"), LITECTX_DEFAULT_PORT: String(port), LITECTX_STOP_TIMEOUT_MS: "400" };
  return { dir, bin, env, port };
}
/** async, so this process's fake registry keeps answering while the CLI runs */
const cli = (/** @type {NodeJS.ProcessEnv} */ env, /** @type {string[]} */ args, /** @type {string} */ bin = BIN) =>
  /** @type {Promise<{ code: number | null, out: string, err: string }>} */ (
    new Promise((ok) => {
      const c = spawn(process.execPath, [bin, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (err += d));
      c.on("close", (code) => ok({ code, out, err }));
    })
  );

test("typed `litectx update`, piped: from a global install it says the newer line + Not updated, exit 0, fake npm never runs", async () => {
  const g = globalInstall();
  const f = fakeNpm();
  const sb = sandbox();
  const env = { ...sb.env, LITECTX_REGISTRY_URL: await reply({ version: NEWER }), LITECTX_NPM: f.npm };
  const r = await cli(env, ["update"], join(g.dir, "bin", "litectx.js"));
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `litectx ${NEWER} is out. You have ${MINE}.\nNot updated. To update later: npm install -g --prefix ${g.prefix} litectx@latest\n`);
  assert.deepEqual(ran(f.log), []);
  const off = await cli({ ...sb.env, LITECTX_REGISTRY_URL: "http://127.0.0.1:1/x" }, ["update"]);
  assert.equal(off.code, 1);
  assert.equal(off.err, "Could not reach npm to check. Try again later.\n");
  assert.match((await cli(sb.env, ["help"])).out, /litectx restart .*\n.*litectx update /);
});

const hasPython = spawnSync("python3", ["-c", "1"]).status === 0;
/** run bare `litectx` on a pty, answering the prompts in order; returns what the terminal showed */
function menuOnPty(/** @type {NodeJS.ProcessEnv} */ env, /** @type {string[]} */ typed, bin = BIN) {
  const py = `import pty,os,sys,select,re
pid,fd=pty.fork()
if pid==0:
    os.execve(${JSON.stringify(process.execPath)},[${JSON.stringify(process.execPath)},${JSON.stringify(bin)}],os.environ)
out=b""
typed=${JSON.stringify(typed)}
seen=0
while True:
    r,_,_=select.select([fd],[],[],20)
    if not r: break
    try: d=os.read(fd,4096)
    except OSError: break
    if not d: break
    out+=d
    if typed and len(re.findall(rb">(\\x1b\\[0m)? |\\(y/n\\) ",out))>seen:
        seen+=1
        os.write(fd,typed.pop(0).encode()+b"\\r")
os.waitpid(pid,0)
sys.stdout.write(out.decode("utf8","replace"))
`;
  return /** @type {Promise<string>} */ (
    new Promise((ok) => {
      const c = spawn("python3", ["-I", "-c", py], { env, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", () => ok(out));
    })
  );
}

test("menu on a terminal: the new line with a green q; 7 update runs update with the menu wording and the global prefix", { skip: !hasPython }, async () => {
  const g = globalInstall();
  const f = fakeNpm();
  const sb = sandbox();
  const env = { ...sb.env, FORCE_COLOR: "1", LITECTX_REGISTRY_URL: await reply({ version: NEWER }), LITECTX_NPM: f.npm };
  const shown = await menuOnPty(env, ["7", "y"], join(g.dir, "bin", "litectx.js"));
  // eslint-disable-next-line no-control-regex
  const plain = shown.replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /1 start {3}2 stop {3}3 restart {3}4 index {3}5 setup {3}6 status {3}7 update {3}q quit/);
  assert.ok(shown.includes("\x1b[32mq\x1b[0m quit"), "q is green");
  assert.match(plain, /Updated to 999\.0\.0\. Then pick 3 restart\./);
  assert.deepEqual(ran(f.log), [["install", "-g", "--prefix", g.prefix, "litectx@latest"]]);
  const mono = await menuOnPty({ ...env, FORCE_COLOR: "", NO_COLOR: "1" }, ["q"]);
  assert.doesNotMatch(mono, /\x1b\[[0-9;]*m/, "NO_COLOR is honoured");
});

// ---- restart ----------------------------------------------------------------------------------------------

/** wait until `url` answers (or gives up) @param {string} url */
async function up(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return true;
    } catch {
      // not yet
    }
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return false;
}

test("restart with nothing running just starts a page; with one running it stops it and starts a new one (new pid)", async () => {
  const sb = sandbox();
  try {
    const first = await cli(sb.env, ["restart", "--no-open", "--no-embeddings"]);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /^no search page running\nlitectx ui started: /);
    const pid1 = Number(JSON.parse(readFileSync(join(sb.env.HOME ?? "", ".litectx", "ui.pid"), "utf8")).pid);
    const second = await cli(sb.env, ["restart", "--no-open"]);
    assert.equal(second.code, 0, second.err);
    assert.match(second.out, /^stopped http:\/\/127\.0\.0\.1:\d+ \(pid \d+\)\nlitectx ui started: /);
    const pid2 = Number(JSON.parse(readFileSync(join(sb.env.HOME ?? "", ".litectx", "ui.pid"), "utf8")).pid);
    assert.notEqual(pid1, pid2);
  } finally {
    await cli(sb.env, ["stop"]);
  }
});

test("restart where stop could not stop a page: exit 1, the stop failure is printed, nothing is started", async () => {
  const sb = sandbox();
  // a stand-in page that answers as a litectx ui, is named like one and ignores SIGTERM
  const fake = join(sb.dir, "litectx");
  writeFileSync(fake, `#!/usr/bin/env node\nprocess.on("SIGTERM", () => {});\nrequire("http").createServer((q, r) => r.end(JSON.stringify({ version: "0", pid: process.pid, active: null, sources: [] }))).listen(${sb.port}, "127.0.0.1");\n`);
  const child = spawn(process.execPath, [fake, "ui"], { stdio: "ignore" });
  try {
    assert.ok(await up(`http://127.0.0.1:${sb.port}/api/sources`));
    const r = await cli(sb.env, ["restart", "--no-open"]);
    assert.equal(r.code, 1);
    assert.match(r.out, new RegExp(`did not exit within 0\\.4s after SIGTERM — run: kill -9 ${child.pid}`));
    assert.doesNotMatch(r.out, /started/);
    assert.equal(existsSync(join(sb.env.HOME ?? "", ".litectx", "ui.out")), false, "start never ran");
  } finally {
    child.kill("SIGKILL");
  }
});
