// The menu banner has two separate lines: `here:` is the current folder's index, `page:` is the search page and
// the folder IT has open (from ui.json when stopped). Real pty, temp HOME, temp ui.json, random port; the menu is
// answered q, so nothing is started.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/litectx.js", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "litectx-menu-banner-"));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
const hasPython = spawnSync("python3", ["-c", "1"]).status === 0;
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""); // eslint-disable-line no-control-regex

/** the bare CLI on a pty in `cwd`, answering its first prompt with q; returns the terminal text */
function banner(/** @type {string} */ cwd, /** @type {NodeJS.ProcessEnv} */ env) {
  const py = `import pty,os,select,re,time,json
node=${JSON.stringify(process.execPath)}
pid,fd=pty.fork()
if pid==0:
    os.chdir(${JSON.stringify(cwd)})
    os.execve(node,[node,${JSON.stringify(BIN)}],os.environ)
out=b""; sent=False; t0=time.time()
while time.time()-t0<30:
    r,_,_=select.select([fd],[],[],0.1)
    if r:
        try: d=os.read(fd,65536)
        except OSError: break
        if not d: break
        out+=d
        if not sent and b"> " in re.sub(rb"\\x1b\\[[0-9;?]*[a-zA-Z]",b"",out):
            sent=True; os.write(fd,b"q\\r")
try: os.kill(pid,9)
except OSError: pass
os.waitpid(pid,0)
print(json.dumps({"out":out.decode("utf8","replace")}))
`;
  return new Promise((ok) => {
    const c = spawn("python3", ["-I", "-c", py], { env, stdio: ["ignore", "pipe", "ignore"] });
    let o = "";
    c.stdout.on("data", (d) => (o += d));
    c.on("close", () => ok(plain(JSON.parse(o.trim().split("\n").pop() ?? "{}").out ?? "")));
  });
}

test("menu banner (page off): `here:` is the current folder + its index, `page:` is the saved folder the page will open, with its own mode (no count: that would read the whole index)", { skip: !hasPython }, async () => {
  const home = join(tmp, "home");
  const here = join(home, "work", "here");
  const repos = join(home, "repos");
  mkdirSync(here, { recursive: true });
  writeFileSync(join(here, "a.js"), "export const a = 1;\n");
  for (const r of ["r1", "r2"]) {
    mkdirSync(join(repos, r), { recursive: true });
    execFileSync("git", ["init", "-q", join(repos, r)]);
    for (const f of ["x.js", "y.js", "z.js"]) writeFileSync(join(repos, r, f), `export const v${r}${f.length} = 1;\n`);
  }
  const ui = join(home, "ui.json");
  writeFileSync(ui, JSON.stringify({ active: "repos", sources: [{ name: "repos", path: repos }] }));
  const env = { ...process.env, HOME: home, LITECTX_UI_CONFIG: ui, LITECTX_DEFAULT_PORT: String(20000 + Math.floor(Math.random() * 30000)) };
  for (const d of [here, repos]) execFileSync(process.execPath, [BIN, "index", d, "--no-embeddings"], { env, stdio: "ignore" });

  const out = await banner(here, env);
  assert.match(out, /here: {2}~\/work\/here · 1 files · meaning off/);
  assert.match(out, /page: {2}not running · will open ~\/repos · 2 repos\r?$/m, "no file count: reading it would copy the whole index");
  assert.doesNotMatch(out, /^index:/m, "the old single index: line is gone");
});

test("menu banner (page running): `page:` shows the URL and the folder, mode and file count the live page reports, not the current folder", { skip: !hasPython }, async () => {
  const home = join(tmp, "home3");
  const here = join(home, "elsewhere");
  const repo = join(home, "proj");
  mkdirSync(here, { recursive: true });
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  for (const f of ["x.js", "y.js"]) writeFileSync(join(repo, f), `export const v${f.length} = 1;\n`);
  execFileSync("git", ["-C", repo, "add", "-A"]); // the indexer reads git's file list
  const ui = join(home, "ui.json");
  writeFileSync(ui, JSON.stringify({ active: "proj", sources: [{ name: "proj", path: repo }] }));
  // a recording xdg-open first on PATH: `start` must never reach the owner's real browser
  const bin = join(home, "bin");
  const openLog = join(home, "open.log");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\necho "$@" >> ${openLog}\n`);
  chmodSync(join(bin, "xdg-open"), 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, LITECTX_UI_CONFIG: ui, LITECTX_DEFAULT_PORT: String(20000 + Math.floor(Math.random() * 30000)) };
  execFileSync(process.execPath, [BIN, "index", repo, "--no-embeddings"], { env, stdio: "ignore" });
  execFileSync(process.execPath, [BIN, "start", "--no-open"], { env, stdio: "ignore" });
  try {
    // the page indexes its folder after it starts and reports 0 files until that pass ends: wait for it
    const url = readdirSync(join(home, ".litectx", "pages")).map((f) => JSON.parse(readFileSync(join(home, ".litectx", "pages", f), "utf8")).url)[0];
    for (let i = 0; i < 100; i++) {
      const j = await (await fetch(`${url}/api/sources`)).json();
      if (j.current && !j.current.indexing && j.current.files > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const out = await banner(here, env);
    assert.match(out, /here: {2}~\/elsewhere · none here/);
    assert.match(out, /page: {2}running at http:\/\/127\.0\.0\.1:\d+ · ~\/proj · one repo · 2 files/);
  } finally {
    execFileSync(process.execPath, [BIN, "stop"], { env, stdio: "ignore" });
  }
  assert.equal(existsSync(openLog), false, "no browser was opened");
});

test("menu banner: no saved folder and no index here say so plainly", { skip: !hasPython }, async () => {
  const home = join(tmp, "home2");
  const here = join(home, "empty");
  mkdirSync(here, { recursive: true });
  const env = { ...process.env, HOME: home, LITECTX_UI_CONFIG: join(home, "ui.json"), LITECTX_DEFAULT_PORT: String(20000 + Math.floor(Math.random() * 30000)) };
  const out = await banner(here, env);
  assert.match(out, /here: {2}~\/empty · none here/);
  assert.match(out, /page: {2}not running · no folder saved yet/);
});
