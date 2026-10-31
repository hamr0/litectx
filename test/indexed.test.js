// `lc.indexed`: has this store had at least one index() pass? Reads only; creates nothing.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const tmp = mkdtempSync(join(tmpdir(), "litectx-indexed-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function root() {
  const d = join(tmp, `r${++n}`);
  mkdirSync(join(d, "src"), { recursive: true });
  writeFileSync(join(d, "src", "a.js"), "export function alpha() { return 1; }\n");
  return d;
}

test("indexed is false on a fresh folder (and reading it creates nothing), true after index()", async () => {
  const r = root();
  const c = new LiteCtx({ root: r });
  assert.equal(c.indexed, false);
  assert.equal(existsSync(join(r, ".litectx")), false, "the read created nothing");
  await c.index();
  assert.equal(c.indexed, true);
  c.close();
  const again = new LiteCtx({ root: r });
  assert.equal(again.indexed, true, "and it survives a reopen");
  again.close();
});

test("written memory alone is not an index; a paths-scoped pass is", async () => {
  const a = new LiteCtx({ root: root() });
  await a.remember("k", "a fact", { kind: "fact" });
  assert.equal(a.indexed, false);
  a.close();
  const b = new LiteCtx({ root: root() });
  await b.index({ paths: ["src"] });
  assert.equal(b.indexed, true, "a scoped pass stamps nothing but leaves file rows");
  b.close();
});

test("an empty folder that was indexed counts as indexed; recall's return is unchanged", async () => {
  const d = join(tmp, `e${++n}`);
  mkdirSync(d);
  const c = new LiteCtx({ root: d });
  assert.deepEqual(await c.recall("x", { kind: "code" }), []);
  assert.equal(c.indexed, false);
  await c.index();
  assert.equal(c.indexed, true);
  assert.deepEqual(await c.recall("x", { kind: "code" }), []);
  c.close();
});
