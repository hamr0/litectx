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
import { riskBucket, rgSpawnFailed, RipgrepMissingError } from "../src/impact.js";

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

test("a bare `@decorator` is a CONFIRMED caller, not just a mention", async () => {
  const root = mkdtempSync(join(tmpdir(), "litectx-deco-"));
  // handle_errors is only ever applied as `@handle_errors` (no parens) — not a `call` node. Without
  // decorator handling it would show 0 confirmed callers (mention-floor safe but list-incomplete).
  writeFileSync(
    join(root, "deco.py"),
    [
      "def handle_errors(f):",
      "    return f",
      "",
      "@handle_errors",
      "def my_command():",
      "    return 1",
      "",
      "@handle_errors",
      "def other_command():",
      "    return 2",
      "",
    ].join("\n")
  );
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index();
  const r = await ctx.impact("handle_errors");
  ctx.close();
  rmSync(root, { recursive: true, force: true });
  assert.ok(r);
  assert.equal(r.confirmed, 2, "both @handle_errors decorations are confirmed call sites");
  assert.ok(r.callers.some((c) => c.path === "deco.py"), "the decorating file is a caller");
  assert.equal(r.risk, "low", "2 refs → low, but never isolated");
});

// ---- LC-5: a missing `rg` must NOT read as "0 callers, risk low" (§7.2 false isolation) ----

// Run `fn` with `rg` unreachable: PATH points at an empty dir, so `execFileSync("rg", …)` → ENOENT.
// Restores PATH unconditionally. (index() ran already in withCtx and needs no rg; only impact does.)
async function withoutRg(fn) {
  const empty = mkdtempSync(join(tmpdir(), "litectx-norg-"));
  const savedPath = process.env.PATH;
  process.env.PATH = empty;
  try {
    await fn();
  } finally {
    process.env.PATH = savedPath;
    rmSync(empty, { recursive: true, force: true });
  }
}

test("impact() REFUSES loudly when rg is absent — never a silent false isolation (LC-5, §7.2)", async () => {
  await withCtx(async (ctx) => {
    // `helper` has 3 real callers. With rg gone the sweep can find nothing; the dangerous outcome is
    // to return that as refCount 0 / risk low (indistinguishable from genuine isolation). It must
    // throw instead — a machine-distinguishable signal (`.code`) the readout's consumer can catch.
    await withoutRg(async () => {
      await assert.rejects(
        () => ctx.impact("helper"),
        (/** @type {any} */ e) =>
          e instanceof RipgrepMissingError &&
          e.code === "RIPGREP_MISSING" &&
          /ripgrep|\brg\b/.test(e.message),
        "a symbol with real callers must not read as isolated just because rg is missing"
      );
    });
  });
});

test("with rg present, genuine 'no matches' stays a valid empty — no new failure mode (LC-5 crit 2)", async () => {
  await withCtx(async (ctx) => {
    // `lonely` is genuinely unreferenced. rg runs and exits 1 (no matches) — that path must remain
    // byte-identical to today: a returned, hedged, low-risk verdict, NOT a throw.
    const r = await ctx.impact("lonely");
    assert.ok(r, "isolated symbol still returns (rg ran, found nothing)");
    assert.equal(r.refCount, 0);
    assert.equal(r.risk, "low");
    assert.ok(r.hedges.some((h) => /review candidate|external consumers/.test(h)), "still hedged, not a throw");
  });
});

test("rgSpawnFailed fires ONLY when rg never ran — not exit 1, a crash, or an output overflow (LC-5 crit 4)", () => {
  // The gate the throw hangs on. A genuine spawn failure carries a `spawnSync` syscall and no exit
  // signal (the process was never created); rg RUNNING then exiting/crashing/overflowing does not.
  // Both impact sweeps route through this one predicate, so the two call sites can't diverge. Error
  // shapes are the real ones execFileSync produces (verified 2026-07-31), not invented.
  assert.equal(rgSpawnFailed({ syscall: "spawnSync rg", code: "ENOENT", signal: null }), true, "missing binary → never ran");
  assert.equal(rgSpawnFailed({ syscall: "spawnSync rg", code: "EACCES", signal: null }), true, "not executable → never ran");
  assert.equal(rgSpawnFailed({ syscall: "spawnSync rg", code: "ENOTDIR", signal: null }), true, "broken PATH component → never ran (an errno whitelist would miss this)");
  assert.equal(rgSpawnFailed({ status: 1 }), false, "exit 1 (no matches) → ran, a valid empty");
  assert.equal(rgSpawnFailed({ status: 2, stdout: "partial" }), false, "crash with stdout → salvage, not a throw");
  assert.equal(rgSpawnFailed({ syscall: "spawnSync sh", code: "ENOBUFS", signal: "SIGTERM", stdout: "huge" }), false, "output overflow → rg RAN; salvage the (large) count, never a false 'rg missing'");
  assert.equal(rgSpawnFailed({ signal: "SIGKILL" }), false, "ran then killed by signal → not a spawn failure");
  assert.equal(rgSpawnFailed(undefined), false, "no error object → not a spawn failure");
});
