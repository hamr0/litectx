// The MCP server's warm-on-boot skips the home directory (and only it), and says so on stderr.
// Real server over stdio, temp HOME, temp roots.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../bin/litectx-mcp.js", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "litectx-mcphome-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function dir() {
  const d = join(tmp, `d${++n}`);
  mkdirSync(d);
  writeFileSync(join(d, "a.js"), "export function alpha() { return 1; }\n");
  return d;
}
const until = async (/** @type {() => boolean} */ f, ms = 8000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50));
  return f();
};

/**
 * Start the server with `home` as HOME and `root` as its folder (cwd, or --root when `flag`).
 * @param {{ home: string, root: string, flag?: boolean }} o @param {import("node:test").TestContext} t
 */
function server(o, t) {
  const args = [SERVER, "--no-embeddings", ...(o.flag ? ["--root", o.root] : [])];
  const proc = spawn(process.execPath, args, { cwd: o.root, env: { ...process.env, HOME: o.home }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => proc.kill());
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  /** @type {Map<number, (m: any) => void>} */
  const pending = new Map();
  createInterface({ input: proc.stdout }).on("line", (l) => {
    const m = JSON.parse(l);
    pending.get(m.id)?.(m);
  });
  let id = 0;
  const request = (/** @type {string} */ method, /** @type {any} */ params) =>
    new Promise((ok) => {
      pending.set(++id, ok);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return {
    stderr: () => err,
    request,
    async init() {
      await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    /** @param {string} name @param {any} args */
    call: (name, args) => /** @type {Promise<any>} */ (request("tools/call", { name, arguments: args })),
  };
}

test("rooted at the home directory: no index pass on start, one stderr line saying why, nothing created; recall still answers", async (t) => {
  const home = dir();
  const s = server({ home, root: home }, t);
  await s.init();
  const r = await s.call("recall", { query: "alpha", kind: "code" });
  assert.equal(r.result.isError, false);
  assert.ok(await until(() => /not indexing .* home directory/.test(s.stderr())), s.stderr());
  await new Promise((ok) => setTimeout(ok, 1500)); // a warm pass would have created the file by now (a one-file repo takes ~ms)
  assert.equal(existsSync(join(home, ".litectx")), false, "no index pass, no file");
});

test("rooted at a symlink to the home directory: compared by real path, so it is skipped too", async (t) => {
  const home = dir();
  const link = join(tmp, `link${++n}`);
  symlinkSync(home, link);
  const s = server({ home, root: link, flag: true }, t);
  await s.init();
  assert.ok(await until(() => /not indexing/.test(s.stderr())), s.stderr());
  await new Promise((ok) => setTimeout(ok, 1000));
  assert.equal(existsSync(join(home, ".litectx")), false);
});

test("any other root warms exactly as before (the index file appears) and prints no skip line", async (t) => {
  const home = dir();
  const root = dir();
  const s = server({ home, root }, t);
  await s.init();
  assert.ok(await until(() => existsSync(join(root, ".litectx", "index.db"))), "the warm pass ran");
  assert.doesNotMatch(s.stderr(), /not indexing/);
});
