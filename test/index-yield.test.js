// index({ yield: true }) — cooperative event-loop yielding during a large/force index (LC-3).
//
// `index()` is async but its work (tree-sitter chunking, SQLite upserts) is synchronous CPU, so by
// default it holds the host event loop for the whole pass — a co-hosted timer/socket cannot fire.
// `yield: true` releases the loop between per-file parses via setImmediate. Two properties must hold,
// and both tests are written to FAIL if the yield is removed or if it ever alters the stored index:
//
//   1. MECHANISM (deterministic, not wall-clock): a self-rescheduling setImmediate "heartbeat" is a
//      MACROTASK. On the default path, `await chunkAndImports` only drains microtasks between files
//      (the parse promises are cached/resolved), so the loop never reaches the check phase and the
//      heartbeat is frozen until the whole index resolves. With `yield: true` the explicit
//      setImmediate per file reaches the check phase, so the heartbeat interleaves. This ordering is
//      deterministic in Node — no reliance on timer wall-clock, so it does not flake.
//   2. EQUIVALENCE: yielding changes only WHEN the CPU runs, never WHAT is stored — the index and
//      recall results must be byte-identical to a default pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LiteCtx } from "../src/index.js";

const FILE_COUNT = 12;

// A fixture of many distinct, parseable files — enough per-file parses that the heartbeat gap
// between the two modes is unambiguous. Each file defines a uniquely-named documented function.
function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "litectx-yield-"));
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(
      join(root, "src", `mod${i}.js`),
      `/**\n * Feature number ${i}, documented above the code.\n * @param {number} x\n */\n` +
        `export function feature${i}(x) {\n  const scaled = [x, x + ${i}].map((v) => v * ${i + 1});\n` +
        `  return scaled.filter((v) => v > ${i});\n}\n`
    );
  }
  return root;
}

/** Run one force index alongside a macrotask heartbeat; return how many beats landed DURING it. */
async function beatsDuringIndex(root, useYield) {
  const ctx = new LiteCtx({ root, dbPath: ":memory:" });
  await ctx.index(); // warmup: load tree-sitter grammars once so their (real) async init is not counted
  let beats = 0;
  let running = true;
  const beat = () => {
    if (!running) return;
    beats++;
    setImmediate(beat);
  };
  setImmediate(beat);
  await ctx.index({ force: true, yield: useYield });
  running = false;
  return beats;
}

test("yield:true releases the loop between files; default does not (deterministic macrotask order)", async () => {
  const root = fixtureRepo();
  try {
    const beatsDefault = await beatsDuringIndex(root, false);
    const beatsYield = await beatsDuringIndex(root, true);

    // Default path starves the macrotask queue: the heartbeat cannot run until index resolves.
    assert.ok(beatsDefault <= 1, `default index should freeze the macrotask heartbeat, saw ${beatsDefault} beats`);
    // Yield path lets it interleave — about one beat per file. A generous floor keeps it robust while
    // still collapsing to <=1 (i.e. failing) the moment the per-file yield is removed.
    assert.ok(
      beatsYield >= FILE_COUNT / 2,
      `yield:true should let the heartbeat run during the index, saw ${beatsYield} beats (default ${beatsDefault})`
    );
    assert.ok(beatsYield > beatsDefault + 4, `yield must beat default by a clear margin (${beatsYield} vs ${beatsDefault})`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("yield:true stores a byte-identical index and recall — only WHEN the CPU runs changes", async () => {
  const root = fixtureRepo();
  try {
    const indexAndProbe = async (useYield) => {
      const ctx = new LiteCtx({ root, dbPath: ":memory:" });
      const res = await ctx.index({ force: true, yield: useYield });
      const hits = await ctx.recall("feature scaled filter", { kind: "code" });
      // strip score-free identity of every hit so the comparison is on stored content, not float noise
      const shape = hits.map((h) => `${h.path}|${h.symbol}|${h.startLine}|${h.endLine}`).sort();
      return { res, shape, top: hits.length ? hits.map((h) => h.score) : [] };
    };
    const a = await indexAndProbe(false);
    const b = await indexAndProbe(true);

    assert.deepEqual(b.res, a.res, "index() summary identical");
    assert.deepEqual(b.shape, a.shape, "recall hit set identical");
    assert.deepEqual(b.top, a.top, "recall scores identical");
    assert.equal(a.res.added, FILE_COUNT, "sanity: the fixture actually indexed all files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
