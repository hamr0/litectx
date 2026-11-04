// The page must listen and answer BEFORE the startup index pass begins: a big folder's pass blocks the event
// loop for many seconds before its first yield, and `litectx start` gives up on a page that has not answered
// in 15 s. The child below swaps in an index() that spins synchronously (a stand-in for that block).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "litectx-start-order-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

test("the page answers before the startup index pass starts, even if that pass then blocks", async () => {
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "a.js"), "export const a = 1;\n");
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  const script = join(tmp, "child.mjs");
  writeFileSync(
    script,
    `import { LiteCtx } from ${JSON.stringify(SRC + "index.js")};
import { createUi } from ${JSON.stringify(SRC + "ui/server.js")};
const orig = LiteCtx.prototype.index;
LiteCtx.prototype.index = function (...a) {
  console.log("SPIN_START");
  const t = Date.now(); while (Date.now() - t < 1500) {}
  console.log("SPIN_END");
  return orig.apply(this, a);
};
const ui = await createUi({ port: 0, path: ${JSON.stringify(repo)} });
console.log("URL " + ui.url);
`
  );
  const cfg = join(tmp, "ui.json");
  const child = spawn(process.execPath, [script], { env: { ...process.env, LITECTX_UI_CONFIG: cfg, BROWSER: "true" }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const until = async (/** @type {() => boolean} */ f, ms = 10000) => {
      const t = Date.now();
      while (!f()) {
        if (Date.now() - t > ms) throw new Error("timeout; output so far: " + out);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    await until(() => /URL http/.test(out));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!out.includes("SPIN_START"), "no index pass before the page has answered once");
    const url = /URL (http\S+)/.exec(out)?.[1] ?? "";
    const r = await fetch(`${url}/api/sources`, { signal: AbortSignal.timeout(2000) });
    assert.equal(r.status, 200);
    await until(() => out.includes("SPIN_END"));
  } finally {
    child.kill("SIGTERM");
  }
});
