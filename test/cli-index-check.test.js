// Menu pick 4 asks before indexing a folder that has no index. `litectx index` never asks. Temp HOME and temp
// folders only; the pty tests answer q, so nothing is ever indexed (no model download).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmFolder, countFiles, indexQuestion } from "../src/cli/indexcheck.js";

const BIN = fileURLToPath(new URL("../bin/litectx.js", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "litectx-ixcheck-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** @param {number} files @param {string[]} [extra] relative paths to also create */
function folder(files, extra = []) {
  const d = join(tmp, `f${++n}`);
  mkdirSync(d, { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(join(d, `a${i}.js`), "x\n");
  for (const e of extra) {
    mkdirSync(join(d, e, ".."), { recursive: true });
    writeFileSync(join(d, e), "x\n");
  }
  return d;
}
const plain = (/** @type {string} */ s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ""); // eslint-disable-line no-control-regex

test("countFiles: indexer extensions only, node_modules/.git skipped, stops at the cap", () => {
  const d = folder(3, ["node_modules/x/y.js", "sub/b.py", "notes.txt", "sub/c.md"]);
  assert.deepEqual(countFiles(d), { count: 5, capped: false });
  const big = folder(30);
  assert.deepEqual(countFiles(big, 10), { count: 10, capped: true });
});

test("countFiles: a git repo is counted from git's file list (untracked and ignored files are not counted); a folder of repos is summed", () => {
  const d = folder(2);
  const git = (/** @type {string} */ dir, /** @type {string[]} */ ...a) => execFileSync("git", ["-C", dir, "-c", "user.email=a@b", "-c", "user.name=t", ...a], { stdio: "ignore" });
  git(d, "init", "-q");
  git(d, "add", "a0.js");
  assert.deepEqual(countFiles(d), { count: 1, capped: false }, "a1.js is untracked");
  const parent = join(tmp, `p${++n}`);
  mkdirSync(parent);
  for (const r of ["r1", "r2"]) {
    mkdirSync(join(parent, r));
    writeFileSync(join(parent, r, "m.js"), "x\n");
    writeFileSync(join(parent, r, "n.md"), "x\n");
    git(join(parent, r), "init", "-q");
    git(join(parent, r), "add", "-A");
  }
  assert.deepEqual(countFiles(parent), { count: 4, capped: false });
  assert.deepEqual(countFiles(parent, 3), { count: 3, capped: true });
});

test("indexQuestion: none for an indexed folder; count + range wording; capped says Over 5,000 and a floor; home always warns", () => {
  const d = folder(4);
  const q = indexQuestion(d);
  assert.ok(q);
  assert.match(plain(q.lines[0]), /has no index yet\. 4 files\.$/);
  assert.match(q.lines[1], /^Rough time: .* without meaning search, .* with it\.$/);
  mkdirSync(join(d, ".litectx"));
  writeFileSync(join(d, ".litectx", "index.db"), "");
  assert.equal(indexQuestion(d), null);
  const capped = (() => {
    const e = folder(12);
    return { r: countFiles(e, 5), e };
  })();
  assert.equal(capped.r.capped, true);
  // the wording for a capped count, built through the real function with a real over-cap folder
  const many = folder(5001);
  const c = indexQuestion(many);
  assert.ok(c?.capped);
  assert.match(plain(c.lines[0]), /Over 5,000 files\.$/);
  assert.match(c.lines[1], /\d+\+ (seconds|minutes|hours) without meaning search, \d+\+ (seconds|minutes|hours) with it\./);
  const home = indexQuestion(process.env.HOME ?? "/nonexistent");
  assert.ok(home === null || /home directory/.test(plain(home.lines[0])));
});

test("confirmFolder: y confirms, q and empty cancel, another folder re-runs the check, an indexed folder is not asked, a non-folder is passed on", async () => {
  const a = folder(1);
  const b = folder(2);
  const idx = folder(1, [".litectx/index.db"]);
  const answers = (/** @type {string[]} */ ...xs) => async () => /** @type {string} */ (xs.shift());
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await confirmFolder(a, answers("y")), a);
    assert.equal(await confirmFolder(a, answers("q")), null);
    assert.equal(await confirmFolder(a, answers("")), null);
    assert.equal(await confirmFolder(a, answers(b, "y")), b, "typed another folder, then confirmed it");
    assert.equal(await confirmFolder(a, answers(idx)), idx, "the new folder already has an index: no second question");
    assert.equal(await confirmFolder(join(tmp, "nope"), answers()), join(tmp, "nope"));
  } finally {
    console.log = log;
  }
});

const hasPython = spawnSync("python3", ["-c", "1"]).status === 0;
/** run the CLI on a pty, answering each prompt in order; returns the terminal text and exit code */
function onPty(/** @type {string[]} */ args, /** @type {string[]} */ typed, /** @type {NodeJS.ProcessEnv} */ env, /** @type {string} */ cwd = process.cwd()) {
  const py = `import pty,os,sys,select,re,time,json
node=${JSON.stringify(process.execPath)}
pid,fd=pty.fork()
if pid==0:
    os.execve(node,[node,${JSON.stringify(BIN)}]+${JSON.stringify(args)},os.environ)
out=b""; typed=${JSON.stringify(typed)}; seen=0; t0=time.time(); code=None
while time.time()-t0<30:
    r,_,_=select.select([fd],[],[],0.1)
    if r:
        try: d=os.read(fd,65536)
        except OSError: break
        if not d: break
        out+=d
        plain=re.sub(rb"\\x1b\\[[0-9;?]*[a-zA-Z]",b"",out)
        n=len(re.findall(rb"(> |folder to index: )",plain))
        if typed and n>seen:
            seen+=1; os.write(fd,typed.pop(0).encode()+b"\\r")
    w,st=os.waitpid(pid,os.WNOHANG)
    if w: code=os.waitstatus_to_exitcode(st); break
while code is None and time.time()-t0<30:
    w,st=os.waitpid(pid,os.WNOHANG)
    if w: code=os.waitstatus_to_exitcode(st)
    else: time.sleep(0.05)
if code is None:
    try: os.kill(pid,9)
    except OSError: pass
    os.waitpid(pid,0)
print(json.dumps({"code":code,"out":out.decode("utf8","replace")}))
`;
  return /** @type {Promise<{ code: number | null, out: string }>} */ (
    new Promise((ok) => {
      const c = spawn("python3", ["-I", "-c", py], { env, cwd, stdio: ["ignore", "pipe", "ignore"] });
      let o = "";
      c.stdout.on("data", (d) => (o += d));
      c.on("close", () => {
        const j = JSON.parse(o.trim().split("\n").pop() ?? "{}");
        ok({ code: j.code, out: plain(j.out ?? "") });
      });
    })
  );
}
const sandboxEnv = () => {
  const home = join(tmp, `h${++n}`);
  mkdirSync(home);
  writeFileSync(join(home, "ui.json"), JSON.stringify({ active: null, sources: [] }));
  return { ...process.env, HOME: home, LITECTX_UI_CONFIG: join(home, "ui.json"), LITECTX_DEFAULT_PORT: String(20000 + Math.floor(Math.random() * 30000)) };
};

test("menu pick 4 on a terminal: starts from the current folder with no folder prompt; another folder re-checks; q cancels with exit 1 and writes nothing", { skip: !hasPython }, async () => {
  const a = folder(3);
  const b = folder(7);
  const r = await onPty([], ["4", b, "q"], sandboxEnv(), a);
  assert.doesNotMatch(r.out, /folder to index:/);
  assert.match(r.out, /none here/);
  assert.match(r.out, new RegExp(`${a} has no index yet\\. 3 files\\.`));
  assert.match(r.out, new RegExp(`${b} has no index yet\\. 7 files\\.`));
  assert.match(r.out, /Rough time: .* without meaning search, .* with it\./);
  assert.match(r.out, /\n {2}y {2}index this folder\r?\n {2}or type another folder\r?\n {2}q {2}cancel/);
  assert.match(r.out, /cancelled/);
  assert.equal(r.code, 1);
  assert.equal(existsSync(join(a, ".litectx")), false);
  assert.equal(existsSync(join(b, ".litectx")), false);
});

test("menu pick 4 from a folder that has an index: asks to update it; q cancels; a 0-file index counts as none (banner and question)", { skip: !hasPython }, async () => {
  const { LiteCtx } = await import("../src/index.js");
  const a = folder(2);
  const lc = new LiteCtx({ root: a });
  await lc.index();
  lc.close?.();
  const r = await onPty([], ["4", "q"], sandboxEnv(), a);
  assert.match(r.out, new RegExp(`${a} is indexed · 2 files\\.`));
  assert.match(r.out, /\n {2}y {2}update the index\r?\n {2}or type another folder\r?\n {2}q {2}cancel/);
  assert.doesNotMatch(r.out, /none here|has no index yet/);
  assert.equal(r.code, 1);
  const z = folder(0);
  const lz = new LiteCtx({ root: z });
  await lz.index();
  lz.close?.();
  assert.ok(existsSync(join(z, ".litectx", "index.db")), "setup: a 0-file db exists");
  const r0 = await onPty([], ["4", "q"], sandboxEnv(), z);
  assert.match(r0.out, /none here/);
  assert.doesNotMatch(r0.out, /· 0 files/);
  assert.match(r0.out, new RegExp(`${z} has no index yet\\. 0 files\\.`));
  assert.doesNotMatch(r0.out, /is indexed/);
});

test("`litectx index` with no folder argument is unchanged: it asks for the folder and never the question", { skip: !hasPython }, async () => {
  const a = folder(0);
  const r = await onPty(["index", "--no-embeddings"], [a], sandboxEnv());
  assert.doesNotMatch(r.out, /has no index yet|Rough time/);
  assert.match(r.out, /indexed 0 files from/);
});

test("openingLine: names the saved active source with its mode, or the folder given; says plainly when there is none; never uses the cwd", async () => {
  const { openingLine } = await import("../src/cli/status.js");
  const git = (/** @type {string} */ dir) => execFileSync("git", ["init", "-q", dir]);
  const parent = join(tmp, `o${++n}`);
  mkdirSync(join(parent, "r1"), { recursive: true });
  mkdirSync(join(parent, "r2"));
  git(join(parent, "r1"));
  git(join(parent, "r2"));
  const cfg = join(tmp, `cfg${n}.json`);
  const prev = process.env.LITECTX_UI_CONFIG;
  process.env.LITECTX_UI_CONFIG = cfg;
  try {
    assert.match(openingLine(), /^no folder saved yet/);
    writeFileSync(cfg, JSON.stringify({ active: "p", sources: [{ name: "p", path: parent }] }));
    assert.equal(openingLine(), `opening ${parent} · all repos (2 found)`);
    assert.equal(openingLine(join(parent, "r1")), `opening ${join(parent, "r1")} · one repo`);
    writeFileSync(cfg, JSON.stringify({ active: "p", sources: [{ name: "p", path: join(tmp, "gone") }] }));
    assert.match(openingLine(), /path does not exist$/);
  } finally {
    if (prev === undefined) delete process.env.LITECTX_UI_CONFIG;
    else process.env.LITECTX_UI_CONFIG = prev;
  }
});
