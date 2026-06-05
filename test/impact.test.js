// Slice 5 integration tests — the impact view (§7). Pins the on-demand blast-radius computation:
// callees (tree-sitter walk), callers (rg -w + tree-sitter confirm) with enclosing symbols, the
// max(confirmed, mentions) over-count-safe risk bucket (aurora thresholds ≤2/3–10/11+), complexity,
// and the §7.2 safety net — "isolated / low-risk" is NEVER a silent verdict.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";
import { riskBucket } from "../src/impact.js";

// A small non-git fixture (indexed via the filesystem-walk fallback). `helper` is called 3× from
// app.js; `caller1/2` are exported leaves; `caller3` is a private leaf; `ghost` is only named in a
// comment (never called).
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "litectx-impact-"));
  writeFileSync(
    join(root, "util.js"),
    [
      "export function helper(x) {",
      "  if (x > 0) {",
      "    return x;",
      "  }",
      "  return -x;",
      "}",
      "export function lonely() {",
      "  return 42;",
      "}",
      "function ghost() {",
      "  return 0;",
      "}",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(root, "app.js"),
    [
      'import { helper } from "./util.js";',
      "",
      "// ghost was an old internal name",
      "export function caller1() {",
      "  return helper(1);",
      "}",
      "export function caller2() {",
      "  return helper(2);",
      "}",
      "function caller3() {",
      "  return helper(3);",
      "}",
      "",
    ].join("\n")
  );
  return root;
}

async function withCtx(fn) {
  const root = fixture();
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  try {
    await fn(ctx);
  } finally {
    ctx.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("riskBucket uses aurora's validated thresholds (≤2 low · 3–10 medium · 11+ high)", () => {
  assert.equal(riskBucket(0), "low");
  assert.equal(riskBucket(2), "low");
  assert.equal(riskBucket(3), "medium");
  assert.equal(riskBucket(10), "medium");
  assert.equal(riskBucket(11), "high");
});

test("callers are confirmed call sites with their enclosing symbol", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("helper");
    assert.ok(r, "helper is in the index");
    assert.equal(r.confirmed, 3, "three confirmed call sites (caller1/2/3)");
    const callerSyms = r.callers.map((c) => c.symbol).sort();
    assert.deepEqual(callerSyms, ["caller1", "caller2", "caller3"], "enclosing caller symbols");
    assert.ok(r.callers.every((c) => c.path === "app.js"), "all calls are in app.js");
  });
});

test("callees are the intra-repo names a symbol calls (externals dropped)", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("caller1");
    assert.ok(r);
    assert.deepEqual(r.callees, ["helper"], "caller1 calls helper; nothing external survives");
  });
});

test("risk is max(confirmed, mentions) — over-count safe (§7.2)", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("helper");
    assert.ok(r);
    // mentions = the import specifier + 3 call sites = 4; confirmed = 3 call sites. The looser
    // floor (mentions) wins and drives the bucket — never the smaller, under-counting number.
    assert.equal(r.mentions, 4, "import line + 3 calls, def line excluded");
    assert.equal(r.refCount, Math.max(r.confirmed, r.mentions), "refCount is the max of the two");
    assert.equal(r.refCount, 4);
    assert.equal(r.risk, "medium", "4 refs → medium");
  });
});

test("complexity counts decision points inside the symbol", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("helper");
    assert.ok(r);
    assert.equal(r.complexity, 2, "base path + one `if` = 2");
  });
});

test("an unconfirmed mention is counted, never dropped (§7.2 unresolved≠absent)", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("ghost");
    assert.ok(r, "ghost is defined (even if only named in a comment elsewhere)");
    assert.equal(r.confirmed, 0, "never actually called");
    assert.equal(r.mentions, 1, "the comment mention is still counted");
    assert.equal(r.refCount, 1, "so it is NOT reported as isolated");
    assert.ok(
      r.hedges.some((h) => /couldn't be confirmed as calls/.test(h)),
      "and the unconfirmed mention is hedged, not silently dropped"
    );
  });
});

test("a truly unreferenced symbol is a hedged review candidate, never a clean isolation (§7.2)", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("caller3"); // private, never called, never mentioned
    assert.ok(r);
    assert.equal(r.refCount, 0, "no references outside its definition");
    assert.equal(r.risk, "low");
    assert.ok(
      r.hedges.some((h) => /NOT a confirmed isolation/.test(h)),
      "low-ref verdict is explicitly hedged"
    );
  });
});

test("an exported unreferenced symbol is hedged for invisible external consumers (§7.2)", async () => {
  await withCtx(async (ctx) => {
    const r = await ctx.impact("lonely"); // exported, never called internally
    assert.ok(r);
    assert.equal(r.refCount, 0);
    assert.ok(
      r.hedges.some((h) => /exported \/ public name/.test(h)),
      "export root → never silently isolated"
    );
  });
});

test("an unknown symbol has no impact to report", async () => {
  await withCtx(async (ctx) => {
    assert.equal(await ctx.impact("doesNotExist"), null);
  });
});
