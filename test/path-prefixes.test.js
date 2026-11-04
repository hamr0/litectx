// recall({ pathPrefixes }) — the folder fence is applied inside the candidate query, BEFORE the cut.
// Regression: the ui filtered to one repo AFTER recall's cut, so a repo whose hits ranked past the cut
// (many other repos matching the same word) came back empty.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import { search } from "../src/ui/search.js";

const tmp = mkdtempSync(join(tmpdir(), "litectx-pp-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
/** @type {LiteCtx} */
let ctx;

/** @param {string} rel @param {string} body */
function put(rel, body) {
  const f = join(tmp, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, body);
}

before(async () => {
  // 230 decoy folders whose docs/code say "readme" densely → they all outrank the wanted folders' single mention
  for (let i = 0; i < 230; i++) {
    put(`decoy${i}/README.md`, `# decoy${i}\n\nreadme readme readme readme. This readme explains the readme.\n`);
    put(`decoy${i}/lib.js`, `// readme readme readme\nexport function readme${i}() { return "readme readme"; }\n`);
  }
  put("rwxlite/README.md", "# rwxlite\n\n" + "filler words here. ".repeat(40) + "\nsee the readme once.\n");
  put("rwxlite/lib.js", "export function load() {\n  return 'readme';\n}\n");
  put("rwx/README.md", "# rwx\n\nreadme for the short-named repo.\n");
  put("a_b/README.md", "# a_b\n\nreadme underscore repo.\n");
  put("aXb/README.md", "# aXb\n\nreadme wildcard-lookalike repo.\n");
  ctx = new LiteCtx({ root: tmp, dbPath: ":memory:" });
  await ctx.index();
});

const firstSeg = (/** @type {{ path: string }[]} */ hs) => [...new Set(hs.map((h) => h.path.split("/")[0]))];

test("pathPrefixes ranks the wanted folder among itself, past where an unfenced cut drops it", async () => {
  const unfenced = await ctx.recall("readme", { kind: "doc", n: 200 });
  assert.ok(!firstSeg(unfenced).includes("rwxlite"), "premise: rwxlite is past the n=200 cut without the fence");
  const hits = await ctx.recall("readme", { kind: "doc", n: 5, pathPrefixes: ["rwxlite"] });
  assert.ok(hits.length > 0);
  assert.deepEqual(firstSeg(hits), ["rwxlite"]);
  const code = await ctx.recall("readme", { kind: "code", n: 5, pathPrefixes: ["rwxlite"] });
  assert.deepEqual(code.map((h) => h.path), ["rwxlite/lib.js"]);
});

test("ui search(): filtering to one repo keeps its hits (doc, code, and both kinds)", async () => {
  for (const kinds of [["doc"], ["code"], ["doc", "code"]]) {
    const r = await search(ctx, tmp, "repos", "root", "readme", { repos: ["rwxlite"], kinds });
    assert.ok(r.rows.length > 0, `kinds=${kinds}: rows`);
    assert.ok(r.rows.every((x) => x.repo === "rwxlite"));
  }
});

test("prefix matches whole segments only, and % _ are literal", async () => {
  assert.deepEqual(firstSeg(await ctx.recall("readme", { kind: "doc", n: 50, pathPrefixes: ["rwx"] })), ["rwx"]);
  assert.deepEqual(firstSeg(await ctx.recall("readme", { kind: "doc", n: 50, pathPrefixes: ["a_b"] })), ["a_b"]);
  assert.deepEqual(await ctx.recall("readme", { kind: "doc", n: 50, pathPrefixes: ["a%"] }), []);
  assert.deepEqual(firstSeg(await ctx.recall("readme", { kind: "doc", n: 50, pathPrefixes: ["rwx", "a_b"] })).sort(), ["a_b", "rwx"]);
});

test("trailing slash is stripped; empty / blank / unset = no fence (identical to unset)", async () => {
  const a = await ctx.recall("readme", { kind: "doc", n: 5, pathPrefixes: ["rwx/"] });
  assert.deepEqual(firstSeg(a), ["rwx"]);
  const base = await ctx.recall("readme", { kind: "code", n: 20, log: false });
  for (const pp of [[], [""], ["/"], undefined]) {
    assert.deepEqual(await ctx.recall("readme", { kind: "code", n: 20, log: false, pathPrefixes: pp }), base);
  }
});

test("fact/episode ignore pathPrefixes", async () => {
  await ctx.remember("f1", "readme fact about deployment", { kind: "fact" });
  const hits = await ctx.recall("readme", { kind: "fact", pathPrefixes: ["rwxlite"] });
  assert.deepEqual(hits.map((h) => h.path), ["f1"]);
});
